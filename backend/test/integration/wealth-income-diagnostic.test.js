// GET /api/debug/wealth-income — the reconciliation diagnostic added for the
// MTD discretionary-spending bug bash. Verifies: MTD scoping uses the LOCAL
// (America/New_York) calendar month, stored spending/spending_discretionary
// metrics are grouped by day+source+metric (investigation requirement #2),
// the category-level breakdown reconciles exactly to the total (requirement
// #7), and the derived (total - fixed) discretionary figure is reported
// alongside the legacy independently-filtered comparison value.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const rpc = require('../../src/services/monarch-mcp-rpc');
const monarchMcp = require('../../src/services/monarch-mcp');
const { buildTestApp, authHeader, ADMIN_TOKEN, closeDb } = require('./helpers');
const db = require('../../src/db');
const metricsStore = require('../../src/store/metrics');
const sourcesStore = require('../../src/store/sources');

const app = buildTestApp();
const ORIGINAL_CALL_TOOL_JSON = rpc.callToolJson;
const ORIGINAL_IS_CONFIGURED = monarchMcp.isConfigured;
const TEST_SOURCE = `test-wealth-diag-${Date.now()}`;

const CATEGORIES = { categories: [
  { name: 'Groceries', category_type: 'expense' }, { name: 'Rent', category_type: 'expense' },
  { name: 'Paychecks', category_type: 'income' },
] };

function stubRpc(transactions) {
  rpc.callToolJson = async (tool) => {
    if (tool === 'GetTransactions') return { transactions };
    if (tool === 'GetCategories') return CATEGORIES;
    if (tool === 'GetCashFlow') return { data: [] };
    return {};
  };
}

test.before(async () => {
  await sourcesStore.registerSource({ id: TEST_SOURCE, domain: 'wealth', displayName: 'Test wealth diag source' });
});

afterEach(async () => {
  rpc.callToolJson = ORIGINAL_CALL_TOOL_JSON;
  monarchMcp.isConfigured = ORIGINAL_IS_CONFIGURED;
  await db.query(`DELETE FROM metrics WHERE source = $1`, [TEST_SOURCE]);
});

after(async () => {
  await db.query(`DELETE FROM sources WHERE id = $1`, [TEST_SOURCE]);
  await closeDb();
});

test('requires the admin token, not just the general app token', async () => {
  const res = await request(app).get('/api/debug/wealth-income').set(authHeader());
  assert.equal(res.status, 401);
});

test('category breakdown reconciles exactly to the total spend, and derived discretionary matches total minus fixed', async () => {
  monarchMcp.isConfigured = () => true;
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  stubRpc([
    { id: 'd1', date: yesterday, amount: -120.5, category: 'Groceries' },
    { id: 'd2', date: yesterday, amount: -5695, category: 'Rent' },
  ]);

  const res = await request(app).get('/api/debug/wealth-income?mtd=1').set(authHeader(ADMIN_TOKEN));
  assert.equal(res.status, 200);
  assert.equal(res.body.window.mtd, true);
  assert.equal(res.body.categoryTotalReconciles, true, 'summing every category must reconcile exactly to the total');
  assert.equal(res.body.categoryTotal, 5815.5);
  assert.equal(res.body.derivedDiscretionary.totalExpense, 5815.5);
  assert.equal(res.body.derivedDiscretionary.fixedHousing, 5695);
  assert.equal(res.body.derivedDiscretionary.discretionary, 120.5);
  const rentCategory = res.body.categoryBreakdown.find((c) => c.category === 'Rent');
  assert.equal(rentCategory.fixed, true);
  const groceriesCategory = res.body.categoryBreakdown.find((c) => c.category === 'Groceries');
  assert.equal(groceriesCategory.fixed, false);
});

test('storedMetrics groups the actual stored rows by day, source, and metric — surfacing a stale row a live sync would miss', async () => {
  monarchMcp.isConfigured = () => true;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  await metricsStore.insertMetrics([
    { ts: today, domain: 'wealth', metric: 'spending', value: 500, source: TEST_SOURCE },
    { ts: today, domain: 'wealth', metric: 'spending_discretionary', value: 500, source: TEST_SOURCE },
  ]);
  stubRpc([]); // live Monarch reports nothing new this window — the stored rows above are what we're checking are VISIBLE, not what the live probe recomputes
  const res = await request(app).get('/api/debug/wealth-income?days=1').set(authHeader(ADMIN_TOKEN));
  assert.equal(res.status, 200);
  const storedRow = res.body.storedMetrics.spending.rows.find((r) => r.source === TEST_SOURCE);
  assert.ok(storedRow, 'the stored spending row must be visible in the grouped-by-day/source/metric output');
  assert.equal(storedRow.value, 500);
  const storedDiscRow = res.body.storedMetrics.spending_discretionary.rows.find((r) => r.source === TEST_SOURCE);
  assert.equal(storedDiscRow.value, 500);
});

test('legacyExcludeCategoriesDiscretionary is reported for comparison but is not what derivedDiscretionary uses', async () => {
  monarchMcp.isConfigured = () => true;
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  stubRpc([{ id: 'd1', date: yesterday, amount: -300, category: 'Groceries' }]);
  const res = await request(app).get('/api/debug/wealth-income?mtd=1').set(authHeader(ADMIN_TOKEN));
  assert.ok('legacyExcludeCategoriesDiscretionary' in res.body);
  assert.ok(res.body.legacyExcludeCategoriesDiscretionary.note.includes('NOT used by the sync'));
});

// A live Monarch-side outage (e.g. their API paused/down) must not suppress
// storedMetrics — that's the one signal that's most valuable precisely when
// the live API is unavailable. The endpoint must degrade to 200 + liveDataError
// rather than a bare 500.
test('a live Monarch fetch failure still returns storedMetrics, degrading to a liveDataError field instead of a 500', async () => {
  monarchMcp.isConfigured = () => true;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  await metricsStore.insertMetrics([
    { ts: today, domain: 'wealth', metric: 'spending', value: 250, source: TEST_SOURCE },
  ]);
  rpc.callToolJson = async () => {
    throw new Error('The Monarch MCP is temporarily paused while we work through a data portability question raised by one of our partners.');
  };
  const res = await request(app).get('/api/debug/wealth-income?mtd=1').set(authHeader(ADMIN_TOKEN));
  assert.equal(res.status, 200);
  assert.ok(res.body.liveDataError, 'a live-Monarch failure must surface as liveDataError, not a 500');
  assert.ok(res.body.liveDataError.includes('temporarily paused'));
  const storedRow = res.body.storedMetrics.spending.rows.find((r) => r.source === TEST_SOURCE);
  assert.ok(storedRow, 'storedMetrics must still be present and correct even when the live Monarch fetch fails');
  assert.equal(storedRow.value, 250);
});
