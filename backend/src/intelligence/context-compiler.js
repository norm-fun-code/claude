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

// Fallback expiry window (hours) for a metric-driver relation whose
// knowledge-registry entry doesn't state its own effectWindowHours — see
// deriveRelations' fail-closed temporal handling below. Every metric
// relation gets a real, finite expiresAt; this is the backstop, never a
// substitute for a registry entry stating its own window.
const DEFAULT_METRIC_RELATION_WINDOW_HOURS = 24;

const ASSERTION_TYPES = [
  'event', 'state', 'preference', 'constraint', 'plan', 'decision',
  'correction', 'explanation', 'classification', 'completion',
];
const EVENT_STATUSES = ['occurred', 'planned', 'ongoing', 'completed', 'negated', 'retracted', 'superseded'];
const TEMPORAL_REFS = ['last_night', 'today', 'yesterday', 'this_morning', 'ongoing', 'future', 'unspecified', 'explicit_date'];
const DOMAINS = ['health', 'wellbeing', 'calendar', 'wealth', 'habits', 'goals', 'commitments', 'workouts', 'other'];
// Explicit preference polarity (harden pass, item 4) — meaningful only for
// assertionType 'preference'; every other assertion carries 'neutral'. Not
// every preference is an exclusion: "I prefer morning workouts" must BOOST
// matching actions, "don't recommend evening workouts" must EXCLUDE them —
// treating both as the same "avoid" relation was the bug this fixes.
const PREFERENCE_POLARITIES = ['prefer', 'avoid', 'require', 'neutral'];

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
          // Meaningful only when assertionType is 'preference' — 'neutral'
          // for every other assertion type.
          polarity: { type: 'string', enum: PREFERENCE_POLARITIES },
          // The exact clause/span of the ORIGINAL text this SPECIFIC
          // assertion is drawn from (a verbatim substring, not a
          // paraphrase) — see reconcileEventStatus below, which validates
          // negation/retraction against THIS span rather than the whole
          // message, so a compound statement ("I didn't drink, but I ate a
          // late meal") negates only the assertion whose own span contains
          // the negation cue.
          evidenceSpan: { type: 'string' },
          confidence: { type: 'number' },
          // Episodic lifecycle (bounded absolute interval — see
          // resolveTemporalWindow below). At most one of these is ever
          // meaningful for a given assertion; 0 / '' means "not stated."
          // Deterministically re-validated against evidenceSpan before
          // either is trusted — see textStatesDurationHours/
          // textImpliesBoundedEnd — so a hallucinated duration/end the text
          // never actually said is ignored, not silently trusted.
          durationHours: { type: 'number' }, // e.g. 25 for "a 25-hour fast" — 0 when no explicit duration is stated
          explicitEndDate: { type: 'string' }, // 'YYYY-MM-DD', the actual calendar date an explicit end ("through tomorrow", "until Friday") resolves to — '' when no explicit end is stated
        },
        required: [
          'assertionType', 'subject', 'predicate', 'objectValue', 'concepts', 'domains',
          'eventStatus', 'temporalRef', 'explicitDate', 'correctsPriorText', 'evidenceSpan', 'polarity', 'confidence',
          'durationHours', 'explicitEndDate',
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
- durationHours: ONLY for a plan/event/state (temporalRef future/ongoing) that states an explicit DURATION — "25 hour fast", "gone for 3 days", "a two-week trip" — the duration in hours as a plain number (25, 72, 336). Otherwise 0. Never guess a duration the text doesn't state.
- explicitEndDate: ONLY for a plan/event/state that states an explicit END DAY in words, not a duration — "through tomorrow", "until Friday", "ending Sunday", "back on the 14th" — that day's actual calendar date (YYYY-MM-DD), computed from today's date above. Otherwise empty string. Use EITHER durationHours OR explicitEndDate for a given assertion, whichever the text actually states — never both, never neither when the text gives one. A future/ongoing statement with NO stated duration or end (a bare "I'm traveling") leaves both 0/empty — this is expected and correct; do not invent an end.
- correctsPriorText: if this statement corrects, retracts, or supersedes something the user likely said before (a temporal correction, a classification change, a completion correction, an explicit retraction), give your best short paraphrase of what it corrects so the caller can match it against recent history. Empty string if this is not a correction of anything.
- polarity: ONLY meaningful when assertionType is "preference" — otherwise always "neutral". prefer: the user wants MORE of this ("I prefer morning workouts", "I like scheduling deep work early"). avoid: the user wants LESS of or NO this ("don't recommend evening workouts", "avoid scheduling calls after 5pm"). require: the user stated a HARD, non-negotiable rule, not just a leaning ("never schedule anything before 8am", "I must have Fridays free") — use this sparingly, only for genuinely absolute wording. neutral: not a preference, or the direction genuinely can't be told.
- evidenceSpan: the EXACT verbatim clause of the input text this specific assertion is drawn from — copy it character-for-character from the input, do not paraphrase. For a compound statement with multiple distinct facts ("I didn't drink, but I ate a late meal"), each assertion's evidenceSpan must be ONLY its own clause ("I didn't drink" for the alcohol assertion, "I ate a late meal" for the late-meal assertion) — never the whole sentence for every assertion. This is what lets negation/retraction in one clause avoid wrongly applying to a sibling assertion drawn from a different clause of the same message.
- confidence: your own 0-1 confidence in this extraction.

Be conservative: only extract what the text actually supports. Never invent a cause, a completion state, or a preference the text doesn't state. A plain observational note with no clear structure still gets ONE assertion (assertionType "state", predicate/objectValue capturing it plainly) — never return zero assertions for non-empty text.`;

function buildCompilePrompt({ rawText, question = null, tz, now, subjectLocalDate = null }) {
  const localDate = now.toLocaleDateString('en-CA', { timeZone: tz });
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
  // subjectLocalDate — when the caller already knows WHICH day this answer
  // describes (e.g. a calendar-load question asked about a specific day's
  // schedule — see routes/annotations.js's POST /briefing/context) — tells
  // the model explicitly, rather than leaving it to infer the date purely
  // from the question's prose. Defense-in-depth only: the caller applies its
  // own deterministic date binding to a calendar-classification assertion
  // regardless of what temporalRef/explicitDate the model picks (see
  // routes/annotations.js), so this doesn't need to be perfectly reliable —
  // it just improves the odds the model's own extraction agrees.
  const subjectLine = subjectLocalDate ? `This answer specifically describes ${subjectLocalDate}.\n` : '';
  return `Today is ${weekday}, ${localDate} (timezone ${tz}).
${subjectLine}${question ? `The question being answered was: "${question}"\n` : ''}Text to compile:
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

// ── Episodic lifecycle: bounded-duration deterministic validation ──────────
// "Deterministically validate the LLM extraction against the original text"
// — a duration/end-date the compiler extracted is only ever trusted when the
// ASSERTION'S OWN text (evidenceSpan, falling back to the full raw text —
// same fallback rule reconcileEventStatus uses) actually contains a matching
// signal. A hallucinated "25 hours" the user never said is silently ignored
// (falls back to the single-day-bounded default below), never trusted blind.
const MAX_EPISODIC_DURATION_HOURS = 24 * 14; // two weeks — a generous ceiling for any real episodic statement, not a real-world limit

/** True if `text` states a duration reasonably close to `hours` (as "N
 *  hour(s)"/"N hr(s)"/"N day(s)", loosely — "25 hour fast", "25-hour",
 *  "3 days"). Half-hour tolerance absorbs "24.5-hour" vs durationHours:24.5
 *  style rounding; day-to-hour conversion lets "a 2 day trip" validate
 *  durationHours:48. */
function textStatesDurationHours(text, hours) {
  if (!Number.isFinite(hours) || hours <= 0) return false;
  const matches = [...String(text || '').matchAll(/(\d+(?:\.\d+)?)\s*-?\s*(hour|hr|day)s?\b/gi)];
  return matches.some((m) => {
    const n = Number(m[1]);
    const asHours = m[2].toLowerCase().startsWith('day') ? n * 24 : n;
    return Math.abs(asHours - hours) < 0.5;
  });
}

/** True if `text` uses END-bounding language at all ("through", "until",
 *  "till", "ending", "back on/by") — a loose but deterministic guard that an
 *  explicitEndDate the compiler extracted corresponds to SOMETHING the text
 *  actually said, not an invented end. */
function textImpliesBoundedEnd(text) {
  return /\b(through|until|till|'til|ending|back (on|by))\b/i.test(String(text || ''));
}

/** Reuses analyze.js's resolveNightWindow for night-anchored health refs (the
 *  SAME canonical "last night" definition every other night-binding surface
 *  uses — see intelligence/recovery-drivers.js, routes/annotations.js), and
 *  simple local-day boundaries for everything else. Never throws — an
 *  unresolvable temporal ref just leaves both bounds null (an assertion with
 *  no effective window is still valid; it just can't anchor a driver's
 *  temporal-alignment score, see context-resolver.js) — this null-window
 *  fail-closed contract for 'unspecified' is unchanged and load-bearing
 *  (deriveRelations below refuses to create a metric-driver relation without
 *  a bounded effectiveEnd; do not weaken that).
 *
 *  Episodic lifecycle ("give episodic context a real lifecycle"): a
 *  temporalRef 'future' statement (a stated plan/event starting now or
 *  later) still starts with an open `effectiveEnd: null` by default — BUT a
 *  stated duration or explicit end EXTENDS it to the actual described bound,
 *  which is what makes "25 hour fast starting tonight through tomorrow"
 *  resolve to a real two-day interval instead of staying open-ended. Both
 *  are deterministically cross-checked against the assertion's own text
 *  before being trusted (see textStatesDurationHours/textImpliesBoundedEnd
 *  above) and clamped to a sane ceiling — an LLM extraction is validated,
 *  never blindly applied. When NEITHER is stated (a bare "I'm traveling"),
 *  effectiveEnd stays null exactly as before — context-resolver.js's
 *  isTemporallyEligible/isForwardEpisodic is what stops that from reading as
 *  current forever (never treats a forward-looking plan/state with no
 *  establishable end as indefinitely current), not a guessed default here. */
function resolveTemporalWindow({ temporalRef, explicitDate, domains = [], durationHours = 0, explicitEndDate = '', evidenceSpan = '' }, { tz, now, wakeTimeSeries = [] }) {
  const { localDayBoundsUtc } = require('../util/date');
  const isHealthLike = domains.includes('health') || domains.includes('wellbeing');

  let effectiveStart = null;
  let effectiveEnd = null;

  if ((temporalRef === 'last_night' || temporalRef === 'this_morning') && isHealthLike) {
    const { resolveNightWindow } = require('./analyze');
    const todayKey = now.toLocaleDateString('en-CA', { timeZone: tz });
    const w = resolveNightWindow(todayKey, wakeTimeSeries, tz);
    effectiveStart = w.start;
    effectiveEnd = w.end;
  } else if (temporalRef === 'yesterday') {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const b = localDayBoundsUtc(tz, yesterday);
    effectiveStart = b.start;
    effectiveEnd = b.end;
  } else if (temporalRef === 'today' || temporalRef === 'ongoing') {
    const { start } = localDayBoundsUtc(tz, now);
    effectiveStart = start;
    effectiveEnd = now;
  } else if (temporalRef === 'explicit_date' && explicitDate) {
    const d = new Date(`${explicitDate}T12:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      const b = localDayBoundsUtc(tz, d);
      effectiveStart = b.start;
      effectiveEnd = b.end;
    }
  } else if (temporalRef === 'future') {
    effectiveStart = now; // effectiveEnd stays null unless extended below
  }
  // 'unspecified' (or an explicit_date that failed to parse) falls through
  // with both bounds still null — genuinely no temporal signal in the text.

  // Deterministic bounded-duration override — the mechanism that gives an
  // episodic FUTURE plan a real absolute end. Only ever EXTENDS a known
  // effectiveStart (so it's inert for 'unspecified', which has none); never
  // invents a start.
  if (effectiveStart) {
    if (Number.isFinite(durationHours) && durationHours > 0 && durationHours <= MAX_EPISODIC_DURATION_HOURS
      && textStatesDurationHours(evidenceSpan, durationHours)) {
      const candidateEnd = new Date(effectiveStart.getTime() + durationHours * 3600 * 1000);
      if (candidateEnd.getTime() > effectiveStart.getTime()) effectiveEnd = candidateEnd;
    } else if (explicitEndDate && textImpliesBoundedEnd(evidenceSpan)) {
      const d = new Date(`${explicitEndDate}T12:00:00Z`);
      if (!Number.isNaN(d.getTime())) {
        const candidateEnd = localDayBoundsUtc(tz, d).end;
        const spanMs = candidateEnd.getTime() - effectiveStart.getTime();
        if (spanMs > 0 && spanMs <= MAX_EPISODIC_DURATION_HOURS * 3600 * 1000) effectiveEnd = candidateEnd;
      }
    }
  }

  return { effectiveStart, effectiveEnd };
}

/** Deterministic safety net (constrain, don't replace): if the raw text
 *  unambiguously reads as a retraction or a plain negation per
 *  context-semantics.js's classifier but the LLM's eventStatus disagrees,
 *  the regex wins — this is exactly the class of thing a closed, reviewed
 *  pattern set is good at (catching an unambiguous case the model missed),
 *  not a replacement for the model's broader interpretation.
 *
 *  ASSERTION-LOCAL, not message-global: classifies `rawAssertion.evidenceSpan`
 *  (the specific clause this assertion was drawn from), never the whole
 *  `fullRawText` — a compound statement ("I didn't drink, but I ate a late
 *  meal") must negate only the alcohol assertion (whose span is "I didn't
 *  drink"), never the late-meal assertion (whose span is "I ate a late
 *  meal" and contains no negation cue at all). `fullRawText` is used ONLY
 *  as a fallback when evidenceSpan is missing/empty (a malformed response
 *  from an older/misbehaving call) — classifying the whole message in that
 *  narrow fallback case is strictly safer than skipping the safety net
 *  entirely, but is never the normal path since the schema requires
 *  evidenceSpan on every assertion. */
function reconcileEventStatus(rawAssertion, fullRawText) {
  const span = String(rawAssertion.evidenceSpan || '').trim() || fullRawText;
  const kind = classifyEventKind(span);
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

// Maps a knowledge-registry entry's evidenceTier to the derived relation's
// shape — three distinct tiers, not a binary established/everything-else
// split (the harden pass added SUPPORTED_ASSOCIATION as a real middle tier:
// a genuinely-accepted physiological pattern without one specific verified
// citation attached, stronger than a bare model_hypothesis guess but not
// entitled to 'established_knowledge''s confidence).
const TIER_TO_RELATION_META = {
  [EVIDENCE_TIER.ESTABLISHED]: { relationship: 'contributes_to', evidenceBasis: 'established_knowledge', strength: 0.7, confidenceBase: 0.75 },
  [EVIDENCE_TIER.SUPPORTED_ASSOCIATION]: { relationship: 'supports', evidenceBasis: 'supported_association', strength: 0.45, confidenceBase: 0.5 },
};
const DEFAULT_TIER_META = { relationship: 'supports', evidenceBasis: 'model_hypothesis', strength: 0.3, confidenceBase: 0.3 };
function relationMetaForTier(evidenceTier) {
  return TIER_TO_RELATION_META[evidenceTier] || DEFAULT_TIER_META;
}

/** Blend a registry entry's population-level evidence with this assertion's
 *  own extraction confidence — the entry's tier caps how confident a single
 *  mention can ever make a relation (a hedged model_hypothesis/
 *  supported_association entry can never look as confident as an
 *  established one just because the user stated it plainly). */
function blendConfidence(assertionConfidence, entry) {
  const base = relationMetaForTier(entry.evidenceTier).confidenceBase;
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
      targetType: 'calendar_event',
      // classifiedBlockId — set ONLY by routes/annotations.js's POST
      // /briefing/context when the client echoed back the EXACT block a
      // structured calendar-load question's answer described (question-time
      // provenance — see calendar-block-identity.js) — targets that block
      // directly, no text/clock-range matching needed at all. Falls back to
      // the old text-derived id (still used by matchCalendarClassifications'
      // priority 2/3 fuzzy fallback for anything without such provenance,
      // e.g. a proactive correction with no question behind it).
      targetId: assertion.classifiedBlockId || normalizeTargetId(assertion.subject || assertion.objectValue),
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
    // direction carries the polarity (harden pass, item 4) — 'avoid'/
    // 'prefer'/'require'/'neutral' — so a consumer (leverage.js's
    // rankActions via context-resolver.js's getPreferencesFor) can exclude,
    // boost, strongly-boost, or ignore a matching candidate respectively,
    // instead of the old behavior of treating every preference as an
    // exclusion regardless of what the user actually said. Falls back to
    // 'neutral' (no ranking effect) for a malformed/missing polarity rather
    // than guessing 'avoid', which is the fail-safe direction for this
    // relation type: "do nothing" is always safer than silently excluding
    // something the user actually asked FOR more of.
    const polarity = PREFERENCE_POLARITIES.includes(assertion.polarity) ? assertion.polarity : 'neutral';
    relations.push({
      targetType: 'action_type', targetId: normalizeTargetId(assertion.objectValue || assertion.predicate),
      relationship: 'changes_priority', direction: polarity, evidenceBasis: 'user_explicit', confidence: conf, strength: 0.8,
      permittedLanguage: assertion.rawText || null,
    });
  }

  // Metric relations: the ONLY path that may target a measured metric — see
  // AUTHORITY POLICY. A concept match against the knowledge registry decides
  // evidence_basis, never the assertion's own sourceAuthority (which is
  // always 'user' — the user being authoritative about WHAT happened does
  // not make them authoritative about its PHYSIOLOGICAL EFFECT).
  //
  // FAIL CLOSED ON UNKNOWN TIMING: a metric-driver relation requires a
  // BOUNDED effective window (assertion.effectiveEnd non-null). When
  // resolveTemporalWindow couldn't anchor the assertion (temporalRef
  // 'unspecified' — no reliable question metadata, explicit wording, or
  // known event timestamp), effectiveEnd is null and NO metric relation is
  // created at all, for either the concept-matched branch or the
  // unknown-concept-hypothesis branch below — the assertion still persists
  // as a context_assertions row (queryable as context, still shown to the
  // user), it just can never surface via getDriversFor. Without this, an
  // untimed health mention got `expiresAt: null` (Number.isFinite(undefined)
  // is false, so the old ternary's else-branch fired), which
  // buildResolvedContext's expiration filter treats as "never expires" — a
  // permanent driver from a single mention with no known timing.
  const isMetricEligible = ['event', 'state', 'explanation'].includes(assertion.assertionType)
    && ['occurred', 'ongoing'].includes(assertion.eventStatus)
    && domains.includes('health')
    && Boolean(assertion.effectiveEnd);
  if (isMetricEligible) {
    let matchedAny = false;
    for (const concept of concepts) {
      for (const entry of knowledgeRelationsForConcept(concept)) {
        matchedAny = true;
        // Every metric relation gets a real expiresAt — effectWindowHours
        // when the registry entry states one, else a conservative default
        // cap (never "no expiration") so an entry that someday omits
        // effectWindowHours can't silently produce an undecaying driver.
        const windowHours = Number.isFinite(entry.effectWindowHours) ? entry.effectWindowHours : DEFAULT_METRIC_RELATION_WINDOW_HOURS;
        const expiresAt = new Date(new Date(assertion.effectiveEnd).getTime() + windowHours * 3600 * 1000).toISOString();
        const meta = relationMetaForTier(entry.evidenceTier);
        relations.push({
          targetType: 'metric', targetId: entry.targetConcept,
          relationship: meta.relationship,
          direction: entry.expectedDirection,
          evidenceBasis: meta.evidenceBasis,
          confidence: blendConfidence(conf, entry),
          strength: meta.strength,
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
        expiresAt: new Date(new Date(assertion.effectiveEnd).getTime() + DEFAULT_METRIC_RELATION_WINDOW_HOURS * 3600 * 1000).toISOString(),
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
async function compileUserContext({
  rawText, source, question = null, tz = process.env.TZ || 'America/New_York', now = new Date(),
  recentActiveAssertions = [], wakeTimeSeries = [],
  // Question-time provenance ("give every question a canonical subject"):
  // when the caller already knows WHICH calendar date/block(s) this answer
  // describes — echoed back by the client from a structured calendar-load
  // question, see routes/annotations.js — pass them here. A
  // calendar-classification assertion is then bound to that EXACT
  // date/block deterministically below, overriding whatever
  // temporalRef/explicitDate the LLM itself extracted from the answer's own
  // (often date-free) wording. Reconstructing identity from the answer text
  // alone at read time is exactly the unreliable mechanism this replaces.
  subjectLocalDate = null, subjectBlocks = null,
} = {}) {
  const text = String(rawText || '').trim();
  if (!text) return { assertions: [], relations: [], failed: false, failureType: null };

  const prompt = buildCompilePrompt({ rawText: text, question, tz, now, subjectLocalDate });
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
    // Same evidenceSpan-with-fallback rule reconcileEventStatus itself uses
    // (an assertion-local clause, falling back to the full message only when
    // the model left evidenceSpan empty) — so the duration/end-date
    // deterministic text validation below checks the right substring.
    const spanForValidation = String(reconciled.evidenceSpan || '').trim() || text;
    const { effectiveStart, effectiveEnd } = resolveTemporalWindow(
      { ...reconciled, evidenceSpan: spanForValidation }, { tz, now, wakeTimeSeries }
    );
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
      // Transient — read by deriveRelations below to set a preference
      // relation's direction/polarity, NOT a persisted column (see
      // store/contextAssertions.js's create(), which only inserts the
      // specific fields it destructures).
      polarity: PREFERENCE_POLARITIES.includes(reconciled.polarity) ? reconciled.polarity : 'neutral',
    };

    // Question-time provenance override — see the module header above. Only
    // ever touches a calendar-domain classification assertion, and only
    // when the caller actually supplied subject metadata; every other
    // assertion (and a classification with no known subject) is untouched.
    if (subjectLocalDate && assertion.assertionType === 'classification' && assertion.domains.includes('calendar')) {
      const { localDayBoundsUtc } = require('../util/date');
      const subjectDate = new Date(`${subjectLocalDate}T12:00:00Z`);
      if (!Number.isNaN(subjectDate.getTime())) {
        const b = localDayBoundsUtc(tz, subjectDate);
        assertion.effectiveStart = b.start;
        assertion.effectiveEnd = b.end;
      }
      // Only when the subject is UNAMBIGUOUSLY one exact block — see
      // context-resolver.js's matchCalendarClassifications priority 0. With
      // more than one candidate block, identity stays unset here and the
      // relation falls back to date-scoped clock-range/text matching at
      // read time (matchCalendarClassifications priorities 2/3) rather than
      // guessing which of several blocks the answer meant.
      if (Array.isArray(subjectBlocks) && subjectBlocks.length === 1 && subjectBlocks[0]?.id) {
        assertion.classifiedBlockId = subjectBlocks[0].id;
      }
    }

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
 * see store/contextAssertions.js's retire()).
 *
 * Deliberately does NOT touch the invalidation bus. A prior version called
 * `invalidation.bump()` from inside this function — i.e. inside the
 * caller's still-open transaction, before COMMIT. `bump()` increments the
 * in-process version immediately AND fires a separate-connection durable
 * write-through; another instance polling that durable version via
 * `refresh()` could observe the NEW version and confidently serve/cache
 * "current" context before this transaction's writes were even committed
 * (and if the transaction then rolled back, that instance would have
 * invalidated toward state that never existed). Invalidation must happen
 * strictly AFTER commit, and only on success — see routes/annotations.js's
 * `await withTransaction(...)` call site, which calls
 * `invalidation.bumpDurable('context_assertion_change')` itself once this
 * promise (and the whole transaction) has resolved, never from inside here.
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
  return { assertionIds: createdAssertionIds, relationIds: createdRelationIds };
}

module.exports = {
  COMPILER_VERSION, ASSERTION_TYPES, EVENT_STATUSES, TEMPORAL_REFS, DOMAINS,
  compileUserContext, persistCompiledContext,
  // Exposed for focused unit tests:
  resolveTemporalWindow, reconcileEventStatus, dedupeAssertions, findSupersededAssertion,
  deriveRelations, normalizeTargetId, blendConfidence, buildCompilePrompt,
};
