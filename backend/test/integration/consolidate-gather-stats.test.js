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
const experimentsStore = require('../../src/store/experiments');
const { gatherFindings, gatherExperiments } = require('../../src/intelligence/consolidate');

const TAG = `test-gather-findings-${Date.now()}`;

async function cleanup() {
  await db.query(`DELETE FROM findings WHERE title LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM experiments WHERE hypothesis LIKE $1`, [`%${TAG}%`]);
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

// Live bug found via the same screenshot review: pausing your only
// experiment made the Profile stats read "0 running, 0 completed" even
// though the experiment was still visibly shown on the same tab — paused,
// not gone, with a Resume link. gatherExperiments()'s "running" count now
// matches the mobile ExperimentsCard's own definition of "active"
// (running OR paused), instead of a stricter definition that made an
// on-hold experiment disappear from the stats entirely.
test('gatherExperiments counts a paused experiment as active, not vanished', async () => {
  await cleanup();
  await experimentsStore.createExperiment({
    hypothesis: `Paused but not gone ${TAG}`, metric: 'health:hrv',
    status: 'paused', startDate: new Date(), endDate: new Date(Date.now() + 3 * 86400000),
  });

  const { running } = await gatherExperiments();
  const ours = running.filter((e) => e.hypothesis.includes(TAG));
  assert.equal(ours.length, 1, 'a paused experiment must still count as active');
});

test('gatherExperiments still counts a running experiment (unchanged behavior)', async () => {
  await cleanup();
  await experimentsStore.createExperiment({
    hypothesis: `Actually running ${TAG}`, metric: 'health:hrv',
    status: 'running', startDate: new Date(), endDate: new Date(Date.now() + 3 * 86400000),
  });

  const { running } = await gatherExperiments();
  const ours = running.filter((e) => e.hypothesis.includes(TAG));
  assert.equal(ours.length, 1);
});

test('gatherExperiments does not count a proposed (not yet started) or cancelled experiment as active', async () => {
  await cleanup();
  await experimentsStore.createExperiment({
    hypothesis: `Just proposed ${TAG}`, metric: 'health:hrv', status: 'proposed',
  });
  await experimentsStore.createExperiment({
    hypothesis: `Cancelled ${TAG}`, metric: 'health:hrv', status: 'cancelled',
  });

  const { running } = await gatherExperiments();
  const ours = running.filter((e) => e.hypothesis.includes(TAG));
  assert.equal(ours.length, 0);
});
