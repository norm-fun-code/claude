// Field-authority / dependency registry — the declarative invalidation graph
// that makes "recovery changed → todayForecast is now stale" a CHECKED
// invariant instead of a comment someone has to remember. These tests pin the
// transitive invalidation sets the central-state layer promises, so a future
// edit that silently drops an edge (the exact regression class this layer
// exists to kill) fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { TRIGGER, invalidationSet, isInvalidatedBy, authorityFor, FIELDS } = require('../src/brain/registry');

// Requirement #1 + #6: a recovery change must invalidate the Today forecast
// (and every other recovery-derived field) TOGETHER — otherwise a surface can
// serve a forecast built from the old score beside the fresh recovery.
test('recovery_change invalidates recovery AND every field derived from it', () => {
  const set = invalidationSet(TRIGGER.RECOVERY_CHANGE);
  // Recovery itself, the effective workout (reads the band), the forecast
  // (reads recovery + effective workout), and the Health recovery composite.
  assert.deepEqual(set, ['effectiveWorkout', 'recovery', 'recoveryComposite', 'todayForecast']);
  // The specific stale-forecast bug: recovery change reaches the forecast.
  assert.ok(isInvalidatedBy('todayForecast', TRIGGER.RECOVERY_CHANGE));
});

test('workout_override invalidates the effective workout AND the forecast that assumes it', () => {
  const set = invalidationSet(TRIGGER.WORKOUT_OVERRIDE);
  assert.deepEqual(set, ['effectiveWorkout', 'todayForecast']);
  // A "use scheduled workout anyway" / manual swap must not leave the forecast
  // reasoning about the pre-override session.
  assert.ok(isInvalidatedBy('todayForecast', TRIGGER.WORKOUT_OVERRIDE));
});

test('transaction_sync invalidates wealth totals (and nothing unrelated)', () => {
  assert.deepEqual(invalidationSet(TRIGGER.TRANSACTION_SYNC), ['wealth']);
  assert.ok(!isInvalidatedBy('recovery', TRIGGER.TRANSACTION_SYNC));
});

test('goal_change invalidates goals + weekly intention (completion language)', () => {
  assert.deepEqual(invalidationSet(TRIGGER.GOAL_CHANGE), ['goals', 'weeklyIntention']);
});

test('commitment_change invalidates commitments', () => {
  assert.deepEqual(invalidationSet(TRIGGER.COMMITMENT_CHANGE), ['commitments']);
});

// Requirement: "annotation retirement invalidates every context projection" —
// which transitively reaches the forecast, because the forecast reads eligible
// context.
test('annotation_retirement invalidates eligible context AND the forecast projected from it', () => {
  const set = invalidationSet(TRIGGER.ANNOTATION_RETIREMENT);
  assert.deepEqual(set, ['eligibleContext', 'todayForecast']);
  assert.ok(isInvalidatedBy('todayForecast', TRIGGER.ANNOTATION_RETIREMENT));
});

// Context Understanding Layer harden pass: a compiled correction (a
// temporal move, a retraction, a driver ranking change) must invalidate
// more than just its own raw fields — it must reach todayForecast (and any
// other real consumer) transitively, or a context_assertion_change bump
// would silently stop at contextAssertions/contextRelations/resolvedContext
// without ever reaching anything the version-based staleness comparison in
// realtimeTodayContext (which checks recovery/effectiveWorkout/
// todayForecast) actually looks at.
test('context_assertion_change invalidates contextAssertions/contextRelations/resolvedContext AND the forecast built from it', () => {
  const set = invalidationSet(TRIGGER.CONTEXT_ASSERTION_CHANGE);
  assert.deepEqual(set, ['contextAssertions', 'contextRelations', 'resolvedContext', 'todayForecast']);
  assert.ok(isInvalidatedBy('todayForecast', TRIGGER.CONTEXT_ASSERTION_CHANGE));
});

test('every field names an authoritative selector (no field without an owner)', () => {
  for (const key of Object.keys(FIELDS)) {
    assert.equal(typeof authorityFor(key), 'string', `${key} must declare an authority`);
    assert.ok(authorityFor(key).length > 0, `${key} authority must be non-empty`);
  }
});

test('an unknown trigger invalidates nothing (no accidental blanket invalidation)', () => {
  assert.deepEqual(invalidationSet('not_a_real_trigger'), []);
});
