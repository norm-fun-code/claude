// Live bug found via a product screenshot review: NormOS Profile showed "0
// confirmed correlations" while the SAME Health tab visibly showed 3+
// correlational insights ("Eating well: Daytime HRV +16%" — a daytime_cardio
// finding; "Best sleep nights lift HRV" — a sleep_impact finding). The
// counter was scoped to ONLY type==='correlation' (the generic Pearson
// engine), which happened to have zero open findings — an internal detail
// (which detector produced the relationship) leaking into a user-facing stat
// that looked broken. gatherFindings() now counts every finding type that
// represents a confirmed "X relates to Y" relationship.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const findingsStore = require('../../src/store/findings');
const { gatherFindings } = require('../../src/intelligence/consolidate');

const TAG = `test-gather-findings-${Date.now()}`;

async function cleanup() {
  await db.query(`DELETE FROM findings WHERE title LIKE $1`, [`%${TAG}%`]);
}
after(async () => { await cleanup(); await closeDb(); });

test('gatherFindings counts daytime_cardio/sleep_impact/activity_impact/habit_split alongside plain correlations', async () => {
  await cleanup();
  await findingsStore.createFinding({
    type: 'daytime_cardio', domains: ['health'], title: `Eating well: Daytime HRV ${TAG}`,
    detail: 'd', confidence: 0.7, evidence: { auto: true },
  });
  await findingsStore.createFinding({
    type: 'sleep_impact', domains: ['health'], title: `Best sleep nights lift HRV ${TAG}`,
    detail: 'd', confidence: 0.7, evidence: { auto: true },
  });
  await findingsStore.createFinding({
    type: 'activity_impact', domains: ['health'], title: `Zone 2 lifts next-day HRV ${TAG}`,
    detail: 'd', confidence: 0.7, evidence: { auto: true },
  });
  await findingsStore.createFinding({
    type: 'habit_split', domains: ['habits', 'health'], title: `Cold shower days: HRV higher ${TAG}`,
    detail: 'd', confidence: 0.7, evidence: { auto: true },
  });

  const { correlations } = await gatherFindings();
  const ours = correlations.filter((c) => c.title.includes(TAG));
  assert.equal(ours.length, 4, 'all 4 specialized "relates to" finding types must count toward the correlations stat');
});

test('a plain "correlation" finding only counts when evidence.confirmed is true (unchanged behavior)', async () => {
  await cleanup();
  await findingsStore.createFinding({
    type: 'correlation', domains: ['health'], title: `Emerging, not yet confirmed ${TAG}`,
    detail: 'd', confidence: 0.5, evidence: { auto: true, confirmed: false },
  });
  await findingsStore.createFinding({
    type: 'correlation', domains: ['health'], title: `Confirmed correlation ${TAG}`,
    detail: 'd', confidence: 0.9, evidence: { auto: true, confirmed: true },
  });

  const { correlations } = await gatherFindings();
  const ours = correlations.filter((c) => c.title.includes(TAG));
  assert.equal(ours.length, 1, 'only the confirmed plain-correlation finding should count');
  assert.match(ours[0].title, /^Confirmed correlation/);
});

test('other finding types (trend, anomaly, forecast, leverage) do not count as correlations', async () => {
  await cleanup();
  await findingsStore.createFinding({
    type: 'trend', domains: ['health'], title: `A trend ${TAG}`, detail: 'd', confidence: 0.7, evidence: {},
  });
  await findingsStore.createFinding({
    type: 'anomaly', domains: ['health'], title: `An anomaly ${TAG}`, detail: 'd', confidence: 0.7, evidence: {},
  });

  const { correlations } = await gatherFindings();
  const ours = correlations.filter((c) => c.title.includes(TAG));
  assert.equal(ours.length, 0);
});
