// compileUserContext — the ONE general pipeline that turns whatever the user
// tells NormOS into durable structured meaning (ContextAssertions +
// ContextRelations). Every input path (Chief Brief question answers, manual
// briefing context, corrections/retractions today; Ask/voice/check-ins as
// they're migrated — see the rollout notes in routes/annotations.js) calls
// THIS function instead of independently reinterpreting raw text.
//
// Pipeline (see the design brief this implements):
//   1. Extract structured assertions with Anthropic Structured Outputs
//      (compileUserContextAttempt below — same mechanism as
//      services/briefing-ai.js's chief-brief call: output_config.format +
//      adaptive thinking, refusal/max_tokens/network/parse/shape failure
//      branching, one retry).
//   2. Apply DETERMINISTIC temporal/negation/correction/identity validation
//      (resolveTemporalWindow, reconcileEventStatus, dedupeAssertions,
//      findSupersededAssertion) — these are the rules that VALIDATE and
//      CONSTRAIN the LLM's interpretation, never a replacement for it: the
//      LLM decides WHAT was said; regex-based checks only catch it being
//      unambiguously wrong (a flat "didn't ___" the model somehow didn't
//      mark negated) and resolve WHEN/WHETHER it corrects something earlier,
//      which needs deterministic matching against real stored assertions,
//      not model guesswork.
//   3. Resolve authority: every assertion compiled from the user's own text
//      is sourceAuthority:'user' (they're authoritative about their own
//      intentions/preferences/completions/calendar-meaning by definition —
//      see the design brief's AUTHORITY POLICY). The authority question that
//      actually varies is on the RELATION side (deriveRelations below): a
//      relation to a MEASURED METRIC may only cite established_knowledge /
//      personal_experiment / personal_observation / canonical_fact as its
//      evidence_basis — never user_explicit alone, no matter how confidently
//      the user states a cause — while a relation to something the user
//      genuinely controls (a calendar block's meaning, whether they
//      completed something, a decision, a preference) may be user_explicit
//      and fully authoritative.
//   4/5/6. Persistence, invalidation, and immediate availability are the
//      CALLER's job (see persistCompiledContext + routes/annotations.js) —
//      this module never touches the DB for writes, only for the read used
//      to find what a correction supersedes.
'use strict';

const llm = require('../llm');
const { AnthropicRefusalError, AnthropicMaxTokensError } = llm;
const { classifyEventKind, EVENT_KIND, significantWords, overlapScore } = require('./context-semantics');
const { knowledgeRelationsForConcept, EVIDENCE_TIER, KNOWLEDGE_REGISTRY_VERSION } = require('./knowledge-registry');

const COMPILER_VERSION = '1.0.0';

const ASSERTION_TYPES = [
  'event', 'state', 'preference', 'constraint', 'plan', 'decision',
  'correction', 'explanation', 'classification', 'completion',
];
const EVENT_STATUSES = ['occurred', 'planned', 'ongoing', 'completed', 'negated', 'retracted', 'superseded'];
const TEMPORAL_REFS = ['last_night', 'today', 'yesterday', 'this_morning', 'ongoing', 'future', 'unspecified', 'explicit_date'];
const DOMAINS = ['health', 'wellbeing', 'calendar', 'wealth', 'habits', 'goals', 'commitments', 'workouts', 'other'];

// ── Structured Outputs schema ───────────────────────────────────────────────
// Same convention as briefing-ai.js's CHIEF_JSON_SCHEMA: additionalProperties
// false on every object node, every property listed in `required` (empty
// string / empty array is how an Anthropic Structured Outputs schema
// expresses "not applicable" for a required field — see explicitDate/
// correctsPriorText below).
const COMPILE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    assertions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          assertionType: { type: 'string', enum: ASSERTION_TYPES },
          subject: { type: 'string' },
          predicate: { type: 'string' },
          objectValue: { type: 'string' },
          concepts: { type: 'array', items: { type: 'string' } },
          domains: { type: 'array', items: { type: 'string', enum: DOMAINS } },
          eventStatus: { type: 'string', enum: EVENT_STATUSES },
          temporalRef: { type: 'string', enum: TEMPORAL_REFS },
          explicitDate: { type: 'string' }, // 'YYYY-MM-DD' or '' when temporalRef !== 'explicit_date'
          correctsPriorText: { type: 'string' }, // best-effort quote/paraphrase of what this corrects, else ''
          confidence: { type: 'number' },
        },
        required: [
          'assertionType', 'subject', 'predicate', 'objectValue', 'concepts', 'domains',
          'eventStatus', 'temporalRef', 'explicitDate', 'correctsPriorText', 'confidence',
        ],
      },
    },
  },
  required: ['assertions'],
};

const COMPILER_MODEL = process.env.ANTHROPIC_CONTEXT_COMPILER_MODEL || undefined; // undefined -> provider's own default (Sonnet 5)
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const COMPILER_EFFORT = process.env.ANTHROPIC_CONTEXT_COMPILER_EFFORT || 'low';
if (!VALID_EFFORTS.has(COMPILER_EFFORT)) {
  throw new Error(`Invalid ANTHROPIC_CONTEXT_COMPILER_EFFORT "${COMPILER_EFFORT}" — must be one of: ${[...VALID_EFFORTS].join(', ')}.`);
}
const COMPILER_MAX_TOKENS = 4096;

const CAUSE_CONCEPT_VOCAB = ['alcohol', 'illness', 'travel', 'room_conditions', 'late_meal', 'medication', 'stress', 'hard_training'];

const COMPILE_SYSTEM = `You are NormOS's context compiler. Extract structured meaning from ONE short piece of text the user just told the app — a question answer, a manual note, a correction. Do not narrate, do not add commentary — return ONLY the structured assertions.

Emit ONE assertion per distinct fact/decision/constraint/correction the text contains (usually 1, occasionally 2 for a compound statement like "I skipped the workout because I was exhausted" — one assertion for the decision/event, one for the constraint/reason). Use a CONSISTENT subject across assertions from the same text so they can be linked (e.g. both name "the workout" or "the valuation conversation").

Fields:
- assertionType: event (something happened), state (an ongoing condition), preference (a durable "I prefer/don't want" statement), constraint (something that limited a choice, e.g. "because I was exhausted"), plan (a stated future intention), decision (a choice the user made, e.g. "I skipped X"), correction (fixing something said earlier — a wrong day/detail), explanation (why a metric or outcome happened, distinct from a decision's own reason), classification (relabeling what something IS — a calendar block's true meaning), completion (whether something specific was finished).
- subject/predicate/objectValue: a simple subject-verb-object decomposition of the statement, e.g. subject="user", predicate="drank alcohol", objectValue="wine" — or for a correction, subject="the calendar block from 5-9pm", predicate="is", objectValue="a Sabbath observance, not meetings".
- concepts: canonical lowercase tags. For a health-domain cause, PREFER these exact tags when they apply: ${CAUSE_CONCEPT_VOCAB.join(', ')}. For anything else (a preference's action type, a calendar classification, a novel concept these tags don't cover), use your own short lowercase tag(s) — never force-fit an unrelated tag.
- domains: which of ${DOMAINS.join(', ')} this affects — usually one, sometimes two.
- eventStatus: occurred|planned|ongoing|completed|negated|retracted|superseded. NEGATED means the text explicitly says something did NOT happen ("I didn't drink") — this is different from simply not mentioning it. RETRACTED means the user is asking to disregard/forget something they said earlier ("forget what I said about...", "ignore that", "scratch that").
- temporalRef: when this happened/applies, from the user's own wording — last_night | today | yesterday | this_morning | ongoing | future | unspecified | explicit_date (only when the user names a specific day, e.g. "Thursday" — put that day's date, if inferable from context, in explicitDate as YYYY-MM-DD, else leave explicitDate empty and use temporalRef "unspecified").
- correctsPriorText: if this statement corrects, retracts, or supersedes something the user likely said before (a temporal correction, a classification change, a completion correction, an explicit retraction), give your best short paraphrase of what it corrects so the caller can match it against recent history. Empty string if this is not a correction of anything.
- confidence: your own 0-1 confidence in this extraction.

Be conservative: only extract what the text actually supports. Never invent a cause, a completion state, or a preference the text doesn't state. A plain observational note with no clear structure still gets ONE assertion (assertionType "state", predicate/objectValue capturing it plainly) — never return zero assertions for non-empty text.`;

function buildCompilePrompt({ rawText, question = null, tz, now }) {
  const localDate = now.toLocaleDateString('en-CA', { timeZone: tz });
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
  return `Today is ${weekday}, ${localDate} (timezone ${tz}).
${question ? `The question being answered was: "${question}"\n` : ''}Text to compile:
"${rawText}"`;
}

/** One LLM call + parse + shape check — mirrors briefing-ai.js's
 *  chiefBriefAttempt exactly (same failureType vocabulary: null | 'refusal' |
 *  'max_tokens' | 'network' | 'parse' | 'shape'), so callers can reuse the
 *  same mental model for retry/fallback decisions. */
async function compileAttempt(prompt, attemptLabel, { maxTokens = COMPILER_MAX_TOKENS, correlationId } = {}) {
  let text;
  try {
    ({ text } = await llm.generateText({
      system: COMPILE_SYSTEM, prompt, maxTokens, model: COMPILER_MODEL,
      outputSchema: COMPILE_JSON_SCHEMA, effort: COMPILER_EFFORT,
      provider: 'anthropic', returnMeta: true,
    }));
  } catch (err) {
    if (err instanceof AnthropicRefusalError) {
      console.error(`[context-compiler] refused (${attemptLabel}) [correlationId=${correlationId}] category=${err.category || 'unspecified'}`);
      return { result: null, failureType: 'refusal' };
    }
    if (err instanceof AnthropicMaxTokensError) {
      console.error(`[context-compiler] truncated at max_tokens (${attemptLabel}) [correlationId=${correlationId}]`);
      return { result: null, failureType: 'max_tokens' };
    }
    console.error(`[context-compiler] generation failed (${attemptLabel}) [correlationId=${correlationId}]:`, err.message);
    return { result: null, failureType: 'network' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(`[context-compiler] response not valid JSON (${attemptLabel}) [correlationId=${correlationId}]: ${err.message}`);
    return { result: null, failureType: 'parse' };
  }

  if (!Array.isArray(parsed.assertions)) {
    console.error(`[context-compiler] shape invalid (${attemptLabel}) [correlationId=${correlationId}]: assertions not an array`);
    return { result: null, failureType: 'shape' };
  }
  return { result: parsed.assertions, failureType: null };
}

// ── Deterministic validation/enrichment (pure, unit-testable) ──────────────

/** Reuses analyze.js's resolveNightWindow for night-anchored health refs (the
 *  SAME canonical "last night" definition every other night-binding surface
 *  uses — see intelligence/recovery-drivers.js, routes/annotations.js), and
 *  simple local-day boundaries for everything else. Never throws — an
 *  unresolvable temporal ref just leaves both bounds null (an assertion with
 *  no effective window is still valid; it just can't anchor a driver's
 *  temporal-alignment score, see context-resolver.js). */
function resolveTemporalWindow({ temporalRef, explicitDate, domains = [] }, { tz, now, wakeTimeSeries = [] }) {
  const { localDayBoundsUtc } = require('../util/date');
  const isHealthLike = domains.includes('health') || domains.includes('wellbeing');

  if ((temporalRef === 'last_night' || temporalRef === 'this_morning') && isHealthLike) {
    const { resolveNightWindow } = require('./analyze');
    const todayKey = now.toLocaleDateString('en-CA', { timeZone: tz });
    const w = resolveNightWindow(todayKey, wakeTimeSeries, tz);
    return { effectiveStart: w.start, effectiveEnd: w.end };
  }
  if (temporalRef === 'yesterday') {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const { start, end } = localDayBoundsUtc(tz, yesterday);
    return { effectiveStart: start, effectiveEnd: end };
  }
  if (temporalRef === 'today' || temporalRef === 'ongoing') {
    const { start } = localDayBoundsUtc(tz, now);
    return { effectiveStart: start, effectiveEnd: now };
  }
  if (temporalRef === 'explicit_date' && explicitDate) {
    const d = new Date(`${explicitDate}T12:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      const { start, end } = localDayBoundsUtc(tz, d);
      return { effectiveStart: start, effectiveEnd: end };
    }
  }
  if (temporalRef === 'future') {
    return { effectiveStart: now, effectiveEnd: null };
  }
  return { effectiveStart: null, effectiveEnd: null };
}

/** Deterministic safety net (constrain, don't replace): if the raw text
 *  unambiguously reads as a retraction or a plain negation per
 *  context-semantics.js's classifier but the LLM's eventStatus disagrees,
 *  the regex wins — this is exactly the class of thing a closed, reviewed
 *  pattern set is good at (catching an unambiguous case the model missed),
 *  not a replacement for the model's broader interpretation. */
function reconcileEventStatus(rawAssertion, rawText) {
  const kind = classifyEventKind(rawText);
  const out = { ...rawAssertion };
  if (kind === EVENT_KIND.RETRACTION && out.eventStatus !== 'retracted') {
    out.eventStatus = 'retracted';
    out.assertionType = 'correction';
  } else if (kind === EVENT_KIND.NEGATED && out.eventStatus !== 'negated' && out.eventStatus !== 'retracted') {
    out.eventStatus = 'negated';
  }
  return out;
}

/** Drop exact duplicates within one compile batch (same subject/predicate/
 *  objectValue and same calendar day of effectiveStart). */
function dedupeAssertions(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const dayKey = a.effectiveStart ? new Date(a.effectiveStart).toISOString().slice(0, 10) : 'none';
    const key = `${(a.subject || '').toLowerCase()}|${(a.predicate || '').toLowerCase()}|${(a.objectValue || '').toLowerCase()}|${dayKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

const SUPERSEDE_MATCH_THRESHOLD = 0.34;
const SUPERSEDE_MATCH_MARGIN = 0.15;

/** Pure: given a candidate assertion that plausibly corrects something
 *  (non-empty correctsPriorText, or assertionType correction/classification/
 *  completion, or eventStatus retracted/negated), find the ONE prior ACTIVE
 *  assertion (already time/domain-scoped by the caller) it's most plausibly
 *  superseding — same conservative word-overlap matching as
 *  context-semantics.js's findRetractionTarget (never guesses when two
 *  candidates score closely). Returns null when nothing qualifies or the
 *  match is ambiguous — an unrelated assertion is never silently retired. */
function findSupersededAssertion(candidate, recentActiveAssertions) {
  const wantsToCorrect = Boolean(candidate.correctsPriorText)
    || ['correction', 'classification', 'completion'].includes(candidate.assertionType)
    || ['retracted', 'negated'].includes(candidate.eventStatus);
  if (!wantsToCorrect) return null;
  const probe = candidate.correctsPriorText
    || `${candidate.subject || ''} ${candidate.predicate || ''} ${candidate.objectValue || ''}`;
  if (!significantWords(probe).length) return null;

  const scored = (recentActiveAssertions || [])
    .map((c) => ({ c, score: overlapScore(probe, `${c.subject || ''} ${c.predicate || ''} ${c.objectValue || ''} ${c.rawText || ''}`) }))
    .filter((s) => s.score >= SUPERSEDE_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length === 1) return scored[0].c;
  if (scored[0].score - scored[1].score >= SUPERSEDE_MATCH_MARGIN) return scored[0].c;
  return null;
}

function normalizeTargetId(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'unspecified';
}

/** Blend a registry entry's population-level evidence with this assertion's
 *  own extraction confidence — established knowledge caps how confident a
 *  single mention can ever make a relation (a hedge model_hypothesis entry
 *  can never look as confident as an established one just because the user
 *  stated it plainly). */
function blendConfidence(assertionConfidence, entry) {
  const base = entry.evidenceTier === EVIDENCE_TIER.ESTABLISHED ? 0.75 : 0.3;
  const a = Number.isFinite(assertionConfidence) ? Math.max(0, Math.min(1, assertionConfidence)) : 0.6;
  return Math.round(Math.min(base, base * 0.6 + a * 0.4) * 100) / 100;
}

/**
 * Pure: derive zero or more ContextRelation candidates for one validated,
 * temporally-resolved assertion. See the AUTHORITY POLICY notes at the top
 * of this file — this is the ONE dispatch point that decides evidence_basis,
 * never a per-domain special case.
 */
function deriveRelations(assertion, { supersedesAssertionId = null } = {}) {
  const relations = [];
  const domains = assertion.domains || [];
  const concepts = assertion.concepts || [];
  const conf = Number.isFinite(assertion.confidence) ? assertion.confidence : 0.6;

  if (supersedesAssertionId) {
    const relationship = assertion.eventStatus === 'retracted' ? 'invalidates'
      : assertion.assertionType === 'classification' ? 'classifies'
        : assertion.assertionType === 'completion' ? 'completes'
          : 'supersedes';
    relations.push({
      targetType: 'assertion', targetId: supersedesAssertionId, relationship,
      evidenceBasis: 'user_explicit', confidence: conf, strength: 1,
      permittedLanguage: null, unresolved: false,
    });
  }

  if (assertion.assertionType === 'classification' && domains.includes('calendar')) {
    relations.push({
      targetType: 'calendar_event', targetId: normalizeTargetId(assertion.subject || assertion.objectValue),
      relationship: 'classifies', evidenceBasis: 'user_explicit', confidence: conf, strength: 1,
      windowStart: assertion.effectiveStart, windowEnd: assertion.effectiveEnd,
      permittedLanguage: assertion.objectValue || null,
    });
  }

  const completionDomain = domains.includes('workouts') ? 'workout' : domains.includes('commitments') ? 'commitment' : domains.includes('goals') ? 'goal' : null;
  if (completionDomain && (assertion.assertionType === 'completion'
    || (assertion.eventStatus === 'negated' && ['completion', 'decision', 'event'].includes(assertion.assertionType)))) {
    relations.push({
      targetType: completionDomain, targetId: normalizeTargetId(assertion.subject || assertion.objectValue),
      relationship: 'completes', evidenceBasis: 'user_explicit', confidence: conf, strength: 1,
      permittedLanguage: assertion.eventStatus === 'completed' ? 'completed' : 'not completed',
    });
  }

  if (completionDomain && ['constraint', 'decision'].includes(assertion.assertionType)) {
    relations.push({
      targetType: completionDomain, targetId: normalizeTargetId(assertion.subject || assertion.objectValue),
      relationship: 'constrains', evidenceBasis: 'user_explicit', confidence: conf, strength: 0.7,
      windowStart: assertion.effectiveStart, windowEnd: assertion.effectiveEnd,
      permittedLanguage: assertion.rawText || null,
    });
  }

  if (completionDomain && assertion.assertionType === 'explanation') {
    relations.push({
      targetType: completionDomain, targetId: normalizeTargetId(assertion.subject || assertion.objectValue),
      relationship: 'constrains', evidenceBasis: 'user_explicit', confidence: Math.min(conf, 0.8), strength: 0.6,
      permittedLanguage: assertion.rawText || null,
    });
  }

  if (assertion.assertionType === 'preference') {
    relations.push({
      targetType: 'action_type', targetId: normalizeTargetId(assertion.objectValue || assertion.predicate),
      relationship: 'changes_priority', evidenceBasis: 'user_explicit', confidence: conf, strength: 0.8,
      permittedLanguage: assertion.rawText || null,
    });
  }

  // Metric relations: the ONLY path that may target a measured metric — see
  // AUTHORITY POLICY. A concept match against the knowledge registry decides
  // evidence_basis, never the assertion's own sourceAuthority (which is
  // always 'user' — the user being authoritative about WHAT happened does
  // not make them authoritative about its PHYSIOLOGICAL EFFECT).
  const isMetricEligible = ['event', 'state', 'explanation'].includes(assertion.assertionType)
    && ['occurred', 'ongoing'].includes(assertion.eventStatus)
    && domains.includes('health');
  if (isMetricEligible) {
    let matchedAny = false;
    for (const concept of concepts) {
      for (const entry of knowledgeRelationsForConcept(concept)) {
        matchedAny = true;
        const expiresAt = assertion.effectiveEnd && Number.isFinite(entry.effectWindowHours)
          ? new Date(new Date(assertion.effectiveEnd).getTime() + entry.effectWindowHours * 3600 * 1000).toISOString()
          : null;
        relations.push({
          targetType: 'metric', targetId: entry.targetConcept,
          relationship: entry.evidenceTier === EVIDENCE_TIER.ESTABLISHED ? 'contributes_to' : 'supports',
          direction: entry.expectedDirection,
          evidenceBasis: entry.evidenceTier === EVIDENCE_TIER.ESTABLISHED ? 'established_knowledge' : 'model_hypothesis',
          confidence: blendConfidence(conf, entry),
          strength: entry.evidenceTier === EVIDENCE_TIER.ESTABLISHED ? 0.7 : 0.3,
          windowStart: assertion.effectiveStart, windowEnd: assertion.effectiveEnd, expiresAt,
          permittedLanguage: entry.allowedLanguage?.[0] ?? null,
        });
      }
    }
    // Unknown concept (scenario 9), but ONLY when the user was explicitly
    // trying to explain something ('explanation') — a plain 'event'/'state'
    // health note with no recognized concept just remains context with no
    // relation asserted (nothing to hypothesize about), rather than
    // manufacturing a driver candidate for every unrelated health mention.
    if (!matchedAny && assertion.assertionType === 'explanation') {
      relations.push({
        targetType: 'metric', targetId: 'health:recovery_autonomic',
        relationship: 'supports', direction: 'unknown', evidenceBasis: 'model_hypothesis',
        confidence: Math.min(0.3, conf), strength: 0.2,
        windowStart: assertion.effectiveStart, windowEnd: assertion.effectiveEnd,
        permittedLanguage: 'may be worth watching',
      });
    }
  }

  return relations;
}

/**
 * The main entrypoint. LLM extraction + deterministic validation, given a
 * list of RECENT ACTIVE assertions (already fetched by the caller — see
 * store/contextAssertions.js's getActive) to match corrections against.
 * Never throws: any failure (LLM or shape) degrades to `{assertions: [],
 * relations: [], failed: true, failureType}` so a compiler failure can
 * never block the underlying annotation write (see routes/annotations.js).
 */
async function compileUserContext({ rawText, source, question = null, tz = process.env.TZ || 'America/New_York', now = new Date(), recentActiveAssertions = [], wakeTimeSeries = [] }) {
  const text = String(rawText || '').trim();
  if (!text) return { assertions: [], relations: [], failed: false, failureType: null };

  const prompt = buildCompilePrompt({ rawText: text, question, tz, now });
  const correlationId = require('crypto').randomUUID();

  let { result, failureType } = await compileAttempt(prompt, 'attempt 1/2', { correlationId });
  if (!result && failureType !== 'refusal') {
    ({ result, failureType } = await compileAttempt(prompt, 'attempt 2/2 (retry)', { correlationId }));
  }
  if (!result) {
    return { assertions: [], relations: [], failed: true, failureType };
  }

  const compiledAssertions = [];
  const compiledRelations = [];
  // Recent assertions extended with any produced earlier in THIS batch, so a
  // compound statement's second assertion can supersede its first.
  const candidatePool = [...recentActiveAssertions];

  for (const raw of dedupeAssertions(result)) {
    if (!ASSERTION_TYPES.includes(raw.assertionType) || !EVENT_STATUSES.includes(raw.eventStatus)) continue;
    const reconciled = reconcileEventStatus(raw, text);
    const { effectiveStart, effectiveEnd } = resolveTemporalWindow(reconciled, { tz, now, wakeTimeSeries });
    const confidence = Number.isFinite(reconciled.confidence) ? Math.max(0, Math.min(1, reconciled.confidence)) : 0.6;

    const superseded = findSupersededAssertion(reconciled, candidatePool);

    const assertion = {
      source, rawText: text, assertionType: reconciled.assertionType,
      subject: reconciled.subject || null, predicate: reconciled.predicate || null,
      objectValue: reconciled.objectValue || null,
      entities: [], concepts: Array.isArray(reconciled.concepts) ? reconciled.concepts.map((c) => String(c).toLowerCase()) : [],
      domains: Array.isArray(reconciled.domains) ? reconciled.domains.filter((d) => DOMAINS.includes(d)) : [],
      eventStatus: reconciled.eventStatus, effectiveStart, effectiveEnd,
      confidence, sourceAuthority: 'user',
      supersedesAssertionId: superseded ? superseded.id : null,
      compilerVersion: COMPILER_VERSION,
    };
    compiledAssertions.push(assertion);
    candidatePool.push({ ...assertion, id: null }); // no real id yet — a later assertion in this batch can still overlap-match its subject/predicate/objectValue text, id stays null (not usable as a real FK) until persisted

    for (const rel of deriveRelations(assertion, { supersedesAssertionId: assertion.supersedesAssertionId })) {
      compiledRelations.push({ ...rel, __assertionIndex: compiledAssertions.length - 1 });
    }
  }

  return { assertions: compiledAssertions, relations: compiledRelations, failed: false, failureType: null };
}

/**
 * Persist a compiled batch atomically. `db` is REQUIRED to be the caller's
 * transaction client (see db/index.js's withTransaction) when called
 * alongside another write (the annotation it was compiled from) — this
 * function does not open its own transaction. Retires any assertion each
 * new one supersedes (which also retires that assertion's own relations —
 * see store/contextAssertions.js's retire()). Bumps the invalidation bus
 * (TRIGGER.CONTEXT_ASSERTION_CHANGE) so BrainSnapshot's contextAssertions/
 * contextRelations/resolvedContext fields recompute on the next read.
 */
async function persistCompiledContext({ assertions, relations }, { sourceAnnotationId = null, db }) {
  const contextAssertionsStore = require('../store/contextAssertions');
  const contextRelationsStore = require('../store/contextRelations');
  const createdAssertionIds = [];
  for (const a of assertions) {
    if (a.supersedesAssertionId) await contextAssertionsStore.retire(a.supersedesAssertionId, 'superseded by a new assertion', db);
    const id = await contextAssertionsStore.create({ ...a, sourceAnnotationId }, db);
    createdAssertionIds.push(id);
  }
  const createdRelationIds = [];
  for (const r of relations) {
    const { __assertionIndex, ...rest } = r;
    const sourceAssertionId = createdAssertionIds[__assertionIndex];
    if (!sourceAssertionId) continue;
    // 'assertion'-targeted relations (supersedes/invalidates/classifies/
    // completes emitted from a correction) reference a PRIOR assertion's id
    // directly as targetId — already resolved before persistence, nothing
    // more to do here.
    const id = await contextRelationsStore.create({ ...rest, sourceAssertionId }, db);
    createdRelationIds.push(id);
  }
  if (createdAssertionIds.length) {
    try { require('../brain/invalidation').bump('context_assertion_change'); } catch { /* bus not loaded */ }
  }
  return { assertionIds: createdAssertionIds, relationIds: createdRelationIds };
}

module.exports = {
  COMPILER_VERSION, ASSERTION_TYPES, EVENT_STATUSES, TEMPORAL_REFS, DOMAINS,
  compileUserContext, persistCompiledContext,
  // Exposed for focused unit tests:
  resolveTemporalWindow, reconcileEventStatus, dedupeAssertions, findSupersededAssertion,
  deriveRelations, normalizeTargetId, blendConfidence, buildCompilePrompt,
};
