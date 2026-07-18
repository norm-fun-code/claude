// Production Safety Gate (audit recommendation #1) — proves the general
// /api auth gate fails CLOSED (503), not open, when NORMOS_API_TOKEN is
// unconfigured in production, while /api/health, already-configured tokens,
// and the separately-gated admin surface all keep their intended behavior.
// createTokenGate reads process.env live on every request (see
// middleware/auth.js), so these toggle NODE_ENV/NORMOS_API_TOKEN around
// individual requests against ONE shared app instance rather than
// constructing a new app per case — same real-Postgres convention as the
// rest of this suite (buildTestApp()).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, ADMIN_TOKEN, closeDb } = require('./helpers');

const app = buildTestApp();
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_API_TOKEN = process.env.NORMOS_API_TOKEN;

after(async () => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  process.env.NORMOS_API_TOKEN = ORIGINAL_API_TOKEN;
  await closeDb();
});

test('production + NORMOS_API_TOKEN unconfigured: a non-health /api route fails CLOSED (503), never lets the request through', async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.NORMOS_API_TOKEN;
  try {
    const res = await request(app).get('/api/goals');
    assert.equal(res.status, 503);
    assert.match(res.body.error, /NORMOS_API_TOKEN/);
  } finally {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    process.env.NORMOS_API_TOKEN = ORIGINAL_API_TOKEN;
  }
});

test('production + NORMOS_API_TOKEN unconfigured: /api/health is STILL reachable with no bearer token at all', async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.NORMOS_API_TOKEN;
  try {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
  } finally {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    process.env.NORMOS_API_TOKEN = ORIGINAL_API_TOKEN;
  }
});

test('production + NORMOS_API_TOKEN CONFIGURED: the correct bearer token still succeeds — fail-closed does not break normal configured auth', async () => {
  process.env.NODE_ENV = 'production';
  process.env.NORMOS_API_TOKEN = ORIGINAL_API_TOKEN;
  try {
    const res = await request(app).get('/api/goals').set(authHeader());
    assert.notEqual(res.status, 503);
    assert.notEqual(res.status, 401);
  } finally {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

test('production + NORMOS_API_TOKEN CONFIGURED: a request with NO bearer token is rejected 401, not silently allowed', async () => {
  process.env.NODE_ENV = 'production';
  process.env.NORMOS_API_TOKEN = ORIGINAL_API_TOKEN;
  try {
    const res = await request(app).get('/api/goals');
    assert.equal(res.status, 401);
  } finally {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

test('outside production, NORMOS_API_TOKEN unconfigured: requests still pass through — fail-closed is production-only, local dev stays convenient', async () => {
  process.env.NODE_ENV = 'development';
  delete process.env.NORMOS_API_TOKEN;
  try {
    const res = await request(app).get('/api/goals');
    assert.notEqual(res.status, 503, 'fail-closed must never trigger outside production');
  } finally {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    process.env.NORMOS_API_TOKEN = ORIGINAL_API_TOKEN;
  }
});

test('the admin/diagnostic surface stays reachable with NORMOS_ADMIN_TOKEN in production, unaffected by the general gate change', async () => {
  process.env.NODE_ENV = 'production';
  process.env.NORMOS_API_TOKEN = ORIGINAL_API_TOKEN;
  try {
    const res = await request(app).get('/api/diag/scheduler').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    assert.equal(res.status, 200);
  } finally {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

test('the admin/diagnostic surface still fails closed in production without NORMOS_ADMIN_TOKEN configured, same as before this change', async () => {
  process.env.NODE_ENV = 'production';
  process.env.NORMOS_API_TOKEN = ORIGINAL_API_TOKEN;
  const originalAdminToken = process.env.NORMOS_ADMIN_TOKEN;
  delete process.env.NORMOS_ADMIN_TOKEN;
  try {
    const res = await request(app).get('/api/diag/scheduler');
    assert.equal(res.status, 503);
  } finally {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    process.env.NORMOS_ADMIN_TOKEN = originalAdminToken;
  }
});
