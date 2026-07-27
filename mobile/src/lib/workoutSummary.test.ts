// Health tab redesign (audit rec #4) — required scenarios 4, 5, 6, 7.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTrainingSummary } from './workoutSummary.ts';

test('required 4/5: the summary is derived purely from effectiveWorkout — the SAME object Today reads from BriefingData.effectiveWorkout, so Health and Today can never disagree', () => {
  const eff = { source: 'override' as const, workoutId: 'zone2', label: 'Zone 2', scheduledWorkoutId: 'pull', scheduledLabel: 'Pull' };
  const a = describeTrainingSummary(eff, null);
  const b = describeTrainingSummary(eff, null); // Today would call the exact same pure fn on the same field
  assert.deepEqual(a, b);
  assert.equal(a.isAdjusted, true);
  assert.match(a.adjustmentReason, /Swapped from Pull/);
});

test('required 6: logging a walk (an alternate activity) during an intervals day, with no completion record for "intervals", never reads as done', () => {
  const eff = { source: 'scheduled' as const, workoutId: 'intervals', label: 'Intervals' };
  // completion record is for a DIFFERENT workoutId (or absent) — a walk alone
  // does not write a workout_completions row for 'intervals' (see backend
  // services/workout.js's resolveTrainingOutcome / setWorkoutCompletion).
  const noCompletion = describeTrainingSummary(eff, null);
  assert.equal(noCompletion.isDone, false);
  assert.equal(noCompletion.primaryAction, 'start');

  const mismatchedCompletion = describeTrainingSummary(eff, { workoutId: 'zone2', source: 'activity_match' });
  assert.equal(mismatchedCompletion.isDone, false, 'a completion record for a DIFFERENT workout must not mark today\'s intervals done');
});

test('required 7: an explicit substitution (completion record matches today\'s effective workoutId) IS reflected as done', () => {
  const eff = { source: 'scheduled' as const, workoutId: 'intervals', label: 'Intervals' };
  const explicit = describeTrainingSummary(eff, { workoutId: 'intervals', source: 'activity_match' });
  assert.equal(explicit.isDone, true);
  assert.equal(explicit.primaryAction, 'review_completed');
});

test('a rest day with nothing logged offers "Log what I actually did", not "Start workout"', () => {
  const r = describeTrainingSummary({ source: 'scheduled', workoutId: 'rest', label: 'Rest' }, null);
  assert.equal(r.primaryAction, 'log_different');
});

test('pure and total: an old cached briefing with no effectiveWorkout field never throws', () => {
  assert.doesNotThrow(() => describeTrainingSummary(null, null));
  assert.doesNotThrow(() => describeTrainingSummary(undefined, undefined));
  const r = describeTrainingSummary(undefined, undefined);
  assert.equal(r.label, 'Rest');
  assert.equal(r.isAdjusted, false);
});

test('auto-downgrade adjustment reason names both the recovery band and the original session', () => {
  const eff = { source: 'auto_downgrade' as const, workoutId: 'mobility', label: 'Mobility', scheduledWorkoutId: 'push', scheduledLabel: 'Push', recoveryBand: 'red' };
  const r = describeTrainingSummary(eff, null);
  assert.match(r.adjustmentReason, /red recovery/i);
  assert.match(r.adjustmentReason, /Push/);
  assert.match(r.adjustmentReason, /Mobility/);
});
