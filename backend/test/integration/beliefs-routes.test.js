// Beliefs router — "What NormOS currently believes" (Health tab redesign,
// audit rec #4). Exercises the real HTTP surface (routes/beliefs.js) against
// a real Postgres: list, confirm, edit, retire, forget.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const beliefsStore = require('../../src/store/beliefs');

const app = buildTestApp();
const TAG = `belief-route-test-${Date.now()}`;
const key = (s) => `${TAG}:${s}`;

after(async () => {
  await db.query(`DELETE FROM beliefs WHERE dedup_key LIKE $1`, [`${TAG}:%`]);
  await closeDb();
});

test('GET /api/beliefs requires auth and lists an unconfirmed belief as "supported" (not a fabricated hypothesis/disputed state)', async () => {
  const unauth = await request(app).get('/api/beliefs');
  assert.equal(unauth.status, 401);

  await beliefsStore.upsertBelief({
    kind: 'user_statement', dedupKey: key('a'),
    statement: 'Skips cold showers when sick.', confidence: 0.8, evidence: {},
  });
  const res = await request(app).get('/api/beliefs').set(authHeader());
  assert.equal(res.status, 200);
  const belief = res.body.beliefs.find((b) => b.statement.includes('cold showers'));
  assert.ok(belief);
  assert.equal(belief.status, 'supported');
  assert.equal(belief.confirmedAt, null);
});

test('a low-confidence, unconfirmed belief lists as "hypothesis"', async () => {
  await beliefsStore.upsertBelief({
    kind: 'dismissal_pattern', dedupKey: key('h'),
    statement: 'Maybe dismisses budget insights on weekends.', confidence: 0.2, evidence: {},
  });
  const res = await request(app).get('/api/beliefs').set(authHeader());
  const belief = res.body.beliefs.find((b) => b.statement.includes('budget insights'));
  assert.equal(belief.status, 'hypothesis');
});

test('POST /api/beliefs/:id/confirm marks it confirmed and it stays confirmed on the next list', async () => {
  await beliefsStore.upsertBelief({
    kind: 'user_statement', dedupKey: key('c'),
    statement: 'Trains fasted in the morning.', confidence: 0.3, evidence: {},
  });
  const before = (await request(app).get('/api/beliefs').set(authHeader())).body.beliefs
    .find((b) => b.statement.includes('fasted'));
  assert.equal(before.status, 'hypothesis', 'low confidence, unconfirmed — starts as hypothesis');

  const confirmRes = await request(app).post(`/api/beliefs/${before.id}/confirm`).set(authHeader());
  assert.equal(confirmRes.status, 200);

  const after1 = (await request(app).get('/api/beliefs').set(authHeader())).body.beliefs
    .find((b) => b.id === before.id);
  assert.equal(after1.status, 'confirmed', 'an explicit user confirmation overrides confidence-based status');
});

test('PATCH /api/beliefs/:id edits the statement text', async () => {
  await beliefsStore.upsertBelief({
    kind: 'user_statement', dedupKey: key('e'),
    statement: 'Original wording.', confidence: 0.6, evidence: {},
  });
  const belief = (await request(app).get('/api/beliefs').set(authHeader())).body.beliefs
    .find((b) => b.statement === 'Original wording.');

  const res = await request(app).patch(`/api/beliefs/${belief.id}`).set(authHeader()).send({ statement: 'Corrected wording.' });
  assert.equal(res.status, 200);

  const after1 = (await request(app).get('/api/beliefs').set(authHeader())).body.beliefs
    .find((b) => b.id === belief.id);
  assert.equal(after1.statement, 'Corrected wording.');
});

test('PATCH /api/beliefs/:id rejects an empty statement', async () => {
  await beliefsStore.upsertBelief({
    kind: 'user_statement', dedupKey: key('e2'),
    statement: 'Keep me.', confidence: 0.6, evidence: {},
  });
  const belief = (await request(app).get('/api/beliefs').set(authHeader())).body.beliefs
    .find((b) => b.statement === 'Keep me.');
  const res = await request(app).patch(`/api/beliefs/${belief.id}`).set(authHeader()).send({ statement: '  ' });
  assert.equal(res.status, 400);
});

test('POST /api/beliefs/:id/retire moves it to retired — it still lists (as history) but never as active', async () => {
  await beliefsStore.upsertBelief({
    kind: 'user_statement', dedupKey: key('r'),
    statement: 'Retire me.', confidence: 0.6, evidence: {},
  });
  const belief = (await request(app).get('/api/beliefs').set(authHeader())).body.beliefs
    .find((b) => b.statement === 'Retire me.');

  const res = await request(app).post(`/api/beliefs/${belief.id}/retire`).set(authHeader());
  assert.equal(res.status, 200);

  const after1 = (await request(app).get('/api/beliefs').set(authHeader())).body.beliefs
    .find((b) => b.id === belief.id);
  assert.equal(after1.status, 'retired');

  const active = await beliefsStore.listActive();
  assert.ok(!active.some((b) => b.id === belief.id), 'a retired belief must never be re-promoted/injected as active');
});

test('DELETE /api/beliefs/:id ("Forget") hard-deletes — distinct from Retire', async () => {
  await beliefsStore.upsertBelief({
    kind: 'user_statement', dedupKey: key('f'),
    statement: 'Forget me.', confidence: 0.6, evidence: {},
  });
  const belief = (await request(app).get('/api/beliefs').set(authHeader())).body.beliefs
    .find((b) => b.statement === 'Forget me.');

  const res = await request(app).delete(`/api/beliefs/${belief.id}`).set(authHeader());
  assert.equal(res.status, 200);

  const after1 = (await request(app).get('/api/beliefs').set(authHeader())).body.beliefs
    .find((b) => b.id === belief.id);
  assert.equal(after1, undefined, 'Forget must remove the row entirely, unlike Retire');
});

test('a 404 for confirm/patch/retire/forget on a nonexistent id never throws', async () => {
  const missingId = 999999999;
  const confirm = await request(app).post(`/api/beliefs/${missingId}/confirm`).set(authHeader());
  assert.equal(confirm.status, 404);
  const patch = await request(app).patch(`/api/beliefs/${missingId}`).set(authHeader()).send({ statement: 'x' });
  assert.equal(patch.status, 404);
  const retire = await request(app).post(`/api/beliefs/${missingId}/retire`).set(authHeader());
  assert.equal(retire.status, 404);
  const del = await request(app).delete(`/api/beliefs/${missingId}`).set(authHeader());
  assert.equal(del.status, 404);
});
