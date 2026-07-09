// listMetricKeys() was a full-table `SELECT DISTINCT domain, metric FROM
// metrics` with no WHERE clause — the one query in this file that gets
// slower forever as the table grows, called on every analyze() run AND
// every chat/ask request. The set it returns only changes when a genuinely
// new metric type is first ingested, so it's now cached briefly.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');

const SOURCE = `test-keys-cache-${Date.now()}`;
const NEW_METRIC = `cache_test_metric_${Date.now()}`;

after(async () => {
  await db.query(`DELETE FROM metrics WHERE source = $1`, [SOURCE]);
  await db.query(`DELETE FROM sources WHERE id = $1`, [SOURCE]);
  await closeDb();
});

test('listMetricKeys() serves a cached result on a second call within the TTL — a newly-inserted metric key is NOT visible immediately', async () => {
  delete require.cache[require.resolve('../../src/store/metrics')];
  process.env.METRIC_KEYS_CACHE_MS = '60000'; // long TTL for this test
  const metricsStore = require('../../src/store/metrics');
  const sourcesStore = require('../../src/store/sources');
  await sourcesStore.registerSource({ id: SOURCE, domain: 'health', displayName: 'cache test source' });

  const before = await metricsStore.listMetricKeys();
  assert.ok(!before.some((k) => k.metric === NEW_METRIC), 'sanity: the new metric should not exist yet');

  await metricsStore.insertMetrics([{ ts: new Date(), domain: 'health', metric: NEW_METRIC, value: 1, source: SOURCE }]);

  const after1 = await metricsStore.listMetricKeys();
  assert.ok(!after1.some((k) => k.metric === NEW_METRIC), 'cached result should NOT reflect a key inserted after the cache was warmed');

  delete require.cache[require.resolve('../../src/store/metrics')];
});

test('listMetricKeys() picks up a newly-inserted key once the cache TTL has elapsed', async () => {
  delete require.cache[require.resolve('../../src/store/metrics')];
  process.env.METRIC_KEYS_CACHE_MS = '1'; // effectively no caching
  const metricsStore = require('../../src/store/metrics');
  const sourcesStore = require('../../src/store/sources');
  await sourcesStore.registerSource({ id: SOURCE, domain: 'health', displayName: 'cache test source' });

  await metricsStore.insertMetrics([{ ts: new Date(), domain: 'health', metric: NEW_METRIC, value: 1, source: SOURCE }]);
  await new Promise((r) => setTimeout(r, 20));

  const keys = await metricsStore.listMetricKeys();
  assert.ok(keys.some((k) => k.metric === NEW_METRIC), 'with a near-zero TTL, a fresh query should see the newly-inserted key');

  delete require.cache[require.resolve('../../src/store/metrics')];
  delete process.env.METRIC_KEYS_CACHE_MS;
});
