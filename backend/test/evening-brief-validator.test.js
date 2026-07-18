// Regression tests for the evening brief's deterministic post-generation
// guard (notify/evening-brief-validator.js) — the third independent layer of
// defense (deterministic fallback + prompt instructions + this guard) against
// the LLM prose pass conflating a rest day with low steps, calling steps a
// hard workout, or treating a free tomorrow as sleep-loosening permission.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateEveningBriefClaims,
  neutralizeEveningBriefViolations,
  checkRestDayStepsMislabeled,
  checkStepsDescribedAsWorkout,
  checkDayOffUsedAsSleepPermission,
} = require('../src/notify/evening-brief-validator');

// ── Rest day + steps mislabeled as light/low ─────────────────────────────────

test('rest day + steps ABOVE baseline described as light/low: flagged', () => {
  const facts = { isRestDay: true, load: { steps: 11842, stepsBaseline: 9000 } };
  const v = checkRestDayStepsMislabeled(
    [['today', 'You logged light steps today on your scheduled rest day.']],
    facts
  );
  assert.equal(v.length, 1);
  assert.equal(v[0].check, 'rest_day_steps_mislabeled');
});

test('rest day + steps BELOW baseline described as low: NOT flagged (accurate)', () => {
  const facts = { isRestDay: true, load: { steps: 3000, stepsBaseline: 9000 } };
  const v = checkRestDayStepsMislabeled(
    [['today', 'You logged low steps today on your scheduled rest day.']],
    facts
  );
  assert.equal(v.length, 0);
});

test('rest day + MISSING step baseline described as light: flagged (no baseline never justifies "light")', () => {
  const facts = { isRestDay: true, load: { steps: 8000, stepsBaseline: null } };
  const v = checkRestDayStepsMislabeled(
    [['today', 'A lighter day of steps on your scheduled rest day.']],
    facts
  );
  assert.equal(v.length, 1);
});

test('training day (not a rest day) with low-steps language: never flagged by this check', () => {
  const facts = { isRestDay: false, load: { steps: 3000, stepsBaseline: 9000 } };
  const v = checkRestDayStepsMislabeled(
    [['today', 'Low steps today compared to your norm.']],
    facts
  );
  assert.equal(v.length, 0); // this check only fires in rest-day context sentences
});

// ── Steps described as a hard workout ────────────────────────────────────────

test('steps/movement described as a hard workout when nothing was logged: flagged', () => {
  const facts = { training: { completed: false } };
  const v = checkStepsDescribedAsWorkout([['plan', 'You crushed a workout today with those steps.']], facts);
  assert.equal(v.length, 1);
  assert.equal(v[0].check, 'steps_described_as_workout');
});

test('a genuinely completed training session may be called a hard workout: not flagged', () => {
  const facts = { training: { completed: true } };
  const v = checkStepsDescribedAsWorkout([['plan', 'You crushed a hard workout today.']], facts);
  assert.equal(v.length, 0);
});

// ── Day off used as permission to shorten sleep ──────────────────────────────

test('day off tomorrow cited as reason for more room tonight: flagged', () => {
  const v = checkDayOffUsedAsSleepPermission([['tomorrow', 'Tomorrow is a day off so there is more room tonight.']]);
  assert.equal(v.length, 1);
  assert.equal(v[0].check, 'dayoff_sleep_permission');
});

test('day off acknowledged FACTUALLY alongside real wind-down advice: not flagged', () => {
  const v = checkDayOffUsedAsSleepPermission([
    ['tomorrow', 'Tomorrow is a day off, but you are still carrying a sleep deficit — protect the wind-down anyway.'],
  ]);
  assert.equal(v.length, 0);
});

test('genuinely late explicit user plans acknowledged without endorsing: not flagged', () => {
  // The user told the evening brief they're out late tonight for a real reason
  // (see dayContext in buildPrompt) — the brief may name the tradeoff honestly
  // without using it, or a free tomorrow, to say reduced sleep is fine.
  const v = checkDayOffUsedAsSleepPermission([
    ['tomorrow', "Since you're out late tonight, get down as soon as you're back — the debt still adds up."],
  ]);
  assert.equal(v.length, 0);
});

// ── Full validate + neutralize round trip ────────────────────────────────────

test('validateEveningBriefClaims catches a multi-field violation and neutralize replaces only the offending fields', () => {
  const facts = { isRestDay: true, load: { steps: 11842, stepsBaseline: 9000 }, training: { completed: false } };
  const result = {
    today: 'Light steps today on your scheduled rest day.',
    plan: 'A perfectly graded day.',
    tomorrow: 'Tomorrow is a day off so there is more room tonight.',
    readiness: 'Settled and steady.',
  };
  const violations = validateEveningBriefClaims(result, facts);
  assert.equal(violations.length, 2); // today + tomorrow, NOT plan/readiness

  const fallback = { today: 'FALLBACK TODAY', plan: 'FALLBACK PLAN', tomorrow: 'FALLBACK TOMORROW', readiness: 'FALLBACK READINESS' };
  const neutralized = neutralizeEveningBriefViolations(result, violations, fallback);
  assert.equal(neutralized.today, 'FALLBACK TODAY');
  assert.equal(neutralized.tomorrow, 'FALLBACK TOMORROW');
  assert.equal(neutralized.plan, 'A perfectly graded day.'); // untouched
  assert.equal(neutralized.readiness, 'Settled and steady.'); // untouched
});

test('a clean result produces zero violations and neutralize is a no-op', () => {
  const facts = { isRestDay: true, load: { steps: 11842, stepsBaseline: 9000 }, training: { completed: false } };
  const result = {
    today: 'You still logged 11,842 steps on a scheduled rest day — plenty of movement without adding structured training stress.',
    plan: 'No session was planned today; the rest day did its job.',
    tomorrow: "Tomorrow's a day off, but hold the bedtime window anyway — the wind-down still pays off.",
    readiness: 'Settled and steady.',
  };
  const violations = validateEveningBriefClaims(result, facts);
  assert.equal(violations.length, 0);
  assert.deepEqual(neutralizeEveningBriefViolations(result, violations, {}), result);
});
