// Regression coverage for Ticket 9's Ask fast path: one common 14-day
// metric read must preserve canonical source selection while returning both
// comparison windows. This uses real Postgres rather than a mocked aggregate
// so date/source semantics are exercised as the app actually sees them.
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../src/db');
const metrics = require('../../src/store/metrics');
const { closeDb } = require('./helpers');

const SOURCE = 'ask-trend-batch-test';
const OTHER_SOURCE = 'ask-trend-batch-secondary';

test.before(async () => {
  await db.query(
    `INSERT INTO sources (id, domain, display_name) VALUES
      ($1, 'health', 'Ask trend batch primary'),
      ($2, 'health', 'Ask trend batch secondary')
     ON CONFLICT (id) DO NOTHING`,
    [SOURCE, OTHER_SOURCE]
  );
});
test.after(async () => {
  await db.query(`DELETE FROM metrics WHERE source IN ($1, $2)`, [SOURCE, OTHER_SOURCE]);
  await db.query(`DELETE FROM sources WHERE id IN ($1, $2)`, [SOURCE, OTHER_SOURCE]);
  await closeDb();
});

test('recentMetricTrends returns recent and prior daily aggregates from one shared window without mixing a lower-priority source', async () => {
  const now = new Date();
  // Include the current instant plus the preceding 13 days: with splitAt at
  // now-7d that creates seven rows in each half-open comparison window.
  for (let day = 0; day <= 13; day++) {
    const ts = new Date(now.getTime() - day * 24 * 60 * 60 * 1000);
    const expected = day < 7 ? 60 : 40;
    await db.query(
      `INSERT INTO metrics (ts, domain, metric, value, unit, source)
       VALUES ($1, 'health', 'batch_test_hrv', $2, 'ms', $3)
       ON CONFLICT (ts, domain, metric, source) DO UPDATE SET value = EXCLUDED.value`,
      [ts, expected, SOURCE]
    );
    // The canonical source lock must exclude this otherwise higher value.
    await db.query(
      `INSERT INTO metrics (ts, domain, metric, value, unit, source)
       VALUES ($1, 'health', 'batch_test_hrv', 99, 'ms', $2)
       ON CONFLICT (ts, domain, metric, source) DO UPDATE SET value = EXCLUDED.value`,
      [ts, OTHER_SOURCE]
    );
  }

  const trends = await metrics.recentMetricTrends([
    { domain: 'health', metric: 'batch_test_hrv', agg: 'avg', sources: [SOURCE] },
  ], {
    from: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
    splitAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
    to: now,
  });

  assert.equal(trends.length, 1);
  assert.equal(Math.round(trends[0].recent), 60);
  assert.equal(Math.round(trends[0].prior), 40);
});
