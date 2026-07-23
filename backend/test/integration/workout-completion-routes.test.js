// Requirement: dedicated read/write APIs for explicit workout-level
// completion (workout_completions), and the durable invalidation chain
// (activity create/delete, workout-completion mutations) that makes
// trainingOutcome/todayForecast never silently serve stale evidence after
// one of them changes. Mirrors workout-override-persistence.test.js's style.
const test = require('node:test');
const { afterEach, after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const invalidation = require('../../src/brain/invalidation');
const { resolveTrainingOutcome, getEffectiveWorkout } = require('../../src/services/workout');
const { invalidationSet } = require('../../src/brain/registry');

const app = buildTestApp();
const TZ = 'America/New_York';
const DATE = '2026-03-18';
const ASOF = new Date('2026-03-18T16:00:00.000Z'); // noon EDT

async function cleanup() {
  await db.query('DELETE FROM workout_completions WHERE log_date = $1', [DATE]);
  await db.query('DELETE FROM activity_logs WHERE log_date = $1', [DATE]);
  await db.query('DELETE FROM workout_overrides WHERE log_date = $1', [DATE]);
  await db.query(
    `DELETE FROM metrics WHERE domain = 'habits' AND metric = 'exercise' AND (ts AT TIME ZONE $1)::date = $2::date`,
    [TZ, DATE]
  );
  // The POST /api/habits tests below write real TODAY's-date exercise/
  // gratitude rows (mapHabits defaults ts to now(), source 'habits' — see
  // ingest/habits.js) — clean those up too, or they pollute any other
  // integration test that reads today's habit rate (e.g.
  // consolidate-gather-parallel.test.js's gatherHabits assertions). Scoped
  // to source='habits' specifically so this never touches another test
  // file's own distinctly-sourced fixture rows for the same metric/day.
  await db.query(
    `DELETE FROM metrics WHERE domain = 'habits' AND metric IN ('exercise', 'gratitude') AND source = 'habits'
       AND (ts AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [TZ]
  );
}
afterEach(cleanup);
after(async () => { await cleanup(); await closeDb(); });

test('POST /api/workout/completion marks the workout complete; GET /api/workout/completions reflects it', async () => {
  const post = await request(app).post('/api/workout/completion').set(authHeader()).send({ date: DATE, workoutId: 'intervals' });
  assert.equal(post.status, 200);
  assert.equal(post.body.workoutId, 'intervals');
  assert.equal(post.body.source, 'manual');

  const get = await request(app).get('/api/workout/completions').query({ from: DATE, to: DATE }).set(authHeader());
  assert.equal(get.status, 200);
  assert.equal(get.body.completions[DATE].workoutId, 'intervals');
  assert.equal(get.body.completions[DATE].source, 'manual');
  assert.ok(get.body.completions[DATE].completedAt);
});

test('Health completion state remains false after logging an unrelated walk, and after "reopening the app" (a fresh GET)', async () => {
  await request(app).post('/api/activity').set(authHeader()).send({ date: DATE, activity_type: 'walk', label: 'Walk', duration_min: 60 });

  // "Reopening the app" == a fresh GET, exactly like the mobile hydration effect.
  const get = await request(app).get('/api/workout/completions').query({ from: DATE, to: DATE }).set(authHeader());
  assert.equal(get.status, 200);
  assert.equal(get.body.completions[DATE], undefined, 'no explicit completion record exists — a logged walk must never create one');
});

test('unmarking (workoutId: null) removes the completion record', async () => {
  await request(app).post('/api/workout/completion').set(authHeader()).send({ date: DATE, workoutId: 'intervals' });
  const unmark = await request(app).post('/api/workout/completion').set(authHeader()).send({ date: DATE, workoutId: null });
  assert.equal(unmark.status, 200);
  assert.equal(unmark.body.workoutId, null);

  const get = await request(app).get('/api/workout/completions').query({ from: DATE, to: DATE }).set(authHeader());
  assert.equal(get.body.completions[DATE], undefined);
});

test('POST /api/workout/completion rejects an invalid workoutId', async () => {
  const res = await request(app).post('/api/workout/completion').set(authHeader()).send({ date: DATE, workoutId: 'not_a_real_workout' });
  assert.equal(res.status, 400);
});

test('a workout-completion mutation durably invalidates trainingOutcome and transitively todayForecast, exactly once each', async () => {
  const before = { training: invalidation.versionOf('trainingOutcome'), forecast: invalidation.versionOf('todayForecast') };
  const post = await request(app).post('/api/workout/completion').set(authHeader()).send({ date: DATE, workoutId: 'intervals' });
  assert.equal(post.status, 200);
  assert.equal(invalidation.versionOf('trainingOutcome'), before.training + 1, 'exactly one bump, not more');
  assert.equal(invalidation.versionOf('todayForecast'), before.forecast + 1, 'exactly one bump, not more');

  // The registry-declared invalidation set itself is deduplicated — asserting
  // this directly locks in the "exactly once" guarantee independent of the
  // route (a Set can never list the same field twice no matter how many
  // dependency paths reach it).
  const fields = invalidationSet('training_change');
  assert.equal(fields.filter((f) => f === 'trainingOutcome').length, 1);
  assert.equal(fields.filter((f) => f === 'todayForecast').length, 1);
});

test('POST /api/activity durably invalidates trainingOutcome/todayForecast', async () => {
  const before = { training: invalidation.versionOf('trainingOutcome'), forecast: invalidation.versionOf('todayForecast') };
  const post = await request(app).post('/api/activity').set(authHeader()).send({ date: DATE, activity_type: 'walk', label: 'Walk', duration_min: 45 });
  assert.equal(post.status, 200);
  assert.ok(invalidation.versionOf('trainingOutcome') > before.training);
  assert.ok(invalidation.versionOf('todayForecast') > before.forecast);
});

test('DELETE /api/activity/:id durably invalidates trainingOutcome/todayForecast — and unmarking/deleting recomputes the outcome correctly', async () => {
  // Force the effective workout deterministically (regardless of which real
  // weekday DATE falls on) so activity_type: 'intervals' is guaranteed to
  // match it.
  await request(app).post('/api/workout/override').set(authHeader()).send({ date: DATE, workoutId: 'intervals' });
  const effective = await getEffectiveWorkout({ asOf: ASOF, tz: TZ });
  assert.equal(effective.workoutId, 'intervals');

  const post = await request(app).post('/api/activity').set(authHeader()).send({ date: DATE, activity_type: 'intervals', label: 'Intervals' });
  const id = post.body.activity.id;

  // Logging the matching activity implicitly completed the effective workout.
  const beforeDelete = await resolveTrainingOutcome({ asOf: ASOF, tz: TZ, effectiveWorkout: effective });
  assert.equal(beforeDelete.plannedWorkoutCompleted, true);

  const before = { training: invalidation.versionOf('trainingOutcome'), forecast: invalidation.versionOf('todayForecast') };
  const del = await request(app).delete(`/api/activity/${id}`).set(authHeader());
  assert.equal(del.status, 200);
  assert.ok(invalidation.versionOf('trainingOutcome') > before.training);
  assert.ok(invalidation.versionOf('todayForecast') > before.forecast);

  const afterDelete = await resolveTrainingOutcome({ asOf: ASOF, tz: TZ, effectiveWorkout: effective });
  assert.equal(afterDelete.plannedWorkoutCompleted, false, 'deleting the only evidence must recompute completion to false');
});

test('POST /api/habits with exercise durably invalidates trainingOutcome when exercise is part of the write', async () => {
  const before = invalidation.versionOf('trainingOutcome');
  const res = await request(app).post('/api/habits').set(authHeader()).send({ exercise: true });
  assert.equal(res.status, 200);
  assert.ok(invalidation.versionOf('trainingOutcome') > before);
});

test('POST /api/habits WITHOUT exercise does not bump trainingOutcome', async () => {
  const before = invalidation.versionOf('trainingOutcome');
  const res = await request(app).post('/api/habits').set(authHeader()).send({ gratitude: true });
  assert.equal(res.status, 200);
  assert.equal(invalidation.versionOf('trainingOutcome'), before, 'an unrelated habit write must not churn trainingOutcome\'s version');
});
