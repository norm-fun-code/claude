// Integration coverage for the two-token auth model: the general /api gate
// (NORMOS_API_TOKEN) and the separate admin/diagnostic gate (NORMOS_ADMIN_TOKEN,
// see src/middleware/adminAuth.js). Exercises the REAL app + REAL middleware
// stack end to end — this is exactly the class of bug a pure unit test of
// createTokenGate() alone would have missed (the "same header, two secrets"
// bug caught while building this).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, ADMIN_TOKEN, closeDb } = require('./helpers');

const app = buildTestApp();
after(closeDb);

test('GET /api/health needs no token (the one always-open route)', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
});

test('a normal /api route 401s with no token', async () => {
  const res = await request(app).get('/api/sources');
  assert.equal(res.status, 401);
});

test('a normal /api route 401s with the wrong token', async () => {
  const res = await request(app).get('/api/sources').set(authHeader('not-the-token'));
  assert.equal(res.status, 401);
});

test('a normal /api route passes auth with the app token', async () => {
  const res = await request(app).get('/api/sources').set(authHeader());
  // Auth passed; whatever the handler itself returns is out of scope here.
  assert.notEqual(res.status, 401);
});

test('a diagnostic route 401s with the general app token alone (needs the admin token instead)', async () => {
  const res = await request(app).get('/api/debug/mtd-spend').set(authHeader());
  assert.equal(res.status, 401);
});

test('a diagnostic route passes auth with the admin token (and does NOT also need the app token)', async () => {
  const res = await request(app).get('/api/debug/mtd-spend').set(authHeader(ADMIN_TOKEN));
  assert.notEqual(res.status, 401);
});

test('POST /api/ingest/run (admin-gated) 401s with the app token, passes with the admin token', async () => {
  const withApp = await request(app).post('/api/ingest/run').set(authHeader());
  assert.equal(withApp.status, 401);
  const withAdmin = await request(app).post('/api/ingest/run').set(authHeader(ADMIN_TOKEN));
  assert.notEqual(withAdmin.status, 401);
});

test('POST /api/admin/reset-demo (admin-gated) 401s with the app token', async () => {
  const res = await request(app).post('/api/admin/reset-demo').set(authHeader());
  assert.equal(res.status, 401);
});

test('a sibling route mounted alongside the admin-gated diagnostics router is unaffected (regression: router.use() path scoping)', async () => {
  // /api/weather lives in the SAME ingest-admin.js file as the admin-gated
  // /admin/reset-demo route, and diagnostics.js (a DIFFERENT router, gated on
  // /diag and /debug) is mounted at the same '/api' prefix. A path-less
  // router.use(adminGate) in diagnostics.js previously 401'd this route too.
  const res = await request(app).get('/api/weather').set(authHeader());
  assert.notEqual(res.status, 401);
});

test('the admin token alone does not satisfy a normal (non-admin) route', async () => {
  const res = await request(app).get('/api/sources').set(authHeader(ADMIN_TOKEN));
  assert.equal(res.status, 401);
});
