// Today command-center cleanup — Part 1 ("eliminate plan contradictions").
// Regression scenarios #1 and #2 from the required list:
//   1. Scheduled Pull cannot coexist with an authoritative "rest day" headline.
//   2. An explicit rest override suppresses the Pull recommendation.
// Exercises the REAL production checks in brain/claimValidator.js (wired
// into validateClaims, so every chief-brief generation attempt runs through
// them) — no source-string assertions, no logic-bypassing mocks.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkRestFramingAgainstEffectiveWorkout,
  checkHardWorkoutAgainstRestOverride,
  findPlanConflict,
  validateClaims,
} = require('../src/brain/claimValidator');

test('scenario 1 — a scheduled Pull day cannot coexist with a "rest day" headline: checkRestFramingAgainstEffectiveWorkout flags it', () => {
  const fields = [
    ['synthesis', 'A real rest day — recovery is green and the calendar is quiet, so lean into family time.'],
    ['action', 'Pull day (~45 min) is on deck — get after it this morning.'],
  ];
  const facts = { effectiveWorkoutLabel: 'Pull', effectiveWorkoutSource: 'scheduled', scheduledWorkoutLabel: null };
  const violations = checkRestFramingAgainstEffectiveWorkout(fields, facts);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].check, 'rest_framing_vs_effective_workout');
  assert.equal(violations[0].field, 'synthesis');
  assert.equal(violations[0].severity, 'high');
});

test('scenario 1b — the SAME check is wired into the shared validateClaims pipeline every chief-brief attempt runs through', () => {
  const fields = [['synthesis', 'Today is a full rest day, so take it easy.']];
  const facts = { effectiveWorkoutLabel: 'Intervals', effectiveWorkoutSource: 'scheduled' };
  const violations = validateClaims(fields, facts);
  assert.ok(violations.some((v) => v.check === 'rest_framing_vs_effective_workout'));
});

test('scenario 1c — a genuine rest day (effectiveWorkoutLabel Rest) never trips the check', () => {
  const fields = [['synthesis', 'A real rest day today — recovery is green, enjoy it.']];
  const facts = { effectiveWorkoutLabel: 'Rest', effectiveWorkoutSource: 'scheduled' };
  assert.deepEqual(checkRestFramingAgainstEffectiveWorkout(fields, facts), []);
});

test('scenario 1d — ordinary "Recovery + Mobility" framing never false-positives (distinct label from "rest")', () => {
  const fields = [['synthesis', 'Recovery is green at 88 today — a solid mobility session on tap.']];
  const facts = { effectiveWorkoutLabel: 'Recovery + Mobility', effectiveWorkoutSource: 'scheduled' };
  assert.deepEqual(checkRestFramingAgainstEffectiveWorkout(fields, facts), []);
});

test('scenario 2 — an explicit rest override suppresses a Pull recommendation: checkHardWorkoutAgainstRestOverride flags it', () => {
  const fields = [['action', 'Pull day (~45 min) is on deck — get after it this morning.']];
  const facts = { effectiveWorkoutSource: 'override', effectiveWorkoutLabel: 'Rest', scheduledWorkoutLabel: 'Pull' };
  const violations = checkHardWorkoutAgainstRestOverride(fields, facts);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].check, 'hard_workout_vs_rest_override');
});

test('scenario 2b — a sentence that acknowledges the rest override does not trip the check', () => {
  const fields = [['action', 'Pull was scheduled, but today is marked as rest — take the day off from training.']];
  const facts = { effectiveWorkoutSource: 'override', effectiveWorkoutLabel: 'Rest', scheduledWorkoutLabel: 'Pull' };
  assert.deepEqual(checkHardWorkoutAgainstRestOverride(fields, facts), []);
});

test('scenario 2c — a non-override rest day (auto_downgrade or scheduled Rest) never trips this check', () => {
  const fields = [['action', 'Pull day is on deck.']];
  const facts = { effectiveWorkoutSource: 'scheduled', effectiveWorkoutLabel: 'Rest', scheduledWorkoutLabel: 'Rest' };
  assert.deepEqual(checkHardWorkoutAgainstRestOverride(fields, facts), []);
});

test('findPlanConflict — defense-in-depth guard used by todayCommandCenter.js returns the rest_vs_workout resolution shape', () => {
  const chiefBrief = {
    synthesis: 'A real rest day — recovery is green, lean into family time.',
    action: 'Pull day (~45 min) is on deck.', risk: 'Nothing acute today.', move: 'No major change.',
  };
  const conflict = findPlanConflict(chiefBrief, { label: 'Pull', source: 'scheduled', workoutId: 'pull' });
  assert.equal(conflict.direction, 'rest_vs_workout');
  assert.equal(conflict.options.length, 2);
  assert.deepEqual(conflict.options.map((o) => o.workoutId), ['rest', 'pull']);
});

test('findPlanConflict — the workout_vs_rest direction for an explicit override', () => {
  const chiefBrief = { synthesis: 'Recovery is green today.', action: 'Pull day (~45 min) is on deck.', risk: 'Nothing acute.', move: 'No change.' };
  const conflict = findPlanConflict(chiefBrief, { label: 'Rest', source: 'override', scheduledLabel: 'Pull', scheduledWorkoutId: 'pull' });
  assert.equal(conflict.direction, 'workout_vs_rest');
  assert.deepEqual(conflict.options.map((o) => o.workoutId), ['rest', 'pull']);
});

test('findPlanConflict — no conflict when the plan is internally consistent', () => {
  const chiefBrief = { synthesis: 'Recovery is green today.', action: 'Pull day (~45 min) is on deck.', risk: 'Nothing acute.', move: 'No change.' };
  assert.equal(findPlanConflict(chiefBrief, { label: 'Pull', source: 'scheduled', workoutId: 'pull' }), null);
});

test('findPlanConflict — null chiefBrief or null effectiveWorkout never throws', () => {
  assert.equal(findPlanConflict(null, { label: 'Pull' }), null);
  assert.equal(findPlanConflict({ synthesis: 's' }, null), null);
  assert.equal(findPlanConflict({ synthesis: 's' }, {}), null);
});
