// Bug bash finding: a live user logged a 70-min no-watch basketball session
// (estimated ~9,100 steps via intelligence/activity-estimates.js) but the
// evening brief's "You logged X steps today" line never moved — it still
// showed the day's much-smaller watch-tracked count (4,279). Root cause:
// evening-readiness.js's todayLoad() took a single MAX(value) across EVERY
// source for 'steps', including both the watch's running-total (source
// 'apple_health', where MAX is correct — it's a monotonically increasing
// day total) AND activity-sync.js's 'activity_est' source (a DISJOINT
// estimate for movement the watch never saw at all). MAX silently drops
// whichever of the two is smaller instead of adding them.
//
// Tests target combinedDailyTotal() directly with an arbitrary historical
// date, not todayLoad() (which is hard-wired to literal wall-clock "today"
// via dayWindow()) — todayLoad() would collide with any other test writing
// to the real 'activity_est' source for the real current day, since Node's
// test runner parallelizes across files.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const metricsStore = require('../../src/store/metrics');
const sourcesStore = require('../../src/store/sources');
const { combinedDailyTotal, todayLoad } = require('../../src/intelligence/evening-readiness');

const SOURCE = `test-activity-est-watch-${Date.now()}`;
const TZ = 'America/New_York';
// A fixed historical date, far from "today" — avoids any collision with
// other tests (or real app traffic) touching the real 'activity_est' source
// for the real current day.
const TEST_DAY = '2025-03-11';
const noon = new Date(`${TEST_DAY}T12:00:00-05:00`);
const dayFrom = new Date(`${TEST_DAY}T00:00:00-05:00`);
const dayTo = new Date(`${TEST_DAY}T23:59:59-05:00`);

async function cleanupMetrics() {
  await db.query(`DELETE FROM metrics WHERE source = $1 AND (ts AT TIME ZONE $2)::date = $3::date`, [SOURCE, TZ, TEST_DAY]);
  await db.query(`DELETE FROM metrics WHERE source = 'activity_est' AND (ts AT TIME ZONE $1)::date = $2::date`, [TZ, TEST_DAY]);
}

test.before(async () => {
  await sourcesStore.registerSource({ id: SOURCE, domain: 'health', displayName: 'Test watch source' });
  // 'activity_est' is normally self-registered by intelligence/activity-sync.js
  // (the actual bug being regression-tested here) — these tests write to it
  // directly via insertMetrics, bypassing that registration, so register it
  // here the same way any other test source is registered.
  await sourcesStore.registerSource({ id: 'activity_est', domain: 'health', displayName: 'Logged Activity (no-watch estimate)' });
});

after(async () => {
  await cleanupMetrics();
  await db.query(`DELETE FROM sources WHERE id = $1`, [SOURCE]);
  await closeDb();
});

test('combinedDailyTotal SUMS watch-tracked steps with a same-day off-watch activity estimate, instead of taking the max', async () => {
  await cleanupMetrics();
  await metricsStore.insertMetrics([
    // The watch's own running day-total (smaller of the two, matching the
    // live report: normal daytime movement, no watch worn during the game).
    { ts: noon, domain: 'health', metric: 'steps', value: 4279, source: SOURCE },
    // activity-sync.js's estimate for the no-watch basketball session.
    { ts: noon, domain: 'health', metric: 'steps', value: 9100, source: 'activity_est' },
  ]);

  const rows = await combinedDailyTotal('steps', dayFrom, dayTo, TZ);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].value), 4279 + 9100, 'the day total must be the SUM of watch-tracked and off-watch-estimated steps, not whichever is larger');
});

test('combinedDailyTotal still reports the watch total alone on a day with no off-watch activity logged', async () => {
  await cleanupMetrics();
  await metricsStore.insertMetrics([
    { ts: noon, domain: 'health', metric: 'steps', value: 6500, source: SOURCE },
  ]);

  const rows = await combinedDailyTotal('steps', dayFrom, dayTo, TZ);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].value), 6500);
});

test('combinedDailyTotal still reports the estimate alone on a day with ONLY an off-watch activity (no separate device sync)', async () => {
  await cleanupMetrics();
  await metricsStore.insertMetrics([
    { ts: noon, domain: 'health', metric: 'steps', value: 9100, source: 'activity_est' },
  ]);

  const rows = await combinedDailyTotal('steps', dayFrom, dayTo, TZ);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].value), 9100);
});

test('todayLoad() runs end-to-end without error and returns the expected shape (smoke test)', async () => {
  const load = await todayLoad({ tz: TZ });
  assert.ok('steps' in load && 'stepsBaseline' in load && 'activeEnergy' in load && 'activeEnergyBaseline' in load);
});
