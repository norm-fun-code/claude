const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createPlannerAccountsRouter } = require('../src/routes/planner-accounts');
const { shapeTransaction, transactionWindow, fetchTransactionPage } = require('../src/services/planner-transactions');

// ── The shape the planner's store is keyed on ────────────────────────────
// Its sync is incremental and idempotent, so the id must be stable and stringified, and
// `updatedAt` / `pending` must survive — those are what make a recategorisation weeks later
// get re-read, and a hold reconcile into the charge that replaces it.
test('shapes a transaction into the row the planner upserts against', () => {
  const r = shapeTransaction({ id: 12345, date: '2026-03-05T00:00:00Z', amount: -104.25,
    merchant: { id: 9, name: 'Store' }, category: { id: 7, name: 'Groceries' },
    account: { id: 'a1', displayName: 'Chase' }, pending: true, plaidName: 'STORE #22',
    tags: [{ id: 1, name: 'reimbursable' }], updatedAt: '2026-03-06T00:00:00Z' });
  assert.equal(r.id, '12345');                 // stringified: a mixed-type key breaks the upsert
  assert.equal(r.categoryId, '7');
  assert.equal(r.accountId, 'a1');
  assert.equal(r.date, '2026-03-05');
  assert.equal(r.amount, -104.25);
  assert.equal(r.pending, true);
  assert.equal(r.updatedAt, '2026-03-06T00:00:00Z');
  assert.deepEqual(r.tags, ['reimbursable']);
});

test('drops a row with no id rather than passing it on to fail deeper in', () => {
  assert.equal(shapeTransaction({ amount: -10 }), null);
  assert.equal(shapeTransaction(null), null);
});

test('keeps a real zero and a missing category without inventing either', () => {
  const r = shapeTransaction({ id: '1', date: '2026-03-05', amount: 0 });
  assert.equal(r.amount, 0);
  assert.equal(r.categoryId, null);
  assert.equal(r.categoryName, '');
});

// ── The window is validated, not trusted ─────────────────────────────────
test('refuses an unbounded, inverted or oversized window', () => {
  const bad = [
    {}, { start: '2026-01-01' }, { start: 'nonsense', end: '2026-03-01' },
    { start: '2026-03-01', end: '2026-01-01' },
    { start: '2026-01-01', end: '2026-03-01', limit: 0 },
    { start: '2026-01-01', end: '2026-03-01', limit: 5000 },
    { start: '2026-01-01', end: '2026-03-01', offset: -1 },
  ];
  for (const q of bad) assert.throws(() => transactionWindow(q), undefined, JSON.stringify(q));
  assert.deepEqual(transactionWindow({ start: '2026-01-01', end: '2026-03-01' }),
    { startDate: '2026-01-01', endDate: '2026-03-01', offset: 0, limit: 100 });
});

test('pages through the window the caller asked for, and reports the total', async () => {
  const seen = [];
  const gql = async (t, q, v) => { seen.push(v); return { allTransactions: { totalCount: 250,
    results: [{ id: '1', date: '2026-03-05', amount: -1 }] } }; };
  const page = await fetchTransactionPage(gql, 'tok', { startDate: '2026-03-01', endDate: '2026-03-31', offset: 100, limit: 50 });
  assert.equal(page.totalCount, 250);
  assert.equal(page.results.length, 1);
  assert.equal(seen[0].offset, 100);
  assert.equal(seen[0].limit, 50);
  assert.deepEqual(seen[0].filters, { startDate: '2026-03-01', endDate: '2026-03-31' });
});

// ── The endpoint ─────────────────────────────────────────────────────────
function setup({ configured = true, fail = null, calls = { n: 0 } } = {}) {
  const db = { query: async () => ({ rows: [{ id: 'monarch', config: {} }] }) };
  const api = {
    getAccounts: async () => [],
    getPlannerTransactions: async (tok, w) => {
      calls.n++;
      if (fail) throw Object.assign(new Error('upstream'), { response: { status: fail } });
      return { totalCount: 1, results: [{ id: '1', date: '2026-03-05', amount: -1 }] };
    },
    getPlannerCategories: async () => {
      if (fail) throw Object.assign(new Error('upstream'), { response: { status: fail } });
      return [{ id: '1', name: 'Groceries', group: { id: 'g', name: 'Food', type: 'expense' } }];
    },
  };
  const env = configured ? { PLANNER_BRIDGE_TOKEN: 'read-only-secret', MONARCH_TOKEN: 'private-monarch-token' } : {};
  const app = express();
  app.use('/integrations/planner', createPlannerAccountsRouter({ db, api, env, now: () => Date.parse('2026-09-16T12:00:00Z'), publish: async () => {} }));
  return { app, calls,
    get: (qs = 'start=2026-03-01&end=2026-03-31', auth = true) => {
      const r = request(app).get('/integrations/planner/transactions?' + qs);
      return auth ? r.set('Authorization', 'Bearer read-only-secret') : r;
    } };
}

test('is behind the same read-only credential as the rest of the bridge', async () => {
  const unconfigured = setup({ configured: false });
  await unconfigured.get().expect(503);
  assert.equal(unconfigured.calls.n, 0);

  const s = setup();
  await s.get('start=2026-03-01&end=2026-03-31', false).expect(401);
  await request(s.app).get('/integrations/planner/transactions?start=2026-03-01&end=2026-03-31')
    .set('Authorization', 'Bearer wrong').expect(401);
  assert.equal(s.calls.n, 0, 'a rejected caller must never reach Monarch');
});

test('returns a page, and never the Monarch token with it', async () => {
  const s = setup();
  const r = await s.get().expect(200);
  assert.equal(r.body.totalCount, 1);
  assert.equal(r.body.results[0].id, '1');
  assert.ok(r.body.asOf);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.ok(!JSON.stringify(r.body).includes('private-monarch-token'));
});

test('rejects a bad window with 400, not by asking Monarch for everything', async () => {
  const s = setup();
  await s.get('start=2026-03-01').expect(400);
  await s.get('start=2026-03-31&end=2026-03-01').expect(400);
  assert.equal(s.calls.n, 0);
});

test('names an expired session distinctly from a rate limit, and leaks nothing', async () => {
  const expired = await setup({ fail: 401 }).get().expect(503);
  assert.match(expired.body.error, /reconnect/i);
  assert.ok(!JSON.stringify(expired.body).includes('private-monarch-token'));

  const throttled = await setup({ fail: 429 }).get().expect(503);
  assert.match(throttled.body.error, /rate-limit/i);
});

test('backs off after a failure instead of hammering Monarch', async () => {
  const s = setup({ fail: 500 });
  await s.get().expect(503);
  await s.get().expect(503);
  assert.equal(s.calls.n, 1, 'the second request is answered from the cooldown');
});

test('serves categories under the same credential', async () => {
  const s = setup();
  const r = await request(s.app).get('/integrations/planner/categories')
    .set('Authorization', 'Bearer read-only-secret').expect(200);
  assert.equal(r.body.categories.length, 1);
  await request(s.app).get('/integrations/planner/categories').expect(401);
});
