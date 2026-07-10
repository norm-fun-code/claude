// Insight-taxonomy consolidation (1A): every recommendation now gets a linked
// commitment — it's the ONE surface a recommendation shows up on, replacing
// what used to be up to 5 (WeeklyIntentions card, push nudge, ledger card,
// auto-commitment, chat). Previously only metric-LESS recs got a linked
// commitment; metric-bearing ones (confirmed correlations like "cold shower
// -> HRV") got none at all, so with the ledger card now gone they'd have had
// no surface. This exercises the two real behaviors that change:
//   1. A metric-bearing recommendation now DOES get a linked commitment.
//   2. Marking THAT commitment done/skipped must NOT write a synthetic
//      adherence outcome — the real verdict still has to come from the 7-day
//      measured delta (measureOutcomes), since setOutcome is first-verdict-wins
//      and a synthetic tap would permanently lock out the real measurement.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const recommendationsStore = require('../../src/store/recommendations');
const commitmentsStore = require('../../src/store/commitments');

const TAG = `test-rec-commit-link-${Date.now()}`;

async function cleanup() {
  await db.query(`DELETE FROM commitments WHERE title LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM recommendations WHERE title LIKE $1`, [`%${TAG}%`]);
}
after(async () => { await cleanup(); await closeDb(); });

// The commitment/adherence-outcome writes are fire-and-forget (recordRecommendation
// and markDone/markSkipped don't await them) — poll instead of a fixed sleep so
// this isn't racy against pool warmup on a cold first query in the process.
async function poll(fn, { tries = 20, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

async function findCommitmentFor(recId) {
  return poll(async () => {
    const { rows } = await db.query(`SELECT * FROM commitments WHERE recommendation_id = $1`, [recId]);
    return rows[0] ?? null;
  });
}
async function getRec(id) {
  const { rows } = await db.query(`SELECT * FROM recommendations WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
async function getRecWithOutcome(id) {
  return poll(async () => {
    const rec = await getRec(id);
    return rec?.outcome_measured_at ? rec : null;
  });
}

test('a metric-less recommendation still gets a linked commitment (existing behavior)', async () => {
  const id = await recommendationsStore.recordRecommendation({
    title: `Wind down earlier ${TAG}`,
    detail: 'no outcome metric',
  });
  const commitment = await findCommitmentFor(id);
  assert.ok(commitment, 'metric-less rec must still get a linked commitment');
  assert.equal(commitment.status, 'open');
});

test('a metric-bearing recommendation NOW also gets a linked commitment', async () => {
  const id = await recommendationsStore.recordRecommendation({
    title: `Cold shower boosts HRV ${TAG}`,
    detail: 'confirmed correlation',
    lever: 'habits:cold_shower',
    outcomeMetric: 'health:hrv',
    expectedDirection: 'up',
  });
  const commitment = await findCommitmentFor(id);
  assert.ok(commitment, 'metric-bearing rec must now get a linked commitment too — it is the only surface a rec has since the ledger card was removed');
});

test('marking a metric-LESS commitment done DOES write the adherence outcome (unchanged)', async () => {
  const id = await recommendationsStore.recordRecommendation({
    title: `Journal before bed ${TAG}`,
    detail: 'no outcome metric',
  });
  const commitment = await findCommitmentFor(id);
  assert.ok(commitment);

  await commitmentsStore.markDone(commitment.id);
  const rec = await getRecWithOutcome(id); // recordAdherenceOutcome is fire-and-forget

  assert.ok(rec, 'metric-less: done should set outcome_measured_at');
  assert.equal(Number(rec.outcome_delta), 1, 'metric-less: done should write a +1 adherence delta');
});

test('marking a metric-BEARING commitment done does NOT write a synthetic outcome — the real 7-day measurement stays authoritative', async () => {
  const id = await recommendationsStore.recordRecommendation({
    title: `Sleep earlier boosts recovery ${TAG}`,
    detail: 'confirmed correlation',
    lever: 'habits:sleep_time',
    outcomeMetric: 'health:hrv',
    expectedDirection: 'up',
  });
  const commitment = await findCommitmentFor(id);
  assert.ok(commitment, 'sanity: commitment must exist to test marking it done');

  await commitmentsStore.markDone(commitment.id);
  // Proving an ABSENCE (no write ever happens) needs a real wait, not a poll —
  // give the fire-and-forget path generous time to have landed if it were going to.
  await new Promise((r) => setTimeout(r, 500));

  const rec = await getRec(id);
  assert.equal(rec.outcome_delta, null, 'metric-bearing: a done tap must NOT write a synthetic outcome delta');
  assert.equal(rec.outcome_measured_at, null, 'metric-bearing: outcome_measured_at must stay null so measureOutcomes() can still write the real verdict later');

  // The commitment ITSELF still resolves normally (disappears from Today) —
  // only the recommendation's outcome is protected from the synthetic write.
  const { rows } = await db.query(`SELECT status FROM commitments WHERE id = $1`, [commitment.id]);
  assert.equal(rows[0].status, 'done');
});

test('marking a metric-BEARING commitment skipped also does not write a synthetic outcome', async () => {
  const id = await recommendationsStore.recordRecommendation({
    title: `Zone 2 walk lifts mood ${TAG}`,
    outcomeMetric: 'wellbeing:mood',
    expectedDirection: 'up',
  });
  const commitment = await findCommitmentFor(id);
  assert.ok(commitment);

  await commitmentsStore.markSkipped(commitment.id);
  await new Promise((r) => setTimeout(r, 500));

  const rec = await getRec(id);
  assert.equal(rec.outcome_delta, null);
  assert.equal(rec.outcome_measured_at, null);
});
