// One-tap "Commit" on the brief's ACTION (full-repo review, improvement #3 —
// close the narrate/act gap). THE ACTION used to be read-only prose; now
// POST /briefing/action/commit turns it into a real commitment (due tonight,
// picked up by the existing reminder + auto-complete machinery) and stamps
// accepted_at on today's ledger row so acceptance rate becomes measurable.
// Also covers the env-gated experiment auto-start (consent flag semantics).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const findingsStore = require('../../src/store/findings');

const app = buildTestApp();
const TAG = `action-commit-${Date.now()}`;

after(async () => {
  await db.query(`DELETE FROM commitments WHERE title LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM recommendations WHERE title LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM experiments WHERE hypothesis LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM findings WHERE title LIKE $1`, [`%${TAG}%`]);
  await closeDb();
});

test('committing THE ACTION creates a commitment due today and stamps acceptance on the ledger', async () => {
  // Seed today's briefing leverage recommendation (what briefing.js records
  // when it surfaces THE ACTION).
  await db.query(
    `INSERT INTO recommendations (type, title, surfaced_in) VALUES ('leverage', $1, 'briefing')`,
    [`Zone 2 walk before lunch ${TAG}`]
  );

  const res = await request(app)
    .post('/api/briefing/action/commit')
    .set(authHeader())
    .send({ text: `Do the Zone 2 incline walk at an easy pace ${TAG}` })
    .timeout(10000);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.commitment.source, 'brief_action');
  assert.match(res.body.commitment.title, /Zone 2 incline walk/);
  assert.ok(res.body.commitment.due_at, 'commitment carries a due time (tonight)');
  assert.ok(new Date(res.body.commitment.due_at) > new Date(), 'never lands already-overdue');

  // Acceptance stamp is fire-and-forget off the request path — poll briefly.
  let acceptedAt = null;
  for (let i = 0; i < 20 && !acceptedAt; i++) {
    const { rows } = await db.query(`SELECT accepted_at FROM recommendations WHERE title LIKE $1`, [`%${TAG}%`]);
    acceptedAt = rows[0]?.accepted_at ?? null;
    if (!acceptedAt) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(acceptedAt, "today's briefing leverage recommendation is stamped accepted");
});

test('commit without text is a 400', async () => {
  const res = await request(app).post('/api/briefing/action/commit').set(authHeader()).send({}).timeout(10000);
  assert.equal(res.status, 400);
});

// "Commit to something else" — the leverage engine ranks up to 3 candidates
// but only rank 1 becomes THE ACTION; ranks 2/3 should be fetchable as
// alternates rather than forcing a freeform retype.
test('GET /briefing/action/alternates returns ranked leverage findings excluding rank 1', async () => {
  await findingsStore.createFinding({
    type: 'leverage', title: `Top pick ${TAG}`, evidence: { rank: 1 },
  });
  await findingsStore.createFinding({
    type: 'leverage', title: `Second choice ${TAG}`, detail: 'because reasons', evidence: { rank: 2 },
  });
  await findingsStore.createFinding({
    type: 'leverage', title: `Third choice ${TAG}`, evidence: { rank: 3 },
  });
  // A non-leverage finding must not leak into alternates.
  await findingsStore.createFinding({ type: 'forecast', title: `Unrelated forecast ${TAG}`, evidence: {} });

  const res = await request(app).get('/api/briefing/action/alternates').set(authHeader()).timeout(10000);
  assert.equal(res.status, 200);
  const mine = res.body.alternates.filter((a) => a.title.includes(TAG));
  assert.equal(mine.length, 2, 'only ranks 2 and 3 for this run, not rank 1 or the unrelated forecast');
  assert.equal(mine[0].title, `Second choice ${TAG}`, 'ordered by rank');
  assert.equal(mine[0].detail, 'because reasons');
  assert.equal(mine[1].title, `Third choice ${TAG}`);
});

test('experiment auto-start: OFF by default (consent flag unset -> null, regardless of proposals)', async (t) => {
  const prior = process.env.EXPERIMENTS_AUTO_START;
  delete process.env.EXPERIMENTS_AUTO_START;
  t.after(() => { if (prior !== undefined) process.env.EXPERIMENTS_AUTO_START = prior; });

  const experimentsStore = require('../../src/store/experiments');
  await experimentsStore.createExperiment({ hypothesis: `Proposed but must not start ${TAG}`, metric: 'health:hrv', status: 'proposed' });

  const started = await require('../../src/intelligence/experiments').autoStartExperiment();
  assert.equal(started, null);
  const { rows } = await db.query(`SELECT status FROM experiments WHERE hypothesis LIKE $1`, [`%must not start ${TAG}%`]);
  assert.equal(rows[0].status, 'proposed', 'stays a proposal without the consent flag');
});

test('experiment auto-start: with consent flag, starts the newest proposal only when nothing is running', async (t) => {
  process.env.EXPERIMENTS_AUTO_START = 'true';
  t.after(() => { delete process.env.EXPERIMENTS_AUTO_START; });

  const experimentsStore = require('../../src/store/experiments');
  const experiments = require('../../src/intelligence/experiments');

  // A running experiment blocks auto-start (clean baselines, one at a time).
  await experimentsStore.createExperiment({
    hypothesis: `Already running ${TAG}`, metric: 'health:hrv', status: 'running',
    startDate: new Date(), endDate: new Date(Date.now() + 5 * 864e5),
  });
  assert.equal(await experiments.autoStartExperiment(), null, 'one live experiment at a time');

  // Clear the runner; now the newest proposal should start.
  await db.query(`UPDATE experiments SET status = 'completed' WHERE hypothesis LIKE $1`, [`%Already running ${TAG}%`]);
  const started = await experiments.autoStartExperiment();
  assert.ok(started, 'expected an auto-started experiment');
  assert.match(started.hypothesis, new RegExp(TAG));
  const { rows } = await db.query(`SELECT status, start_date, end_date FROM experiments WHERE id = $1`, [started.id]);
  assert.equal(rows[0].status, 'running');
  assert.ok(rows[0].start_date && rows[0].end_date, 'test window dates set');
});
