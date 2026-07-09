// dailyAggregate/dailyAggregatePreferSource bucketed by date_trunc('day', ts)
// with no timezone conversion — an 8pm ET reading is already past midnight
// UTC, so it silently landed in the NEXT day's bucket. This is the exact
// scenario db/migrations/019 documents as an observed production incident
// (a day's step count doubled: 12,771 + 14,448 = 27,219). That migration
// cleaned up historical duplicate rows but never fixed this query, which
// every trend/anomaly/correlation in analyze.js reads through. Now buckets
// by the LOCAL calendar day via AT TIME ZONE.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const metricsStore = require('../../src/store/metrics');
const sourcesStore = require('../../src/store/sources');

const SOURCE = `test-tz-aggregate-${Date.now()}`;

test.before(async () => {
  await sourcesStore.registerSource({ id: SOURCE, domain: 'health', displayName: 'TZ aggregate test source' });
});

after(async () => {
  await db.query(`DELETE FROM metrics WHERE source = $1`, [SOURCE]);
  await db.query(`DELETE FROM sources WHERE id = $1`, [SOURCE]);
  await closeDb();
});

test('dailyAggregate buckets an evening-ET reading (past UTC midnight) on its OWN local day, not split across two', async () => {
  // 8pm and 11:30pm ET on 2026-07-08 are both 2026-07-09 in UTC.
  await metricsStore.insertMetrics([
    { ts: '2026-07-08T20:00:00-04:00', domain: 'health', metric: 'steps', value: 5000, source: SOURCE },
    { ts: '2026-07-08T23:30:00-04:00', domain: 'health', metric: 'steps', value: 7000, source: SOURCE },
  ]);

  const rows = await metricsStore.dailyAggregate({
    domain: 'health',
    metric: 'steps',
    from: '2026-07-08T00:00:00-04:00',
    to: '2026-07-09T04:00:00-04:00',
    agg: 'sum',
    tz: 'America/New_York',
  });

  const filtered = rows.filter((r) => r.day.toISOString().startsWith('2026-07-08') || r.day.toISOString().startsWith('2026-07-09'));
  assert.equal(filtered.length, 1, 'both readings should collapse into a single 2026-07-08 bucket, not split across two UTC days');
  assert.equal(filtered[0].day.toISOString().slice(0, 10), '2026-07-08');
  assert.equal(Number(filtered[0].value), 12000, 'sum of both same-local-day readings');
});

test('dailyAggregatePreferSource also buckets by local day', async () => {
  await metricsStore.insertMetrics([
    { ts: '2026-06-01T21:00:00-04:00', domain: 'health', metric: 'hrv', value: 40, source: SOURCE },
  ]);

  const rows = await metricsStore.dailyAggregatePreferSource({
    domain: 'health',
    metric: 'hrv',
    from: '2026-06-01T00:00:00-04:00',
    to: '2026-06-02T04:00:00-04:00',
    agg: 'avg',
    sources: [SOURCE],
    tz: 'America/New_York',
  });

  const row = rows.find((r) => r.day.toISOString().slice(0, 10) === '2026-06-01');
  assert.ok(row, 'a 9pm ET reading should bucket to its own local day (2026-06-01), not 2026-06-02 UTC');
});
