// Regression tests for the canonical training-outcome authority
// (services/workout.js's resolveTrainingOutcome) — the fix for the
// production bug where logging an unrelated activity (a walk) on a
// scheduled hard-workout day (Wednesday's 4x4 Intervals) got read as
// completing that scheduled session, because the only completion signal
// available was the generic Exercise habit boolean (proves SOME exercise
// happened, never WHICH workout or whether it was hard).
const test = require('node:test');
const { afterEach, after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const { resolveTrainingOutcome, isHardWorkoutId } = require('../../src/services/workout');

const TZ = process.env.TZ || 'America/New_York';
// July 15, 2026 is a Wednesday — the scheduled 4x4 Intervals day.
const WED_NOON = new Date('2026-07-15T16:00:00.000Z');
const WED_DATE = '2026-07-15';
const WED_EFFECTIVE = { source: 'scheduled', workoutId: 'intervals', label: '4×4 Intervals', isHard: true };

async function cleanup() {
  await db.query(`DELETE FROM workout_completions WHERE log_date = $1`, [WED_DATE]);
  await db.query(`DELETE FROM activity_logs WHERE log_date = $1`, [WED_DATE]);
  await db.query(
    `DELETE FROM metrics WHERE domain = 'habits' AND metric = 'exercise'
       AND (ts AT TIME ZONE $1)::date = $2::date`,
    [TZ, WED_DATE]
  );
}
afterEach(cleanup);
after(async () => { await cleanup(); await closeDb(); });

test('THE EXACT REPRODUCTION: Wednesday Intervals + a 60-minute walk => alternate_activity, not completed, not hard', async () => {
  await db.query(
    `INSERT INTO activity_logs (log_date, activity_type, label, duration_min) VALUES ($1, 'walk', 'Walk', 60)`,
    [WED_DATE]
  );
  await db.query(
    `INSERT INTO metrics (ts, domain, metric, value, unit, source) VALUES ($1, 'habits', 'exercise', 1, '', 'checkin')`,
    [`${WED_DATE}T20:00:00Z`]
  );
  const outcome = await resolveTrainingOutcome({ asOf: WED_NOON, tz: TZ, effectiveWorkout: WED_EFFECTIVE });
  assert.equal(outcome.exerciseHabitDone, true, 'the habit is genuinely true — some exercise occurred');
  assert.equal(outcome.plannedWorkoutCompleted, false, 'a walk is not evidence Intervals was completed');
  assert.equal(outcome.hardSessionCompleted, false, 'a walk is not a hard session');
  assert.equal(outcome.status, 'alternate_activity');
  assert.equal(outcome.plannedWorkoutId, 'intervals');
  assert.equal(outcome.plannedWorkoutLabel, '4×4 Intervals');
  assert.equal(outcome.actualActivities.length, 1);
  assert.equal(outcome.actualActivities[0].activityType, 'walk');
  assert.equal(outcome.actualActivities[0].durationMin, 60);
});

test('explicit Intervals completion (Mark Complete) => planned_completed, hard session completed', async () => {
  await db.query(`INSERT INTO workout_completions (log_date, workout_id, source) VALUES ($1, 'intervals', 'manual')`, [WED_DATE]);
  const outcome = await resolveTrainingOutcome({ asOf: WED_NOON, tz: TZ, effectiveWorkout: WED_EFFECTIVE });
  assert.equal(outcome.plannedWorkoutCompleted, true);
  assert.equal(outcome.hardSessionCompleted, true);
  assert.equal(outcome.status, 'planned_completed');
  assert.equal(outcome.completionSource, 'manual');
  assert.ok(outcome.completedAt);
});

test('explicitly logging an Intervals activity (no Mark Complete tap) is itself valid completion evidence', async () => {
  await db.query(`INSERT INTO activity_logs (log_date, activity_type, label) VALUES ($1, 'intervals', 'Intervals')`, [WED_DATE]);
  const outcome = await resolveTrainingOutcome({ asOf: WED_NOON, tz: TZ, effectiveWorkout: WED_EFFECTIVE });
  assert.equal(outcome.plannedWorkoutCompleted, true);
  assert.equal(outcome.hardSessionCompleted, true);
  assert.equal(outcome.completionSource, 'activity_match');
  assert.equal(outcome.status, 'planned_completed');
});

test('generic Exercise habit alone (no activity logged, no completion record) never identifies workout or intensity', async () => {
  await db.query(
    `INSERT INTO metrics (ts, domain, metric, value, unit, source) VALUES ($1, 'habits', 'exercise', 1, '', 'checkin')`,
    [`${WED_DATE}T20:00:00Z`]
  );
  const outcome = await resolveTrainingOutcome({ asOf: WED_NOON, tz: TZ, effectiveWorkout: WED_EFFECTIVE });
  assert.equal(outcome.exerciseHabitDone, true);
  assert.equal(outcome.plannedWorkoutCompleted, false);
  assert.equal(outcome.hardSessionCompleted, false, 'the generic habit must never turn a scheduled hard workout into a completed hard workout');
  assert.equal(outcome.status, 'generic_exercise_only');
  assert.deepEqual(outcome.actualActivities, []);
});

test('mixed: explicit Intervals completion PLUS an additional walk => status mixed, Intervals still complete, walk still shown', async () => {
  await db.query(`INSERT INTO workout_completions (log_date, workout_id, source) VALUES ($1, 'intervals', 'manual')`, [WED_DATE]);
  await db.query(`INSERT INTO activity_logs (log_date, activity_type, label, duration_min) VALUES ($1, 'walk', 'Walk', 30)`, [WED_DATE]);
  const outcome = await resolveTrainingOutcome({ asOf: WED_NOON, tz: TZ, effectiveWorkout: WED_EFFECTIVE });
  assert.equal(outcome.status, 'mixed');
  assert.equal(outcome.plannedWorkoutCompleted, true);
  assert.equal(outcome.hardSessionCompleted, true);
  assert.equal(outcome.actualActivities.length, 1, 'the walk is still recorded in actualActivities');
  assert.equal(outcome.actualActivities[0].activityType, 'walk');
});

test('mixed via activity_match: logging Intervals AND a separate walk both count, walk never conflated with Intervals', async () => {
  await db.query(`INSERT INTO activity_logs (log_date, activity_type, label) VALUES ($1, 'intervals', 'Intervals')`, [WED_DATE]);
  await db.query(`INSERT INTO activity_logs (log_date, activity_type, label, duration_min) VALUES ($1, 'walk', 'Walk', 20)`, [WED_DATE]);
  const outcome = await resolveTrainingOutcome({ asOf: WED_NOON, tz: TZ, effectiveWorkout: WED_EFFECTIVE });
  assert.equal(outcome.status, 'mixed');
  assert.equal(outcome.plannedWorkoutCompleted, true);
  assert.equal(outcome.completionSource, 'activity_match');
  assert.equal(outcome.actualActivities.length, 2);
});

test('none: nothing logged, no habit, effective plan is rest', async () => {
  const REST_EFFECTIVE = { source: 'scheduled', workoutId: 'rest', label: 'Rest', isHard: false };
  const outcome = await resolveTrainingOutcome({ asOf: WED_NOON, tz: TZ, effectiveWorkout: REST_EFFECTIVE });
  assert.equal(outcome.status, 'none');
  assert.equal(outcome.plannedWorkoutCompleted, false);
  assert.equal(outcome.hardSessionCompleted, false);
});

test('planned_only: a non-rest workout is scheduled but nothing has happened yet', async () => {
  const outcome = await resolveTrainingOutcome({ asOf: WED_NOON, tz: TZ, effectiveWorkout: WED_EFFECTIVE });
  assert.equal(outcome.status, 'planned_only');
  assert.equal(outcome.plannedWorkoutCompleted, false);
  assert.equal(outcome.exerciseHabitDone, false);
});

test('workout overrides/recovery downgrades: a completion recorded for the ORIGINAL scheduled workout does not satisfy a DIFFERENT effective workout', async () => {
  // The completion was recorded against 'intervals', but the effective
  // workout for this date has SINCE changed (e.g. a recovery downgrade
  // landed after the mark, or the day was swapped) to 'mobility'.
  await db.query(`INSERT INTO workout_completions (log_date, workout_id, source) VALUES ($1, 'intervals', 'manual')`, [WED_DATE]);
  const DOWNGRADED = { source: 'auto_downgrade', workoutId: 'mobility', label: 'Mobility', isHard: false, scheduledWorkoutId: 'intervals' };
  const outcome = await resolveTrainingOutcome({ asOf: WED_NOON, tz: TZ, effectiveWorkout: DOWNGRADED });
  assert.equal(outcome.plannedWorkoutCompleted, false, 'a completion for a DIFFERENT workout id must not satisfy the current effective workout');
  assert.equal(outcome.plannedWorkoutId, 'mobility');
});

test('a completion matching the CURRENT effective workout (after an override) is honored', async () => {
  await db.query(`INSERT INTO workout_completions (log_date, workout_id, source) VALUES ($1, 'zone2', 'manual')`, [WED_DATE]);
  const SWAPPED = { source: 'override', workoutId: 'zone2', label: 'Zone 2', isHard: false, scheduledWorkoutId: 'intervals' };
  const outcome = await resolveTrainingOutcome({ asOf: WED_NOON, tz: TZ, effectiveWorkout: SWAPPED });
  assert.equal(outcome.plannedWorkoutCompleted, true);
  assert.equal(outcome.hardSessionCompleted, false, 'Zone 2 is not hard, even though it was explicitly completed');
});

test('timezone boundary: an activity logged just after local midnight resolves against the correct day', async () => {
  const justAfterMidnight = new Date('2026-07-15T04:02:00.000Z'); // 12:02 AM EDT, July 15 (Wednesday)
  await db.query(`INSERT INTO activity_logs (log_date, activity_type, label) VALUES ($1, 'walk', 'Walk')`, [WED_DATE]);
  const outcome = await resolveTrainingOutcome({ asOf: justAfterMidnight, tz: TZ, effectiveWorkout: WED_EFFECTIVE });
  assert.equal(outcome.actualActivities.length, 1);
  assert.equal(outcome.status, 'alternate_activity');
});

test('self-resolves the effective workout when none is passed in', async () => {
  // No effectiveWorkout supplied — resolveTrainingOutcome must resolve it
  // itself via getEffectiveWorkout rather than throw or silently no-op.
  const outcome = await resolveTrainingOutcome({ asOf: WED_NOON, tz: TZ });
  assert.equal(outcome.plannedWorkoutId, 'intervals');
  assert.equal(outcome.plannedWorkoutLabel, '4×4 Intervals');
});

test('isHardWorkoutId sanity: walk is never hard, intervals/push/pull are', () => {
  assert.equal(isHardWorkoutId('walk'), false);
  assert.equal(isHardWorkoutId('intervals'), true);
  assert.equal(isHardWorkoutId('push'), true);
  assert.equal(isHardWorkoutId('pull'), true);
  assert.equal(isHardWorkoutId('zone2'), false);
});
