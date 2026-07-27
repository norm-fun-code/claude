// Smoke test for GET /api/diag/morning-status (audit fix, item 8) — proves
// the endpoint composes readiness/retry-ledger/build-job/publication/push
// state without crashing, is admin-gated, and never leaks a secret/token.
'use strict';
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, closeDb } = require('./helpers');

const app = buildTestApp();
const ADMIN_TOKEN = process.env.NORMOS_ADMIN_TOKEN;

after(async () => { await closeDb(); });

test('GET /diag/morning-status requires the admin token', async () => {
  const res = await request(app).get('/api/diag/morning-status');
  assert.equal(res.status, 401);
});

test('GET /diag/morning-status returns a well-shaped, secret-free status payload', async () => {
  const res = await request(app).get('/api/diag/morning-status').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  assert.equal(res.status, 200);
  assert.ok('readiness' in res.body);
  assert.ok('generationAttemptsToday' in res.body);
  assert.ok('activeBuild' in res.body);
  assert.ok('lastBuild' in res.body);
  assert.ok('lastPublication' in res.body);
  assert.ok('lastPush' in res.body);
  const raw = JSON.stringify(res.body);
  assert.equal(raw.includes(ADMIN_TOKEN), false, 'must never echo the admin token back');
  assert.equal(/sk-|Bearer /.test(raw), false, 'must never leak an API key or auth header shape');
});
