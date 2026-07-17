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

module.exports = {
  buildResolvedContext, resolveContext,
  getDriversFor, getConstraintsFor, getPreferencesFor, getCompletionState,
  getCalendarClassification, getResolvedUncertainties, getUnresolvedUncertainties,
  getRelevantContext,
  // Exposed for focused unit tests:
  scoreRelation, EVIDENCE_WEIGHT, describeAssertion, targetKey,
};
