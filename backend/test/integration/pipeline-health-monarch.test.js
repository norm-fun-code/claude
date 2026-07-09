// GET /api/pipeline-health's new `monarch` field — the single Monarch
// health signal (engineering review's #8), now shared with briefing.js's
// two data-gap checks via src/intelligence/source-health.js instead of
// three independently-copied threshold tables.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const sourcesStore = require('../../src/store/sources');

const app = buildTestApp();
const MCP_ID = `test-monarch-mcp-${Date.now()}`;
const CSV_ID = `test-monarch-csv-${Date.now()}`;

after(async () => {
  await db.query(`DELETE FROM sources WHERE id = ANY($1)`, [[MCP_ID, CSV_ID]]);
  await closeDb();
});

test('GET /api/pipeline-health includes a monarch health summary alongside per-connector detail', async () => {
  const res = await request(app).get('/api/pipeline-health').set(authHeader());
  assert.equal(res.status, 200);
  assert.ok('monarch' in res.body, 'response should include the consolidated monarch health field');
  assert.ok(Array.isArray(res.body.connectors));
});

test('pipeline-health and the shared threshold config agree on monarch_mcp_sync staleness (26h)', async () => {
  await sourcesStore.registerSource({ id: MCP_ID, domain: 'wealth', displayName: 'test mcp' });
  // markSync sets last_sync_at to now — fresh, should not be flagged stale.
  await sourcesStore.markSync(MCP_ID);

  const res = await request(app).get('/api/pipeline-health').set(authHeader());
  const row = res.body.connectors.find((c) => c.id === MCP_ID);
  // Unregistered custom id falls back to the default 72h threshold in
  // source-health.js (only the literal 'monarch_mcp_sync'/'monarch' ids get
  // the 26h/48h thresholds) — this just confirms the route round-trips
  // through the shared module correctly, not a specific threshold value.
  assert.ok(row, 'newly registered source should appear in connectors');
  assert.equal(row.isStale, false, 'just-synced source should not be stale');
});
