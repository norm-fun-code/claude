// Normalized event contract for the Attention Policy — see intelligence/
// attention.js for the judge() that consumes these. Every producer (a
// watcher, the finding-driven nudge builder, wealth nudges, check-in
// reminders, commitments) already computes its OWN detection — a z-score, a
// budget-pace ratio, a rank/priority. These adapters translate that existing,
// untouched detector output into the one shape the policy understands,
// rather than asking each producer to re-derive its math in a new format.
//
// Pure. No DB, no clock (asOf is always passed in explicitly by the caller).

/**
 * @typedef {object} AttentionEvent
 * @property {string} source       - 'watch_health'|'watch_wellbeing'|'wealth'|'finding'|'commitment'|'belief'
 * @property {string} domain       - 'health'|'wealth'|'wellbeing'|'habits'|'meta'
 * @property {string} type         - 'anomaly'|'low_checkin'|'over_budget'|'budget_pace'|'leverage'|
 *                                    'cross_context'|'forecast_risk'|'trend'|'commitment_due'|
 *                                    'statement'|'dismissal_pattern'|'checkin_missing'
 * @property {string} subject      - stable entity id (metric name, category, goalId, commitment id, belief slug)
 * @property {string} title
 * @property {string} body
 * @property {Date}   observedAt
 * @property {{magnitude:?number, confidence:number, novelty:?number}} signal
 * @property {?number} urgencyHint
 * @property {?object} belief      - present => routes to update_belief
 * @property {?object} action      - {kind, payload, reversible, riskClass, capabilityId} or null
 * @property {boolean} critical    - producer's OWN claim; validated against an allowlist by the policy
 * @property {'day'|'week'|'month'} dedupBucket
 * @property {boolean} hasUncertainty
 */

function baseEvent(overrides) {
  return {
    source: null, domain: null, type: null, subject: null,
    title: '', body: '',
    observedAt: new Date(),
    signal: { magnitude: null, confidence: 0.5, novelty: null },
    urgencyHint: null,
    belief: null,
    action: null,
    critical: false,
    dedupBucket: 'day',
    hasUncertainty: false,
    ...overrides,
  };
}

/** From watch.js's baselineAnomaly() result — a health metric that crossed
 *  the z-score bar. `a` is the {z, latest, baselineMean} anomaly object,
 *  `cfg` is the metric's WATCHED config. */
function fromHealthAnomaly({ cfg, a, asOf, title, body }) {
  // |z| of 2.2 (the existing THRESHOLD) maps to magnitude ~0.5; scale so a
  // truly extreme reading (|z|~4.4) approaches 1.0, without a hard ceiling
  // that clips still-meaningful spikes.
  const magnitude = Math.min(1, Math.abs(a.z) / 4.4);
  // This event proves a current metric is unusual relative to this person's
  // baseline; it does not establish why. More baseline nights make that
  // comparison sturdier, but it remains an observation rather than a clinical
  // assessment. An extreme anomaly can still be timely enough for a normal
  // push, but never receives the quiet-hours-bypassing "critical" label.
  const baselineN = Number(a.n) || 0;
  const confidence = baselineN >= 24 ? 0.75 : baselineN >= 16 ? 0.7 : 0.6;
  return baseEvent({
    source: 'watch_health', domain: 'health', type: 'anomaly', subject: cfg.metric,
    title, body, observedAt: asOf,
    signal: { magnitude, confidence, novelty: null },
    // A non-critical alert must clear the normal interrupt bar. Reserve a
    // higher urgency for a genuinely extreme personal-baseline departure;
    // that still does not convert the event into a diagnosis or an emergency.
    urgencyHint: magnitude >= 0.85 ? 0.9 : null,
    critical: false,
  });
}

/** From watch.js's watchWellbeing() — a low mood/energy/focus check-in. */
function fromLowCheckin({ low, mood, energy, focus, asOf, title, body }) {
  // More dimensions low, or a lower absolute rating, both increase magnitude.
  const lowest = Math.min(...[mood, energy, focus].filter((v) => Number.isFinite(Number(v))).map(Number));
  const depthFactor = Number.isFinite(lowest) ? (2 - lowest) / 1 : 0.5; // rating 1 -> 1.0, rating 2 -> 0.0 floor below
  const magnitude = Math.max(0.4, Math.min(1, 0.5 + 0.25 * (low.length - 1) + 0.25 * Math.max(0, depthFactor)));
  return baseEvent({
    source: 'watch_wellbeing', domain: 'wellbeing', type: 'low_checkin', subject: 'day',
    title, body, observedAt: asOf,
    signal: { magnitude, confidence: 0.9, novelty: null },
  });
}

/** From wealth-nudges.js's own candidate objects — already shaped like
 *  {dedupKey, title, body, priority, basis: {type, category, ...}}. */
function fromWealthCandidate(candidate, { asOf } = {}) {
  const basisType = candidate.basis?.type; // 'over_budget' | 'budget_pace' | 'new_recurring'
  const type = basisType === 'budget_pace' || basisType === 'new_recurring' ? basisType : 'over_budget';
  const subject = candidate.basis?.category || candidate.basis?.name || 'unknown';
  const dedupBucket = type === 'over_budget' ? 'month' : type === 'new_recurring' ? 'month' : 'day';
  return baseEvent({
    source: 'wealth', domain: 'wealth', type, subject,
    title: candidate.title, body: candidate.body,
    observedAt: asOf || new Date(),
    signal: { magnitude: clampPriority(candidate.priority), confidence: 0.75, novelty: null },
    dedupBucket,
  });
}

/** From nudges.js's buildNudges() candidates — already shaped like
 *  {key, title, body, priority, basis: {type, ...}}. One adapter for all four
 *  finding-derived candidate types (forecast/leverage/trend/cross_context);
 *  `key` already encodes the stable subject, reused as-is for readability in
 *  the ledger even though eventKey() rebuilds its own canonical key. */
function fromFindingCandidate(candidate, { asOf } = {}) {
  const basisType = candidate.basis?.type || 'trend';
  const domain = basisType === 'leverage' || basisType === 'cross_context' ? 'meta' : 'wealth';
  // subject: reuse the second segment of the existing `key` (e.g.
  // "forecast:g1" -> "g1", "trend:health:sleep_hours" -> "health:sleep_hours").
  const subject = candidate.key.includes(':') ? candidate.key.slice(candidate.key.indexOf(':') + 1) : candidate.key;
  const isRisk = basisType === 'forecast';
  return baseEvent({
    source: 'finding', domain: isRisk ? 'meta' : domain, type: isRisk ? 'forecast_risk' : basisType,
    subject, title: candidate.title, body: candidate.body,
    observedAt: asOf || new Date(),
    signal: { magnitude: clampPriority(candidate.priority), confidence: 0.7, novelty: null },
    action: basisType === 'leverage' ? {
      kind: 'commit_action', payload: { text: candidate.body },
      reversible: true, riskClass: 'internal_write', capabilityId: 'commit_action',
    } : null,
    dedupBucket: basisType === 'cross_context' ? 'week' : basisType === 'leverage' ? 'day' : 'week',
  });
}

/** From nudges.js's checkinReminder() candidate. */
function fromCheckinMissing(candidate, { asOf } = {}) {
  return baseEvent({
    source: 'finding', domain: 'wellbeing', type: 'checkin_missing', subject: 'day',
    title: candidate.title, body: candidate.body,
    observedAt: asOf || new Date(),
    signal: { magnitude: 0.5, confidence: 0.9, novelty: null },
  });
}

/** From notify/commitments.js — a commitment reminder that actually fired.
 *  Used for AUDIT ONLY: the commitments runner keeps its own delivery logic
 *  (its delicate re-nudge cadence + daily budget are NOT routed through the
 *  policy), and records the fact of firing here so the outcome loop (done vs
 *  ignored) still feeds the beliefs layer. subject is the commitment id so
 *  outcomeCounts()/beliefs can learn per-commitment-kind follow-through. */
function fromCommitmentDue({ commitment, asOf, followUp }) {
  return baseEvent({
    source: 'commitment', domain: 'habits', type: 'commitment_due',
    subject: String(commitment.id),
    title: followUp ? 'Still on your list' : 'You committed to this',
    body: commitment.title,
    observedAt: asOf || new Date(),
    signal: { magnitude: 0.6, confidence: 0.9, novelty: null },
    // Month bucket, not the default day: the commitment id already makes the
    // event_key unique, and a reminder fired one evening is commonly resolved
    // the NEXT morning — a day bucket would give the firing and the outcome
    // stamp different keys, so stampOutcome() (matches by event_key) would
    // silently miss the outcome, the strongest signal the beliefs loop learns
    // from. A month bucket keeps firing + resolution on the same key.
    dedupBucket: 'month',
  });
}

/** From intelligence/beliefs.js's promoted belief specs — routes straight to
 *  update_belief via the policy's belief-routing gate. */
function fromBelief(spec, { asOf } = {}) {
  return baseEvent({
    source: 'belief', domain: 'meta', type: spec.kind, subject: spec.dedupKey,
    title: spec.statement, body: spec.statement,
    observedAt: asOf || new Date(),
    signal: { magnitude: null, confidence: spec.confidence ?? 0.7, novelty: null },
    belief: spec,
  });
}

function clampPriority(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

module.exports = {
  baseEvent, fromHealthAnomaly, fromLowCheckin, fromWealthCandidate,
  fromFindingCandidate, fromCheckinMissing, fromCommitmentDue, fromBelief,
};
