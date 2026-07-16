// Bug: predict.js's tomorrow forecast inferred "today's hard session" from
// active_energy > 1.3x the 30-day mean, with no notion of what today's plan
// actually WAS or whether a hard session was explicitly completed. These
// tests cover the pure classification pieces the fix relies on: mapping a
// scheduled plan's free-text `type` and a manual override's workoutId onto
// the SAME hard/not-hard vocabulary, so both are judged identically.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isHardWorkoutId, isHardWorkoutType, workoutIdForPlanType, getWorkout, autoDowngradeFor,
} = require('../src/services/workout');

test('Rest and Recovery + Mobility are never hard', () => {
  assert.equal(isHardWorkoutId('rest'), false);
  assert.equal(isHardWorkoutId('mobility'), false);
  assert.equal(isHardWorkoutType('Rest'), false);
  assert.equal(isHardWorkoutType('Recovery + Mobility'), false);
});

test('Zone 2 is not hard', () => {
  assert.equal(isHardWorkoutId('zone2'), false);
  assert.equal(isHardWorkoutType('Zone 2 — Incline Walk or Jog'), false);
});

test('Intervals, Push, and Pull are hard', () => {
  for (const id of ['intervals', 'push', 'pull']) {
    assert.equal(isHardWorkoutId(id), true, `${id} should be hard`);
  }
  assert.equal(isHardWorkoutType('4×4 Intervals'), true);
  assert.equal(isHardWorkoutType('Push'), true);
  assert.equal(isHardWorkoutType('Pull'), true);
});

test('isHardWorkoutId is case-insensitive and null-safe', () => {
  assert.equal(isHardWorkoutId('PUSH'), true);
  assert.equal(isHardWorkoutId(null), false);
  assert.equal(isHardWorkoutId(undefined), false);
  assert.equal(isHardWorkoutId(''), false);
});

test('workoutIdForPlanType maps every day of the actual weekly plan onto the manual-override vocabulary', () => {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const expected = {
    Monday: 'zone2', Tuesday: 'mobility', Wednesday: 'intervals', Thursday: 'push',
    Friday: 'rest', Saturday: 'zone2', Sunday: 'pull',
  };
  for (const day of days) {
    const w = getWorkout(day);
    assert.equal(workoutIdForPlanType(w.type), expected[day], `${day} (${w.type}) should map to ${expected[day]}`);
  }
});

test('the full weekly plan classifies exactly the days the bug report cares about', () => {
  // The exact reproduction: Tuesday is Recovery + Mobility — not hard.
  assert.equal(isHardWorkoutType(getWorkout('Tuesday').type), false);
  // Wednesday/Thursday/Sunday ARE hard sessions.
  assert.equal(isHardWorkoutType(getWorkout('Wednesday').type), true);
  assert.equal(isHardWorkoutType(getWorkout('Thursday').type), true);
  assert.equal(isHardWorkoutType(getWorkout('Sunday').type), true);
});

// ── autoDowngradeFor: the recovery-based auto-swap ───────────────────────────
// Bug: red recovery auto-swapped today's Health-tab session to Mobility (same
// as the mobile client's getTodaysWorkout() zone logic), but the chief brief
// still described the ORIGINAL scheduled session ("scale back today's Push")
// with no idea a swap had already happened. autoDowngradeFor is the pure rule
// getEffectiveWorkout() now applies server-side, mirroring the mobile logic
// bit-for-bit so both surfaces agree.

test('red recovery always downgrades to Mobility, regardless of what was scheduled', () => {
  for (const scheduled of ['push', 'pull', 'zone2', 'mobility', 'rest', 'intervals']) {
    assert.equal(autoDowngradeFor(scheduled, 'red'), 'mobility', `${scheduled} + red should downgrade to mobility`);
  }
});

test('yellow recovery downgrades a scheduled Pull to Zone 2, and nothing else', () => {
  assert.equal(autoDowngradeFor('pull', 'yellow'), 'zone2');
  for (const scheduled of ['push', 'zone2', 'mobility', 'rest', 'intervals']) {
    assert.equal(autoDowngradeFor(scheduled, 'yellow'), null, `${scheduled} + yellow should NOT downgrade`);
  }
});

test('green, unknown, or missing band never downgrades anything', () => {
  for (const scheduled of ['push', 'pull', 'zone2', 'mobility', 'rest', 'intervals']) {
    assert.equal(autoDowngradeFor(scheduled, 'green'), null);
    assert.equal(autoDowngradeFor(scheduled, 'unknown'), null);
    assert.equal(autoDowngradeFor(scheduled, null), null);
    assert.equal(autoDowngradeFor(scheduled, undefined), null);
  }
});

test('the exact reproduction: a scheduled Push on a red-recovery day downgrades to Mobility', () => {
  assert.equal(autoDowngradeFor('push', 'red'), 'mobility');
});
