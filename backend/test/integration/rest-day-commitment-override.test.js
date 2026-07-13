// Bug: "In my morning brief I committed to a rest day. How come evening
// brief didn't pick that up on plan vs actual?" Root cause: committing to a
// rest day (via THE ACTION card's "Commit to something else" freeform box,
// or a manually-typed commitment) only ever wrote a commitments row. It never
// touched workout_overrides — the table swap_workout writes to, and the ONLY
// table getTodayWorkout()/the evening brief's plan-vs-actual grading actually
// reads for "today's plan". So the evening brief kept grading the day
// against the original scheduled session ("Planned Pull — not logged as
// done; the day's closed either way") even though the user told the app,
// that same morning, they were resting instead.
//
// Fixed by writing the rest-day intent through to workout_overrides at
// commit time (routes/commitments.js's applyRestDayCommitmentIfNeeded), the
// same upsert swap_workout performs — so every reader of "today's plan"
// agrees, not just the commitments list.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const { composeFallback } = require('../../src/notify/evening-brief');

const app = buildTestApp();
const TAG = `rest-day-commit-${Date.now()}`;
const TZ = process.env.TZ || 'America/New_York';
const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });

afterEach(async () => {
  await db.query(`DELETE FROM workout_overrides WHERE log_date = $1`, [today]);
  await db.query(`DELETE FROM commitments WHERE title LIKE $1`, [`%${TAG}%`]);
});
after(async () => { await closeDb(); });

test('committing to a rest day via THE ACTION writes through to workout_overrides', async () => {
  const res = await request(app)
    .post('/api/briefing/action/commit')
    .set(authHeader())
    .send({ text: `Full rest day today ${TAG}` })
    .timeout(10000);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const { rows } = await db.query(`SELECT workout_id FROM workout_overrides WHERE log_date = $1`, [today]);
  assert.equal(rows.length, 1, 'the commit should have upserted a workout_overrides row for today');
  assert.equal(rows[0].workout_id, 'rest');
});

test('manually adding a rest-day commitment also writes through to workout_overrides', async () => {
  const res = await request(app)
    .post('/api/commitments')
    .set(authHeader())
    .send({ title: `Taking a rest day ${TAG}` })
    .timeout(10000);
  assert.equal(res.status, 200);

  const { rows } = await db.query(`SELECT workout_id FROM workout_overrides WHERE log_date = $1`, [today]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workout_id, 'rest');
});

test('a commitment unrelated to rest does NOT write a workout override', async () => {
  const res = await request(app)
    .post('/api/briefing/action/commit')
    .set(authHeader())
    .send({ text: `Do the Zone 2 incline walk at an easy pace ${TAG}` })
    .timeout(10000);
  assert.equal(res.status, 200);

  const { rows } = await db.query(`SELECT workout_id FROM workout_overrides WHERE log_date = $1`, [today]);
  assert.equal(rows.length, 0, 'an unrelated commitment must not touch the workout plan');
});

test('end-to-end: after committing to a rest day, the evening brief plan-vs-actual no longer misreports the original scheduled session', async () => {
  // Simulate the exact scenario from the report: today's static schedule
  // would otherwise be a training day (e.g. "Pull"), but the user committed
  // to rest this morning.
  await request(app)
    .post('/api/briefing/action/commit')
    .set(authHeader())
    .send({ text: `Rest day — HRV was down ${TAG}` })
    .timeout(10000);

  const { rows } = await db.query(`SELECT workout_id FROM workout_overrides WHERE log_date = $1`, [today]);
  assert.equal(rows[0].workout_id, 'rest');

  // Mirror evening-brief.js's own override-read logic (runEveningHealthBrief,
  // lines ~272-288) rather than re-running the whole scheduled job.
  const OVERRIDE_LABELS = { push: 'Push', pull: 'Pull', zone2: 'Zone 2', mobility: 'Mobility', intervals: 'Intervals', rest: 'Rest' };
  const overrideId = rows[0]?.workout_id ?? null;
  const plannedLabel = OVERRIDE_LABELS[overrideId] ?? overrideId;
  const isRestDay = overrideId === 'rest';
  assert.equal(plannedLabel, 'Rest', 'the override must resolve to Rest, not the underlying static-schedule day');
  assert.ok(isRestDay);

  // composeFallback's deterministic plan-vs-actual line only fires a
  // "Planned X — not logged as done" grade for a non-rest planned session —
  // on a genuine rest day there is nothing to grade as missed.
  const { plan } = composeFallback({
    autonomic: { hrv: 50, hrvBaseline: 50, rhr: 60, rhrBaseline: 60, tone: 'settled', sampleThin: false },
    load: { steps: 4501, stepsBaseline: 10495 },
    openHabits: [],
    isRestDay,
    training: { planned: plannedLabel, completed: false, actual: null },
  });
  assert.equal(plan, '', 'a genuine rest day must not be graded as a missed "Planned Pull" session');
});
