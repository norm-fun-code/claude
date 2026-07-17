// Requirement #3: "Use scheduled workout anyway" (and any manual swap) must
// PERSIST through the backend override API — not live only in mobile React
// state — so every backend consumer of "today's effective workout"
// (getEffectiveWorkout → brief, forecast, realtime voice, evening review, the
// central snapshot's canonical facts) sees the same choice. This drives the
// real Express route against the real DB, then reads the effective workout back
// through the canonical selector the way each surface does.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const { getEffectiveWorkout } = require('../../src/services/workout');
const { canonicalFactsFrom } = require('../../src/brain/snapshot');

const app = buildTestApp();
const TZ = 'America/New_York';
// A fixed date + a noon-ET instant that resolves to that same local day, so the
// override row (keyed by log_date) and getEffectiveWorkout's day agree
// regardless of the process timezone.
const DATE = '2026-03-18';
const ASOF = new Date('2026-03-18T16:00:00.000Z'); // noon EDT

test.after(async () => {
  await db.query('DELETE FROM workout_overrides WHERE log_date = $1', [DATE]);
  await closeDb();
});

test('persisting a workout override makes getEffectiveWorkout return source=override for every consumer', async () => {
  // Start clean.
  await db.query('DELETE FROM workout_overrides WHERE log_date = $1', [DATE]);

  // "Use scheduled workout anyway" persists the scheduled id as an override.
  // Use an unambiguous id ('rest') so we can assert on it deterministically.
  const post = await request(app)
    .post('/api/workout/override')
    .set(authHeader())
    .send({ date: DATE, workoutId: 'rest' });
  assert.equal(post.status, 200);
  assert.equal(post.body.workoutId, 'rest');

  // The GET the mobile client reads on load reflects it.
  const get = await request(app)
    .get('/api/workout/overrides')
    .query({ from: DATE, to: DATE })
    .set(authHeader());
  assert.equal(get.status, 200);
  assert.equal(get.body.overrides[DATE], 'rest');

  // The canonical selector — the ONE the brief, forecast, realtime, and evening
  // review all call — now returns the override, not the schedule.
  const eff = await getEffectiveWorkout({ asOf: ASOF, tz: TZ });
  assert.equal(eff.source, 'override');
  assert.equal(eff.workoutId, 'rest');

  // And the central snapshot's canonical facts (what Ask/realtime/brief validate
  // against) reflect the same override — no surface re-deriving the schedule.
  const facts = canonicalFactsFrom({ effectiveWorkout: eff, localDate: DATE });
  assert.equal(facts.effectiveWorkoutSource, 'override');
  assert.equal(facts.effectiveWorkoutLabel, eff.label);
});

test('clearing the override (workoutId null) reverts every consumer to the resolved schedule', async () => {
  await request(app).post('/api/workout/override').set(authHeader()).send({ date: DATE, workoutId: 'rest' });
  const del = await request(app).post('/api/workout/override').set(authHeader()).send({ date: DATE, workoutId: null });
  assert.equal(del.status, 200);

  const eff = await getEffectiveWorkout({ asOf: ASOF, tz: TZ, band: 'green' });
  assert.notEqual(eff.source, 'override', 'override removed → back to auto_downgrade/scheduled');
});
