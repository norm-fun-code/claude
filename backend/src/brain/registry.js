// Field-authority & dependency registry — the declarative contract that says,
// for every canonical fact NormOS surfaces, WHO owns it (the authoritative
// selector), how long it stays fresh, what it derives from, whether it can be
// live-refreshed on a cache serve, and — crucially — what a change to it must
// invalidate so no surface can keep serving a stale derived value beside a
// fresh input.
//
// This module is PURE (no I/O). buildBrainSnapshot (snapshot.js) reads these
// authorities to compose a snapshot; the briefing cache-hit path and future
// consumers read `invalidationSet(trigger)` to know exactly which fields to
// recompute when an input changes. Keeping the dependency graph declarative
// here — rather than as ad-hoc "also recompute X" comments scattered across
// call sites — is what makes "recovery changed → todayForecast is now stale"
// a checked invariant instead of a bug someone has to remember (the exact
// class of bug this whole layer exists to kill: a cached briefing that
// refreshed live recovery but left todayForecast built from the old score).
'use strict';

// Change triggers — the events that make one or more inputs newer than the
// derived facts computed from them.
const TRIGGER = Object.freeze({
  RECOVERY_CHANGE: 'recovery_change',       // a new/changed liveRecovery score/band
  WORKOUT_OVERRIDE: 'workout_override',     // a manual workout swap or "use scheduled anyway"
  TRANSACTION_SYNC: 'transaction_sync',     // a Monarch/wealth sync landed newer totals
  GOAL_CHANGE: 'goal_change',               // a goal added/edited/achieved
  COMMITMENT_CHANGE: 'commitment_change',   // a commitment created/completed
  ANNOTATION_RETIREMENT: 'annotation_retirement', // an annotation retired/retracted/added
  CONTEXT_ASSERTION_CHANGE: 'context_assertion_change', // a ContextAssertion/ContextRelation created, retired, or resolved
});

// The canonical fields. `key` is stable — surfaces reference these, not raw
// store names. `authority` names the module + selector that OWNS the fact
// (the single place allowed to compute it). `dependsOn` are other field keys
// this one derives from (so invalidating an input transitively invalidates
// this). `invalidatedBy` are triggers that directly make this field stale.
// `ttlMs` is how long a computed value may be served before it should be
// recomputed (null = event-driven only, no time-based staleness).
// `liveRefreshable` marks fields cheap/safe to recompute on a cache serve.
const FIELDS = Object.freeze({
  recovery: {
    authority: 'intelligence/recovery.liveRecovery',
    dependsOn: [],
    invalidatedBy: [TRIGGER.RECOVERY_CHANGE],
    ttlMs: Number(process.env.RECOVERY_CACHE_MS) || 120000,
    liveRefreshable: true,
  },
  effectiveWorkout: {
    authority: 'services/workout.getEffectiveWorkout',
    // The override wins over the auto-downgrade wins over the schedule, and the
    // auto-downgrade reads the recovery band — so BOTH a workout override and a
    // recovery change change the effective workout.
    dependsOn: ['recovery'],
    invalidatedBy: [TRIGGER.WORKOUT_OVERRIDE],
    ttlMs: null,
    liveRefreshable: true,
  },
  todayForecast: {
    authority: 'intelligence/predict.computeTodayForecast',
    // resolvedContext (Context Understanding Layer — see
    // intelligence/context-resolver.js) added alongside eligibleContext: a
    // compiled correction (a temporal move, a retraction, a driver the
    // resolver now ranks differently) must invalidate the forecast built
    // from it exactly like a raw-annotation change already does, or a
    // context_assertion_change bump would silently stop at
    // contextAssertions/contextRelations/resolvedContext themselves —
    // technically "invalidated" but never reaching anything a cached
    // consumer (the scoped/full-build staleness comparison in
    // realtimeTodayContext, which checks recovery/effectiveWorkout/
    // todayForecast versions) would actually notice.
    dependsOn: ['recovery', 'effectiveWorkout', 'eligibleContext', 'resolvedContext'],
    invalidatedBy: [],
    ttlMs: null,
    liveRefreshable: true,
  },
  recoveryComposite: {
    // The Health-tab recovery composite finding (score/band/parts) — same
    // recovery input as `recovery`, rendered as a finding.
    authority: 'intelligence/recovery.formatRecoveryComposite',
    dependsOn: ['recovery'],
    invalidatedBy: [],
    ttlMs: null,
    liveRefreshable: true,
  },
  goals: {
    authority: 'store/goals.listGoals',
    dependsOn: [],
    invalidatedBy: [TRIGGER.GOAL_CHANGE],
    ttlMs: null,
    liveRefreshable: true,
  },
  weeklyIntention: {
    authority: 'store/intentions.currentIntention',
    dependsOn: [],
    invalidatedBy: [TRIGGER.GOAL_CHANGE],
    ttlMs: null,
    liveRefreshable: true,
  },
  commitments: {
    authority: 'store/commitments.listActive',
    dependsOn: [],
    invalidatedBy: [TRIGGER.COMMITMENT_CHANGE],
    ttlMs: null,
    liveRefreshable: true,
  },
  wealth: {
    authority: 'services/wealth-insights.buildWealthInsights',
    dependsOn: [],
    invalidatedBy: [TRIGGER.TRANSACTION_SYNC],
    ttlMs: null,
    liveRefreshable: false,
  },
  findings: {
    authority: 'store/findings.listFindings',
    dependsOn: [],
    invalidatedBy: [],
    ttlMs: null,
    liveRefreshable: true,
  },
  experiments: {
    authority: 'store/experiments.listExperiments',
    dependsOn: [],
    invalidatedBy: [],
    ttlMs: null,
    liveRefreshable: true,
  },
  eligibleContext: {
    authority: 'store/annotations.overlapping + intelligence/context-semantics.filterEligible',
    dependsOn: [],
    invalidatedBy: [TRIGGER.ANNOTATION_RETIREMENT],
    ttlMs: null,
    liveRefreshable: true,
  },
  calendarAvailability: {
    authority: 'services/calendar.fetchWorkBusyBlocks',
    dependsOn: [],
    invalidatedBy: [],
    ttlMs: 15 * 60 * 1000,
    liveRefreshable: false,
  },
  sourceHealth: {
    authority: 'intelligence/source-health.describeDataGaps',
    dependsOn: [],
    invalidatedBy: [],
    ttlMs: null,
    liveRefreshable: true,
  },
  contextAssertions: {
    // The Context Understanding Layer's raw compiled assertions — see
    // intelligence/context-compiler.js (extraction) and
    // store/contextAssertions.js (persistence). Every other surface should
    // read `resolvedContext` below, not this raw list directly.
    authority: 'store/contextAssertions.getActive',
    dependsOn: [],
    invalidatedBy: [TRIGGER.CONTEXT_ASSERTION_CHANGE],
    ttlMs: null,
    liveRefreshable: true,
  },
  contextRelations: {
    authority: 'store/contextRelations.getActive',
    dependsOn: [],
    invalidatedBy: [TRIGGER.CONTEXT_ASSERTION_CHANGE],
    ttlMs: null,
    liveRefreshable: true,
  },
  resolvedContext: {
    // The canonical projection (drivers/constraints/preferences/
    // classifications/uncertainties) — see intelligence/context-resolver.js.
    // Depends on the raw assertions/relations it's built from so either one
    // changing invalidates this too.
    authority: 'intelligence/context-resolver.resolveContext',
    dependsOn: ['contextAssertions', 'contextRelations'],
    invalidatedBy: [TRIGGER.CONTEXT_ASSERTION_CHANGE],
    ttlMs: null,
    liveRefreshable: true,
  },
});

// Reverse edges: for each field, which fields DEPEND ON it (so invalidating a
// field cascades to its dependents). Computed once from `dependsOn`.
const DEPENDENTS = (() => {
  const rev = {};
  for (const key of Object.keys(FIELDS)) rev[key] = [];
  for (const [key, def] of Object.entries(FIELDS)) {
    for (const dep of def.dependsOn) {
      if (!rev[dep]) rev[dep] = [];
      rev[dep].push(key);
    }
  }
  return rev;
})();

/**
 * Pure: the transitive set of field keys that must be recomputed when `trigger`
 * fires. Starts from every field directly `invalidatedBy` the trigger, then
 * walks `DEPENDENTS` so a change to an input (recovery) reaches everything
 * derived from it (effectiveWorkout → todayForecast, recoveryComposite, …).
 * Returned as a sorted array for deterministic tests.
 *
 * @param {string} trigger one of TRIGGER.*
 * @returns {string[]} field keys, including the directly-invalidated inputs.
 */
function invalidationSet(trigger) {
  const seeds = Object.entries(FIELDS)
    .filter(([, def]) => def.invalidatedBy.includes(trigger))
    .map(([key]) => key);
  const out = new Set();
  const stack = [...seeds];
  while (stack.length) {
    const key = stack.pop();
    if (out.has(key)) continue;
    out.add(key);
    for (const dependent of (DEPENDENTS[key] || [])) stack.push(dependent);
  }
  return [...out].sort();
}

/** Pure: is `field` in the invalidation set for `trigger`? */
function isInvalidatedBy(field, trigger) {
  return invalidationSet(trigger).includes(field);
}

/** Pure: the authoritative selector string for a field (for provenance/docs). */
function authorityFor(field) {
  return FIELDS[field]?.authority ?? null;
}

module.exports = { TRIGGER, FIELDS, DEPENDENTS, invalidationSet, isInvalidatedBy, authorityFor };
