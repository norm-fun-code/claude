// The central resolver: compares active ContextAssertions/ContextRelations
// against each other (temporal alignment, contradiction/negation, evidence
// tier, expiration) and produces ResolvedContext — the ONE canonical
// projection every surface reads via the selectors below instead of
// independently reinterpreting raw assertions. See
// intelligence/context-compiler.js for how assertions/relations are
// produced, and brain/snapshot.js for how ResolvedContext is exposed on
// BrainSnapshot.
//
// Pure where it matters: `buildResolvedContext` and every selector below
// are synchronous and take already-fetched assertions/relations, so the
// scoring/ranking logic is fully unit-testable without a database.
// `resolveContext` is the thin async wrapper that fetches from the stores.
'use strict';

function targetKey(targetType, targetId) {
  return `${targetType}:${targetId}`;
}

/**
 * Build a ResolvedContext from already-fetched active assertions/relations.
 * Relations past their `expiresAt` are dropped here (decay) — everything
 * downstream only ever sees currently-applicable relations. Retired
 * assertions/relations should already be excluded by the caller (the
 * stores' getActive() only returns retired_at IS NULL rows); this function
 * doesn't re-check retirement, only expiration, which is time-relative and
 * so can't be baked into a stored "active" flag.
 */
function buildResolvedContext({ assertions = [], relations = [], tz, now = new Date() }) {
  const assertionById = new Map(assertions.map((a) => [a.id, a]));
  const liveRelations = relations.filter((r) => !(r.expiresAt && new Date(r.expiresAt) < now));

  const relationsByTarget = new Map();
  for (const r of liveRelations) {
    const key = targetKey(r.targetType, r.targetId);
    if (!relationsByTarget.has(key)) relationsByTarget.set(key, []);
    relationsByTarget.get(key).push(r);
  }

  const preferences = liveRelations.filter((r) => r.targetType === 'action_type' && r.relationship === 'changes_priority');
  const unresolvedUncertainties = liveRelations.filter((r) => r.unresolved === true);
  const resolvedUncertainties = liveRelations.filter((r) => r.resolvedAt != null);
  const resolvedCorrections = assertions
    .filter((a) => a.retiredAt != null)
    .map((a) => ({ supersededAssertion: a, retiredReason: a.retiredReason }));

  return {
    generatedAt: now.toISOString(),
    tz,
    assertions,
    assertionById,
    relations: liveRelations,
    relationsByTarget,
    preferences,
    unresolvedUncertainties,
    resolvedUncertainties,
    resolvedCorrections,
  };
}

/** Fetch active assertions/relations from the stores and resolve. This is
 *  the async entrypoint BrainSnapshot and route handlers call; everything
 *  else in this module is pure and takes the fetched lists directly. */
async function resolveContext({ tz = process.env.TZ || 'America/New_York', now = new Date() } = {}) {
  const contextAssertionsStore = require('../store/contextAssertions');
  const contextRelationsStore = require('../store/contextRelations');
  const [assertions, relations] = await Promise.all([
    contextAssertionsStore.getActive({ limit: 500 }),
    contextRelationsStore.getActive({ limit: 1000 }),
  ]);
  return buildResolvedContext({ assertions, relations, tz, now });
}

// ── Driver engine ────────────────────────────────────────────────────────
// Evidence-tier weights — the backbone of "how strongly should this
// influence recommendations" (see the DRIVER ENGINE section of the design
// brief). canonical_fact/established_knowledge outrank a personal
// observation, which outranks a bare model hypothesis; user_explicit sits
// in between because it's authoritative for what the user did/decided but
// NOT for a metric's physiological cause (see context-compiler.js's
// deriveRelations — user_explicit is never even generated for a metric
// target, so this weight only matters for non-metric targets like
// calendar/completion/constraint relations, where the user genuinely IS
// the authority).
const EVIDENCE_WEIGHT = Object.freeze({
  canonical_fact: 1.0,
  established_knowledge: 0.9,
  personal_experiment: 0.85,
  user_explicit: 0.75,
  personal_observation: 0.5,
  // A real, generally-accepted physiological pattern without one specific
  // verified citation attached (knowledge-registry.js's
  // EVIDENCE_TIER.SUPPORTED_ASSOCIATION) — weaker than a cited established
  // relation, stronger than a bare model_hypothesis guess.
  supported_association: 0.6,
  model_hypothesis: 0.25,
});

/** Score one relation as a driver candidate: evidence tier (45%),
 *  confidence (25%), strength/dose (20%), temporal alignment (10% — full
 *  weight inside the relation's own window, linearly decaying toward 0 as
 *  `now` approaches `expiresAt` past `windowEnd`, matching the knowledge
 *  registry's decay model). */
function scoreRelation(relation, { now = new Date() } = {}) {
  const weight = EVIDENCE_WEIGHT[relation.evidenceBasis] ?? 0.3;
  const confidence = Number.isFinite(relation.confidence) ? relation.confidence : 0.5;
  const strength = Number.isFinite(relation.strength) ? relation.strength : 0.5;
  let temporal = 1;
  if (relation.windowEnd) {
    const end = new Date(relation.windowEnd).getTime();
    const nowMs = now.getTime();
    if (Number.isFinite(end) && nowMs > end) {
      const decayEnd = relation.expiresAt ? new Date(relation.expiresAt).getTime() : end;
      const span = Math.max(1, decayEnd - end);
      temporal = Math.max(0, 1 - (nowMs - end) / span);
    }
  }
  return Math.round((weight * 0.45 + confidence * 0.25 + strength * 0.2 + temporal * 0.1) * 1000) / 1000;
}

function describeAssertion(assertion) {
  if (!assertion) return null;
  if (assertion.predicate) return `${assertion.predicate}${assertion.objectValue ? ` ${assertion.objectValue}` : ''}`.trim();
  return assertion.rawText || null;
}

/**
 * Canonical ranked-driver projection for `targetId` (e.g.
 * 'health:recovery_autonomic') under `targetType` (default 'metric').
 * Returns `{ driver: null, reason: 'no_eligible_driver', competingDrivers:
 * [] }` when nothing qualifies — a VALID result NormOS must be willing to
 * say out loud (see brain/claimValidator.js's checkResolvedDriver), never
 * silently substituted with the most recent unrelated note.
 */
function getDriversFor(resolved, targetId, { targetType = 'metric', now = new Date() } = {}) {
  const candidates = (resolved.relationsByTarget.get(targetKey(targetType, targetId)) || [])
    .filter((r) => ['contributes_to', 'explains', 'supports'].includes(r.relationship));
  if (!candidates.length) return { driver: null, reason: 'no_eligible_driver', confidence: null, competingDrivers: [] };

  const ranked = candidates
    .map((relation) => ({ relation, score: scoreRelation(relation, { now }) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const topAssertion = resolved.assertionById.get(top.relation.sourceAssertionId);

  return {
    driver: describeAssertion(topAssertion),
    confidence: top.score,
    evidenceBasis: top.relation.evidenceBasis,
    supportingAssertionId: top.relation.sourceAssertionId,
    applicableWindow: { start: top.relation.windowStart, end: top.relation.windowEnd },
    justifiedLanguage: top.relation.permittedLanguage,
    competingDrivers: ranked.slice(1).map((x) => ({
      driver: describeAssertion(resolved.assertionById.get(x.relation.sourceAssertionId)),
      confidence: x.score,
      evidenceBasis: x.relation.evidenceBasis,
    })),
  };
}

/** Every 'constrains' relation for a target (e.g. a skipped workout's
 *  "exhausted" constraint) — never conflated with a completed/incomplete
 *  state or a metric driver. */
function getConstraintsFor(resolved, targetType, targetId) {
  return (resolved.relationsByTarget.get(targetKey(targetType, targetId)) || [])
    .filter((r) => r.relationship === 'constrains');
}

/** Durable preferences matching `actionType` — exact target match first,
 *  falling back to word-overlap (same primitive context-semantics.js uses
 *  everywhere else) so "evening workout" and "workouts in the evening"
 *  still match without a rigid taxonomy. */
function getPreferencesFor(resolved, actionType) {
  const { overlapScore } = require('./context-semantics');
  const { normalizeTargetId } = require('./context-compiler');
  const norm = normalizeTargetId(actionType);
  return resolved.preferences.filter((p) => {
    if (p.targetId === norm) return true;
    return overlapScore(p.targetId.replace(/_/g, ' '), String(actionType || '').replace(/_/g, ' ')) >= 0.5;
  });
}

/** The most recent user-stated completion state for an entity (goal,
 *  commitment, or workout) — `null` when the user has never explicitly
 *  corrected/confirmed completion for it (callers fall back to their own
 *  store's default in that case; this selector only speaks when the user
 *  actually said something). */
function getCompletionState(resolved, targetType, targetId) {
  const rels = (resolved.relationsByTarget.get(targetKey(targetType, targetId)) || [])
    .filter((r) => r.relationship === 'completes')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!rels.length) return null;
  const top = rels[0];
  return {
    completed: top.permittedLanguage === 'completed',
    source: 'user_correction',
    assertionId: top.sourceAssertionId,
    confidence: top.confidence,
  };
}

/** The most recent user classification of a calendar block/event — `null`
 *  when never reclassified (the raw calendar title/free-busy data is still
 *  authoritative in that case). */
function getCalendarClassification(resolved, eventKey) {
  const { normalizeTargetId } = require('./context-compiler');
  const rels = (resolved.relationsByTarget.get(targetKey('calendar_event', normalizeTargetId(eventKey))) || [])
    .filter((r) => r.relationship === 'classifies')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!rels.length) return null;
  const top = rels[0];
  return { classification: top.permittedLanguage, assertionId: top.sourceAssertionId, confidence: top.confidence };
}

const COMPLETION_MATCH_THRESHOLD = 0.34;
const COMPLETION_MATCH_MARGIN = 0.15;

/**
 * Match active completion-correction relations ('I did not complete the
 * valuation conversation') against a REAL list of stable-ID'd items (e.g.
 * store/commitments.js rows) — the mechanism that makes a correction change
 * the canonical projection every surface reads (UI's GET /commitments,
 * BrainSnapshot's `commitments` field feeding briefing/Ask/realtime, action
 * ranking), not just something queryable via getCompletionState if a caller
 * already knows the exact matching targetId (harden pass, item 3b — same
 * shape/rationale as matchCalendarClassifications above).
 *
 * `items` must carry a stable `id` and MAY carry `completedAt` (ISO string
 * or null) — the item's own most recent authoritative completion timestamp.
 * A correction only overrides an item whose `completedAt` is either absent
 * or OLDER than the correction (`relation.createdAt`); a completion that
 * happened AFTER the correction was stated is a later authoritative action
 * (e.g. the user explicitly checked it done, or a fresh metric-driven
 * auto-complete) and always wins — the correction never overrides it. This
 * is what "a later authoritative completion must supersede the correction"
 * means in practice.
 *
 * No stable-ID match is attempted here: no current input path threads a
 * commitment/goal's real DB id through a compiled assertion (mirrors
 * matchCalendarClassifications' documented state for calendar event ids) —
 * every match is the same conservative word-overlap primitive used
 * throughout this module. Ambiguous (no clear single winner) -> not
 * applied; the assertion/relation stay persisted and queryable via
 * getCompletionState directly.
 *
 * @returns {Map<string, {completed: boolean, assertionId: string, confidence: number}>}
 *   keyed by matched item id.
 */
function matchCompletionCorrections(resolved, { items = [], targetType = 'commitment', getText = (item) => item.title, getCompletedAt = (item) => item.completedAt ?? null } = {}) {
  const { overlapScore } = require('./context-semantics');
  const completionRelations = (resolved.relations || []).filter((r) => r.relationship === 'completes' && r.targetType === targetType);
  const overrides = new Map();

  for (const rel of completionRelations) {
    const assertion = resolved.assertionById.get(rel.sourceAssertionId);
    if (!assertion) continue;
    const probeText = `${assertion.subject || ''} ${assertion.objectValue || ''} ${assertion.rawText || ''}`;

    const scored = items
      .map((item) => ({ item, score: overlapScore(probeText, getText(item) || '') }))
      .filter((s) => s.score >= COMPLETION_MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score);
    if (scored.length !== 1 && !(scored.length > 1 && scored[0].score - scored[1].score >= COMPLETION_MATCH_MARGIN)) {
      // Ambiguous or no match at all — never guess which item this
      // correction was about.
      continue;
    }
    const item = scored[0].item;
    const completedAt = getCompletedAt(item);
    if (completedAt && new Date(completedAt) > new Date(rel.createdAt)) {
      // A later authoritative completion (explicit or metric-driven)
      // supersedes an older correction — the DB state already wins, no
      // override needed.
      continue;
    }
    const existing = overrides.get(item.id);
    if (existing && new Date(existing.createdAt) > new Date(rel.createdAt)) continue; // keep the most recent correction per item
    overrides.set(item.id, {
      completed: rel.permittedLanguage === 'completed',
      assertionId: rel.sourceAssertionId,
      confidence: rel.confidence,
      createdAt: rel.createdAt,
    });
  }

  return overrides;
}

// ── Calendar classification -> canonical calendar-load projection ─────────
// (harden pass, item 3a). getCalendarClassification above answers "how was
// THIS specific event classified" for a caller that already knows which
// event it means; matchCalendarClassifications answers the harder question
// "which of TODAY'S actual calendar-load-projection blocks does a
// classification correction apply to" — the answer that actually changes
// intelligence/calendar-load.js's computed meeting hours, not just what the
// claim validator rejects in generated prose.

/** Best-effort extraction of an explicit clock-time range from free text —
 *  "5-9pm", "5:00-9:00 PM", "5 to 9pm". A single trailing meridiem applies
 *  to both ends ("5-9pm" means 5pm-9pm, not 5am-9pm). Returns
 *  {startMin, endMin} in minutes-since-midnight, or null if no range is
 *  found or it doesn't parse into a sane forward interval. Deliberately
 *  narrow — this is NOT a general time-expression parser, just enough to
 *  match the common "X-Ypm" shape a compiled assertion's subject/objectValue
 *  plausibly carries (the compiler prompt sees the ORIGINAL question, which
 *  is where a time range like this usually comes from). */
function extractClockTimeRange(text) {
  const m = String(text || '').match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!m) return null;
  const [, h1, min1, h2, min2, meridiem] = m;
  const to24 = (h, mm) => {
    let hour = parseInt(h, 10) % 12;
    if (meridiem.toLowerCase() === 'pm') hour += 12;
    return hour * 60 + (mm ? parseInt(mm, 10) : 0);
  };
  const startMin = to24(h1, min1);
  const endMin = to24(h2, min2);
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) return null;
  return { startMin, endMin };
}

const CLASSIFICATION_MATCH_THRESHOLD = 0.34;
const CLASSIFICATION_MATCH_MARGIN = 0.15;

/**
 * Match today's active calendar-classification relations against the
 * REAL, already-fetched calendar-load inputs (`workBusy`/`calendar`, the
 * exact shape intelligence/calendar-load.js's computeCalendarLoad takes) —
 * not against the LLM's own paraphrased subject text alone. Priority order:
 *   0. An EXACT stable block-identity match: the relation's targetId IS a
 *      calendar-block-identity.js id (source+date+normalized start/end —
 *      see that module), set directly by routes/annotations.js when the
 *      client echoed back which exact block a question's answer described
 *      (question-time provenance, never reconstructed from the answer text
 *      at all). Never ambiguous, never needs a title or a clock range in
 *      the answer — this is what lets a TITLELESS work-busy block get
 *      classified correctly. This is the primary, reliable path for any
 *      answer that originated from a structured calendar-load question.
 *   1. A stable calendar event id on the source assertion's entities, if
 *      the caller's `calendar` list carries ids too (see
 *      services/calendar.js — Google's real event id is now threaded
 *      through). Exact match, never ambiguous. NOTE: no current input path
 *      populates `entities` with an id when compiling an answer — distinct
 *      from priority 0 above (which uses targetId, not entities) and kept
 *      for a future caller that might.
 *   2. An explicit clock-time range extracted from the assertion's own
 *      subject/objectValue/rawText (extractClockTimeRange) — matched
 *      against whichever work-busy/calendar interval(s) overlap it. Exactly
 *      ONE overlapping interval -> applied. Zero or more-than-one -> AMBIGUOUS,
 *      the assertion is left applied to nothing (still persisted as
 *      context — see getCalendarClassification for reading it directly).
 *   3. Text-only fallback: conservative word-overlap (same threshold/margin
 *      as context-semantics.js's findRetractionTarget) against NAMED
 *      calendar-event titles only — work-busy blocks carry no titles to
 *      text-match against at all. Same ambiguity rule: no clear single
 *      winner -> not applied.
 *
 * Date-scoped (priorities 1-3 only — priority 0's id already encodes the
 * exact date, so it needs no separate gate): when `targetLocalDate` is
 * given and a relation's `windowStart` is known (the date IT was actually
 * about), the relation is skipped entirely unless that date matches — this
 * is what stops "the same clock window next week" from silently inheriting
 * this week's classification. A relation with no windowStart at all (a
 * genuinely undated legacy correction, predating this date-binding) falls
 * through ungated, matching the prior behavior — a narrow, documented
 * boundary rather than a silent gap for anything created going forward.
 *
 * Returns an array shaped exactly like `calendar` entries
 * (title/startTime/endTime) — ready to pass as computeCalendarLoad's
 * `classifiedOverrides` — one per successfully-matched classification.
 */
function matchCalendarClassifications(resolved, { calendar = [], workBusy = [], targetLocalDate = null } = {}) {
  const { overlapScore } = require('./context-semantics');
  const { toMinutesSinceMidnight, localDateStr } = require('../util/date');
  const classifyRelations = (resolved.relations || []).filter((r) => r.relationship === 'classifies' && r.targetType === 'calendar_event');
  const overrides = [];
  const tz = resolved.tz || 'America/New_York';

  for (const rel of classifyRelations) {
    const assertion = resolved.assertionById.get(rel.sourceAssertionId);
    if (!assertion) continue;

    if (targetLocalDate && rel.windowStart) {
      const relDate = localDateStr(tz, new Date(rel.windowStart));
      if (relDate !== targetLocalDate) continue;
    }

    // Priority 0: exact stable block-identity match — see the doc comment.
    const idMatch = [...workBusy, ...calendar].find((b) => b.id && b.id === rel.targetId);
    if (idMatch) {
      overrides.push({
        title: rel.permittedLanguage || assertion.objectValue || 'reclassified',
        startTime: idMatch.start ?? idMatch.startTime,
        endTime: idMatch.end ?? idMatch.endTime,
        allDay: false,
      });
      continue;
    }

    const probeText = `${assertion.subject || ''} ${assertion.objectValue || ''} ${assertion.rawText || ''}`;

    // Priority 2: explicit clock-time range against REAL block intervals.
    const range = extractClockTimeRange(probeText);
    if (range) {
      const candidates = [
        ...workBusy.map((b, i) => ({ kind: 'workBusy', index: i, block: b, startMin: toMinutesSinceMidnight(b.start), endMin: toMinutesSinceMidnight(b.end) })),
        ...calendar.filter((e) => !e.allDay).map((e, i) => ({ kind: 'calendar', index: i, block: e, startMin: toMinutesSinceMidnight(e.startTime), endMin: toMinutesSinceMidnight(e.endTime) })),
      ].filter((c) => c.startMin != null && c.endMin != null
        && Math.min(c.endMin, range.endMin) - Math.max(c.startMin, range.startMin) > 0);
      if (candidates.length === 1) {
        const c = candidates[0];
        overrides.push({ title: rel.permittedLanguage || assertion.objectValue || 'reclassified', startTime: c.block.start ?? c.block.startTime, endTime: c.block.end ?? c.block.endTime, allDay: false });
        continue;
      }
      // Zero or ambiguous multiple matches — fall through to text matching
      // rather than giving up immediately, in case the range was a red
      // herring (e.g. mentioned in passing) and the title match is cleaner.
    }

    // Priority 3: conservative text match against NAMED calendar titles only.
    const scored = calendar
      .filter((e) => !e.allDay && e.title)
      .map((e) => ({ e, score: overlapScore(probeText, e.title) }))
      .filter((s) => s.score >= CLASSIFICATION_MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 1 || (scored.length > 1 && scored[0].score - scored[1].score >= CLASSIFICATION_MATCH_MARGIN)) {
      const e = scored[0].e;
      overrides.push({ title: rel.permittedLanguage || e.title, startTime: e.startTime, endTime: e.endTime, allDay: false });
    }
    // Otherwise: ambiguous or no match at all — the assertion/relation stay
    // persisted (queryable via getCalendarClassification) but are NOT
    // applied to any specific block, per the fail-closed requirement.
  }

  return overrides;
}

function getResolvedUncertainties(resolved) {
  return resolved.resolvedUncertainties;
}

function getUnresolvedUncertainties(resolved) {
  return resolved.unresolvedUncertainties;
}

// Purpose -> domains, mirroring context-semantics.js's isEligibleContext
// purpose vocabulary so a surface migrating from filterEligible(purpose)
// to getRelevantContext(purpose) sees a familiar shape.
const PURPOSE_DOMAINS = Object.freeze({
  health: ['health'],
  wellbeing: ['wellbeing'],
  forecast: ['health', 'wellbeing'],
  calendar: ['calendar'],
  wealth: ['wealth'],
  general: null, // null = every domain
});

/** Assertions relevant to `surfacePurpose` — excludes negated/retracted
 *  assertions for any purpose OTHER than 'general' (a negated event is
 *  still worth showing verbatim in a general context feed — "confirmed:
 *  didn't drink" — but must never inform a health/forecast read). */
function getRelevantContext(resolved, surfacePurpose = 'general') {
  const domains = PURPOSE_DOMAINS[surfacePurpose] ?? null;
  return resolved.assertions.filter((a) => {
    if (surfacePurpose !== 'general' && ['negated', 'retracted'].includes(a.eventStatus)) return false;
    if (!domains) return true;
    return (a.domains || []).some((d) => domains.includes(d));
  });
}

// ── Temporal eligibility (audit fix, item 1) ───────────────────────────────
// summarizeResolvedContext used to include EVERY non-retired assertion,
// reduced to an undated line ("- drank wine.") — a health event from three
// days ago read exactly like one from last night, because nothing in the
// text projection carried (or checked) WHEN it applied. This is the fix:
// episodic assertions (something that happened/applied at a specific,
// already-elapsed time) drop out of the projection once their own stored
// effective window has ended, and the ones still eligible carry an explicit
// date anchor so the model can never mistake "recent" for "current".
//
// Deliberately compares against the assertion's OWN persisted
// `effectiveEnd` timestamp (set once, at compile time, by
// context-compiler.js's resolveTemporalWindow — see that function's night-
// window resolution for temporalRef 'last_night'/'this_morning') rather
// than re-deriving anything from `temporalRef` or "now" at read time — a
// stored instant can never silently slide forward as time passes the way a
// string like "last_night" reinterpreted fresh each read could.

/** A standing/durable statement never gets excluded by the passage of time —
 *  currently just preferences (the compiler's own definition: "a durable
 *  'I prefer/don't want' statement"), which by design have no natural
 *  expiry. Everything else with an effectiveEnd is episodic and DOES
 *  expire. */
function isDurableAssertion(a) {
  return a.assertionType === 'preference';
}

/** A forward-looking episodic statement — a stated future plan or an
 *  ongoing/in-progress state (a fast, a trip, an illness, ANY temporary
 *  condition; not tied to any one named example). See
 *  context-compiler.js's resolveTemporalWindow: this eventStatus/
 *  assertionType combination is exactly the one that can resolve to an
 *  UNBOUNDED `effectiveEnd: null` when the text states no duration/end —
 *  "give episodic context a real lifecycle" requires that this specific
 *  case never reads as current indefinitely (see isTemporallyEligible
 *  below), unlike a past/completed assertion's null window (which was
 *  never a forward claim that could go stale) or a durable preference
 *  (which has no expiry by design). */
function isForwardEpisodic(a) {
  return ['event', 'state', 'plan'].includes(a.assertionType) && ['planned', 'ongoing'].includes(a.eventStatus);
}

/** True if `a` should still be shown as CURRENT context at `asOf`. An
 *  episodic assertion stays eligible through the END of the LOCAL calendar
 *  day its `effectiveEnd` falls on — not just until that exact instant.
 *  This matters concretely: "I drank last night" resolves effectiveEnd to
 *  roughly wake time (~7am, see context-compiler.js's resolveTemporalWindow
 *  night-window resolution), but the drinking is still the right context
 *  for a Chief Brief explaining THAT DAY's recovery reading built at 9am,
 *  1pm, or 9pm — a cutoff at the bare wake-time instant would make the
 *  event vanish from its own day's context. It correctly stops applying
 *  once the FOLLOWING day starts (the next night is a different night).
 *  `tz` must be the same timezone the assertion's dates were resolved in
 *  (resolved.tz) — a UTC day boundary would shift the cutoff by hours in
 *  either direction depending on the user's actual offset.
 *  Historical callers (an explicit "what did I say last week" surface) pass
 *  `includeHistorical: true` to see everything regardless of age. */
function isTemporallyEligible(a, { asOf = new Date(), tz = 'UTC', includeHistorical = false } = {}) {
  if (includeHistorical) return true;
  if (isDurableAssertion(a)) return true;
  if (!a.effectiveEnd) {
    // A forward-looking plan/state (isForwardEpisodic) with NO establishable
    // end must never read as current indefinitely — "never treat
    // effectiveEnd = null as currently active forever for an episodic plan"
    // (see context-compiler.js's resolveTemporalWindow + this module's
    // header). Excluded from current-state projections, not guessed at; the
    // row itself is untouched and still visible via includeHistorical:true.
    // Every other untimed assertion (a past/completed event with no
    // resolvable window, an undated note) keeps the original "no window =
    // always shown" behavior — it was never a forward claim that could go
    // stale, so there's nothing to expire.
    return !isForwardEpisodic(a);
  }
  const { localDayBoundsUtc } = require('../util/date');
  const eligibleThrough = localDayBoundsUtc(tz, new Date(a.effectiveEnd)).end;
  return eligibleThrough.getTime() >= new Date(asOf).getTime();
}

/** Compact "applied to <date>" / "applied to the night ending <date>"
 *  suffix for an episodic assertion still inside its window — omitted
 *  entirely for durable statements or assertions with no bound to anchor
 *  to. `tz` is the SAME resolver-local timezone carried on `resolved.tz`
 *  (buildResolvedContext), so "July 16" always means July 16 in the user's
 *  own zone, never a UTC-shifted date. */
function temporalAnchorSuffix(a, tz) {
  if (isDurableAssertion(a) || !a.effectiveEnd) return '';
  const { formatMonthDay } = require('../util/date');
  const endLabel = formatMonthDay(a.effectiveEnd, tz);
  if (!endLabel) return '';
  return (a.temporalRef === 'last_night' || a.temporalRef === 'this_morning')
    ? ` — applied to the night ending ${endLabel}.`
    : ` — applied to ${endLabel}.`;
}

/** One compact line describing a single assertion for a prompt — never the
 *  full row, never raw provenance noise. Prefers the structured
 *  predicate/objectValue (what the compiler actually extracted) over
 *  rawText, since that's the point of compiling at all; falls back to a
 *  truncated rawText when predicate/objectValue are both empty (an
 *  assertion type the compiler couldn't structure further). */
function summarizeAssertionLine(a, tz, asOf = new Date()) {
  // The structured predicate/objectValue is already temporally grounded (it
  // carries no raw "tonight"). Only the rawText fallback — an assertion the
  // compiler couldn't structure — can still contain a frozen relative time
  // word, so re-anchor THAT to today off the assertion's entry time. See
  // intelligence/reanchor-time.js (the same fix applied to the raw-notes path
  // in routes/briefing.js).
  const body = a.predicate
    ? `${a.predicate}${a.objectValue ? ` ${a.objectValue}` : ''}`.trim()
    : (() => {
        const { reanchorRelativeTime } = require('./reanchor-time');
        return reanchorRelativeTime(String(a.rawText || '').trim(), { fromDate: a.recordedAt || a.createdAt, now: asOf, tz }).slice(0, 140);
      })();
  if (!body) return null;
  const status = ['negated', 'retracted'].includes(a.eventStatus) ? ` [${a.eventStatus}]` : '';
  return `- ${body}${status}${temporalAnchorSuffix(a, tz)}`;
}

/**
 * Compact, purpose-specific text projection of ResolvedContext for an LLM
 * prompt (harden pass, item 2) — the deliberate alternative to a surface
 * dumping the complete assertions/relations graph, or re-reading raw
 * annotations/day-journal text itself. Every surface that migrates to this
 * (Chief Brief, Ask, realtime voice) sees the SAME compiled facts in the
 * SAME compact shape, instead of each independently reinterpreting raw
 * text and risking disagreement.
 *
 * `asOf` defaults to the moment this ResolvedContext was resolved
 * (`resolved.generatedAt`) — NOT a fresh `new Date()` — so a snapshot built
 * once and read multiple times (see brain/snapshot.js) gives the same
 * temporal answer every time it's read, instead of "yesterday's event" only
 * fading out mid-read depending on when exactly the text was generated.
 * `includeHistorical: true` disables the window filter entirely, for a
 * surface that explicitly wants past context (none does today).
 *
 * Returns '' when there's nothing relevant — callers should treat an empty
 * string as "fall back to raw annotations/day-journal text," never as
 * "the user has no context" (see each call site's own raw-text fallback).
 */
function summarizeResolvedContext(resolved, { purpose = 'general', maxItems = 8, asOf, includeHistorical = false } = {}) {
  if (!resolved) return '';
  const effectiveAsOf = asOf ?? (resolved.generatedAt ? new Date(resolved.generatedAt) : new Date());
  const relevant = getRelevantContext(resolved, purpose)
    .filter((a) => isTemporallyEligible(a, { asOf: effectiveAsOf, tz: resolved.tz, includeHistorical }))
    .slice()
    .sort((a, b) => new Date(b.recordedAt || b.createdAt || 0) - new Date(a.recordedAt || a.createdAt || 0))
    .slice(0, maxItems);
  const lines = relevant.map((a) => summarizeAssertionLine(a, resolved.tz, effectiveAsOf)).filter(Boolean);
  return lines.join('\n');
}

// ── Raw context as a REAL fallback (audit fix, item 2) ─────────────────────
// Chief Brief and Ask used to hand the model resolvedContext's compiled
// summary AND then unconditionally the same ground covered again as raw
// annotations/day-journal text — "prefer the compiled version" left as a
// suggestion in the prompt rather than enforced, so a stale or since-
// corrected raw note could still read as live, contradicting or reviving
// exactly what the compiled correction fixed. partitionRawContext splits a
// caller's raw item list into `matched` (already represented by a compiled
// assertion — drop these) and `unmatched` (genuinely new/unstructured
// content the compiler didn't capture — keep these, never silently lose
// real journal context the model has nowhere else to see).
const RAW_CONTEXT_MATCH_THRESHOLD = 0.34;

/**
 * @param resolved ResolvedContext (or null/undefined — everything reads as
 *   unmatched when there's nothing compiled to match against).
 * @param rawItems caller's raw rows (annotations, day-journal entries, ...).
 * @param getId extracts a stable id from a raw item, if it has one — checked
 *   first against every compiled assertion's `sourceAnnotationId` (the
 *   annotation IS the compilation's source, so an id match is exact, never
 *   ambiguous). Return null/undefined when the item has no such id (e.g. a
 *   day-journal row, which mirrors an annotation's TEXT but carries no link
 *   back to it) to fall through to text matching.
 * @param getText extracts the comparable text for the conservative-overlap
 *   fallback (context-semantics.js's overlapScore, the SAME primitive used
 *   throughout this module for ambiguity-aware matching elsewhere).
 * @returns {{matched: Array, unmatched: Array}}
 */
function partitionRawContext(resolved, rawItems, { getId = (x) => x?.id ?? null, getText = (x) => x?.label ?? x?.text ?? '' } = {}) {
  const assertions = resolved?.assertions || [];
  if (!rawItems?.length || !assertions.length) return { matched: [], unmatched: rawItems ? rawItems.slice() : [] };
  const { overlapScore } = require('./context-semantics');
  const matchedAnnotationIds = new Set(
    assertions.filter((a) => a.sourceAnnotationId != null).map((a) => String(a.sourceAnnotationId))
  );
  const matched = [];
  const unmatched = [];
  for (const item of rawItems) {
    const id = getId(item);
    if (id != null && matchedAnnotationIds.has(String(id))) { matched.push(item); continue; }
    const text = String(getText(item) || '').trim();
    const textMatched = text && assertions.some((a) => overlapScore(text, a.rawText || '') >= RAW_CONTEXT_MATCH_THRESHOLD);
    (textMatched ? matched : unmatched).push(item);
  }
  return { matched, unmatched };
}

module.exports = {
  buildResolvedContext, resolveContext,
  getDriversFor, getConstraintsFor, getPreferencesFor, getCompletionState,
  getCalendarClassification, matchCalendarClassifications, matchCompletionCorrections,
  getResolvedUncertainties, getUnresolvedUncertainties,
  getRelevantContext, summarizeResolvedContext,
  // Exposed for focused unit tests:
  scoreRelation, EVIDENCE_WEIGHT, describeAssertion, targetKey, extractClockTimeRange,
  isTemporallyEligible, isDurableAssertion, isForwardEpisodic, temporalAnchorSuffix, partitionRawContext,
};
