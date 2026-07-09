// Integration coverage for the generic metric-ingestion endpoint against a
// real DB — write via POST /api/ingest/metrics, read back via GET /api/metrics.
// This is the canonical "spine" write path every connector funnels through.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const sourcesStore = require('../../src/store/sources');

const app = buildTestApp();
const SOURCE = `test-ingest-${Date.now()}`;

test.before(async () => {
  // metrics.source has a foreign-key constraint to sources — every real
  // connector registers itself before writing (see e.g. ingest-admin.js's
  // /import/monarch), so the test must too.
  await sourcesStore.registerSource({ id: SOURCE, domain: 'health', displayName: 'Integration test source' });
});

after(async () => {
  await db.query(`DELETE FROM metrics WHERE source = $1`, [SOURCE]);
  await db.query(`DELETE FROM sources WHERE id = $1`, [SOURCE]);
  await closeDb();
});

test('POST /api/ingest/metrics writes rows that GET /api/metrics then reads back', async () => {
  const ts = new Date().toISOString();
  const write = await request(app)
    .post('/api/ingest/metrics')
    .set(authHeader())
    .send([{ ts, domain: 'health', metric: 'hrv', value: 42, unit: 'ms', source: SOURCE }]);
  assert.equal(write.status, 200);
  assert.equal(write.body.written, 1);

  const read = await request(app)
    .get('/api/metrics')
    .query({ domain: 'health', metric: 'hrv' })
    .set(authHeader());
  assert.equal(read.status, 200);
  assert.ok(
    read.body.series.some((r) => r.source === SOURCE && Number(r.value) === 42),
    `expected the just-written row in the series; got: ${JSON.stringify(read.body.series)}`
  );
});

test('POST /api/ingest/metrics silently drops rows missing required fields rather than writing garbage', async () => {
  const res = await request(app)
    .post('/api/ingest/metrics')
    .set(authHeader())
    .send([{ domain: 'health' /* missing metric/source/value */ }]);
  assert.equal(res.status, 200);
  assert.equal(res.body.written, 0);
});

test('GET /api/metrics requires domain and metric query params', async () => {
  const res = await request(app).get('/api/metrics').set(authHeader());
  assert.equal(res.status, 400);
});
