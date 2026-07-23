// Runtime invalidation bus — proves the registry's dependency graph ACTUALLY
// drives invalidation at runtime (versions bump, listeners fire), not just in
// documentation. This is the piece that was missing: invalidationSet() existed
// but nothing called it on a mutation.
const test = require('node:test');
const assert = require('node:assert/strict');
const inv = require('../src/brain/invalidation');

test('a recovery_change bumps recovery AND every registry-dependent field together', () => {
  const before = {
    recovery: inv.versionOf('recovery'),
    effectiveWorkout: inv.versionOf('effectiveWorkout'),
    todayForecast: inv.versionOf('todayForecast'),
    recoveryComposite: inv.versionOf('recoveryComposite'),
    trainingOutcome: inv.versionOf('trainingOutcome'),
    wealth: inv.versionOf('wealth'),
  };
  const sv = inv.stateVersion();
  const res = inv.bump('recovery_change');

  // trainingOutcome is included: it dependsOn effectiveWorkout (see
  // registry.js), so a recovery change reaches it transitively —
  // effectiveWorkout -> trainingOutcome -> todayForecast.
  assert.deepEqual(res.fields.slice().sort(),
    ['effectiveWorkout', 'recovery', 'recoveryComposite', 'todayForecast', 'trainingOutcome']);
  assert.equal(inv.versionOf('recovery'), before.recovery + 1);
  assert.equal(inv.versionOf('effectiveWorkout'), before.effectiveWorkout + 1);
  assert.equal(inv.versionOf('todayForecast'), before.todayForecast + 1);
  assert.equal(inv.versionOf('recoveryComposite'), before.recoveryComposite + 1);
  assert.equal(inv.versionOf('trainingOutcome'), before.trainingOutcome + 1);
  // An unrelated field is untouched.
  assert.equal(inv.versionOf('wealth'), before.wealth);
  assert.equal(inv.stateVersion(), sv + 1);
});

test('a workout_override bumps effectiveWorkout + todayForecast + trainingOutcome (forecast/training-outcome assumption)', () => {
  const bw = inv.versionOf('effectiveWorkout'), bf = inv.versionOf('todayForecast'), bt = inv.versionOf('trainingOutcome');
  const res = inv.bump('workout_override');
  assert.deepEqual(res.fields.slice().sort(), ['effectiveWorkout', 'todayForecast', 'trainingOutcome']);
  assert.equal(inv.versionOf('effectiveWorkout'), bw + 1);
  assert.equal(inv.versionOf('todayForecast'), bf + 1);
  assert.equal(inv.versionOf('trainingOutcome'), bt + 1);
});

test('a transaction_sync bumps wealth only', () => {
  const b = inv.versionOf('wealth'), br = inv.versionOf('recovery');
  inv.bump('transaction_sync');
  assert.equal(inv.versionOf('wealth'), b + 1);
  assert.equal(inv.versionOf('recovery'), br); // untouched
});

test('registered listeners fire on invalidation of their field', () => {
  let fired = 0;
  inv.on('commitments', () => { fired += 1; });
  inv.bump('commitment_change');
  assert.equal(fired, 1);
  inv.bump('recovery_change'); // does not touch commitments
  assert.equal(fired, 1);
});

test('an unknown trigger is a no-op (no version churn)', () => {
  const sv = inv.stateVersion();
  const res = inv.bump('not_a_real_trigger');
  assert.deepEqual(res.fields, []);
  assert.equal(inv.stateVersion(), sv);
});

// Durable-store-backed coverage (bumpDurable() exactly-once persistence,
// rollback-causes-zero-invalidation) lives in
// test/integration/transactional-brain-invalidation.test.js — this file's
// test/*.test.js tier runs in CI BEFORE `npm run migrate`, so a test here
// that queries brain_state_version/annotations directly would hit tables
// that don't exist yet. Only test/integration/*.test.js is guaranteed to
// run against a migrated database (see test/integration/helpers.js).
