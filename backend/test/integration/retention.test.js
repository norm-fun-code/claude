// src/db/retention.js — the opt-in, manual metrics-purge tool (engineering
// review's #7). Integration test since it needs a real DB. Scoped to a
// unique test source so it can never touch real data.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const sourcesStore = require('../../src/store/sources');
const { previewOldMetrics, purgeMetricsOlderThan } = require('../../src/db/retention');

const SOURCE = `test-retention-${Date.now()}`;

test.before(async () => {
  await sourcesStore.registerSource({ id: SOURCE, domain: 'health', displayName: 'Retention test source' });
  // One row 400 days old, one row 10 days old.
  await db.query(
    `INSERT INTO metrics (ts, domain, metric, value, unit, source) VALUES
       (now() - interval '400 days', 'health', 'hrv', 42, 'ms', $1),
       (now() - interval '10 days', 'health', 'hrv', 50, 'ms', $1)`,
    [SOURCE]
  );
});

after(async () => {
  await db.query(`DELETE FROM metrics WHERE source = $1`, [SOURCE]);
  await db.query(`DELETE FROM sources WHERE id = $1`, [SOURCE]);
  await db.pool.end();
});

test('purgeMetricsOlderThan throws without confirm:true — never deletes by accident', async () => {
  await assert.rejects(() => purgeMetricsOlderThan({ olderThanDays: 365 }), /confirm/);
});

test('previewOldMetrics is read-only and reports the count/range without deleting anything', async () => {
  const before = await db.query(`SELECT count(*)::int n FROM metrics WHERE source = $1`, [SOURCE]);
  const preview = await previewOldMetrics({ olderThanDays: 365 });
  assert.ok(preview.n >= 1, 'at least the 400-day-old row should count');
  const after1 = await db.query(`SELECT count(*)::int n FROM metrics WHERE source = $1`, [SOURCE]);
  assert.equal(after1.rows[0].n, before.rows[0].n, 'preview must not delete anything');
});

test('purgeMetricsOlderThan with confirm:true deletes only rows older than the cutoff', async () => {
  const result = await purgeMetricsOlderThan({ olderThanDays: 365, confirm: true });
  assert.ok(result.deleted >= 1);
  const remaining = await db.query(`SELECT ts FROM metrics WHERE source = $1`, [SOURCE]);
  assert.equal(remaining.rows.length, 1, 'only the 10-day-old row should remain');
  const ageMs = Date.now() - new Date(remaining.rows[0].ts).getTime();
  assert.ok(ageMs < 365 * 24 * 60 * 60 * 1000, 'the surviving row must be newer than the cutoff');
});

test('previewOldMetrics/purgeMetricsOlderThan reject a non-positive olderThanDays', async () => {
  await assert.rejects(() => previewOldMetrics({ olderThanDays: 0 }));
  await assert.rejects(() => previewOldMetrics({ olderThanDays: -5 }));
  await assert.rejects(() => purgeMetricsOlderThan({ olderThanDays: NaN, confirm: true }));
});
