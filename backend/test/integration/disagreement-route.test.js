// Disagreement route against a real database — the resolution round-trip in
// particular, which is the half a unit test cannot reach.
//
// The engine's silences are covered in test/disagreement.test.js. What matters
// here is that answering the question actually sticks: resolve writes through
// dismissed_insights' `context` column, the next GET is quiet, and the stored
// count is the one the user was shown (so re-activation later measures from
// what they saw, not from a recomputation).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');

const app = buildTestApp();
const GOAL = `test-disagreement-${Date.now()}`;

/** Sunday keys going back from a fixed recent week. */
function sundays(n) {
  const out = [];
  const d = new Date('2026-09-06T12:00:00Z');
  for (let i = 0; i < n; i++) out.push(new Date(d.getTime() - i * 7 * 864e5).toISOString().slice(0, 10));
  return out;
}

after(async () => {
  await db.query(`DELETE FROM weekly_intentions WHERE goals::text LIKE $1`, [`%${GOAL}%`]);
  await db.query(`DELETE FROM dismissed_insights WHERE dismiss_key LIKE 'disagreement:%'`);
  await closeDb();
});

test('GET /api/disagreement requires auth', async () => {
  assert.equal((await request(app).get('/api/disagreement')).status, 401);
});

test('GET /api/disagreement is a quiet 200 when there is nothing to raise', async () => {
  // No repeated-and-missed goal exists yet. Silence is the normal answer and
  // must never be an error.
  const res = await request(app).get('/api/disagreement').set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(res.body.disagreement, null);
});

test('POST /api/disagreement/resolve validates its inputs', async () => {
  const bad = [
    { resolutionKey: 'not-a-disagreement-key', choice: 'keep', statements: 4 },
    { resolutionKey: 'disagreement:x', choice: 'ignore', statements: 4 },
    { resolutionKey: 'disagreement:x', choice: 'keep', statements: 'lots' },
    { resolutionKey: 'disagreement:x', choice: 'keep' },
  ];
  for (const body of bad) {
    const res = await request(app).post('/api/disagreement/resolve').set(authHeader()).send(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('a repeated, repeatedly-missed goal is raised — then answering it goes quiet', async () => {
  // Five weeks of the same goal, graded missed each time, written through the
  // real store so the route reads exactly what the app would have written.
  const intentionsStore = require('../../src/store/intentions');
  const weeks = sundays(5);
  for (const week of weeks) {
    await intentionsStore.saveIntention({ weekStart: week, goals: [GOAL] });
    await intentionsStore.saveGoalResults({ weekStart: week, achieved: [false] });
  }

  const raised = await request(app).get('/api/disagreement').set(authHeader());
  assert.equal(raised.status, 200);
  const d = raised.body.disagreement;
  assert.ok(d, 'five statements, five graded misses, must be raised');
  assert.equal(d.label, GOAL);
  assert.equal(d.counts.statements, 5);
  assert.equal(d.counts.missed, 5);
  assert.equal(d.weeksMissed.length, 5);
  for (const w of d.weeksMissed) assert.match(w, /^\d{4}-\d{2}-\d{2}$/);
  // It asks rather than judges, and offers every legitimate answer.
  assert.match(d.question, /\?$/);
  assert.deepEqual(d.options.map((o) => o.id).sort(), ['keep', 'retire', 'revise']);

  const resolved = await request(app)
    .post('/api/disagreement/resolve')
    .set(authHeader())
    .send({ resolutionKey: d.resolutionKey, choice: 'keep', statements: d.counts.statements });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.ok, true);

  const after1 = await request(app).get('/api/disagreement').set(authHeader());
  assert.equal(after1.body.disagreement, null, 'an answered disagreement must stop repeating');

  // And the count it was answered at is what got stored — so a later
  // re-activation is measured from what the user actually saw.
  const { rows } = await db.query(`SELECT context FROM dismissed_insights WHERE dismiss_key = $1`, [d.resolutionKey]);
  assert.equal(rows[0].context.statements, 5);
  assert.equal(rows[0].context.choice, 'keep');
});

test('it returns once the same goal has been set and missed several more times', async () => {
  // The other half of the contract: answering must not be a permanent escape.
  const intentionsStore = require('../../src/store/intentions');
  const more = sundays(9).slice(5); // four further, older weeks of the same goal
  for (const week of more) {
    await intentionsStore.saveIntention({ weekStart: week, goals: [GOAL] });
    await intentionsStore.saveGoalResults({ weekStart: week, achieved: [false] });
  }

  const res = await request(app).get('/api/disagreement').set(authHeader());
  const d = res.body.disagreement;
  assert.ok(d, 'four more statements past the answered count is genuinely new information');
  assert.equal(d.counts.statements, 9);

  // Answering it AGAIN must record the new count. If the second resolution
  // kept the first one's count, the re-activation threshold would already be
  // exceeded and the card would reappear immediately — which is exactly how a
  // candid surface turns into a nagging one.
  const again = await request(app)
    .post('/api/disagreement/resolve')
    .set(authHeader())
    .send({ resolutionKey: d.resolutionKey, choice: 'retire', statements: d.counts.statements });
  assert.equal(again.status, 200);

  const quiet = await request(app).get('/api/disagreement').set(authHeader());
  assert.equal(quiet.body.disagreement, null, 're-answering must silence it again');

  const { rows } = await db.query(`SELECT context FROM dismissed_insights WHERE dismiss_key = $1`, [d.resolutionKey]);
  assert.equal(rows[0].context.statements, 9, 'the second resolution must overwrite the first');
  assert.equal(rows[0].context.choice, 'retire');
});
