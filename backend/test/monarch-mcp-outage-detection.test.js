// The MCP sync's own success path (`markSync` with no error) fires as long as
// `c.sync(ctx)` doesn't throw — regardless of whether the DATA it returned was
// real. When Monarch's API rejects every read (expired/rate-limited/IP-blocked)
// but the RPC calls themselves don't throw (they just return empty), the sync
// silently wrote hollow zero-valued metrics and reported success every run —
// so the sources-staleness alert (which only fires on a thrown error or a stale
// last_sync_at) never caught it. `incomeCats.size === 0 && txns.length === 0`
// (GetCategories AND GetTransactions both empty) is a near-impossible outcome
// for a genuinely-working, configured connection with real history, so
// syncViaMcp now throws in that case instead of silently succeeding.
//
// These tests stub the RPC layer and the outer monarch-api fallback to verify
// the full chain: syncViaMcp throws on total outage, the exported sync()
// wrapper's try/catch correctly ATTEMPTS the GraphQL fallback in response
// (previously this fallback was never even attempted, since a silent hollow
// "success" from syncViaMcp never threw anything to catch), and a genuine
// double-failure (fallback also broken) propagates all the way out so
// runConnector's catch can mark the source status='error'.
const test = require('node:test');
const assert = require('node:assert/strict');
const rpc = require('../src/services/monarch-mcp-rpc');
const monarchMcp = require('../src/services/monarch-mcp');
const monarchApi = require('../src/connectors/monarch-api');
const sourcesStore = require('../src/store/sources');

monarchMcp.isConfigured = () => true;
sourcesStore.registerSource = async () => {}; // no live DB in this test env

const monarchMcpSync = require('../src/connectors/monarch-mcp-sync');

test('syncViaMcp throws on a total outage (0 categories, 0 transactions)', async () => {
  rpc.callToolJson = async (tool) => {
    if (tool === 'GetTransactions') return { transactions: [] };
    if (tool === 'GetCategories') return { categories: [] };
    if (tool === 'GetAccounts') return { total_balance: 0 };
    return {};
  };
  await assert.rejects(
    () => monarchMcpSync.syncViaMcp({}),
    /total sync failure/,
  );
});

test('syncViaMcp does NOT throw when there are transactions but genuinely zero income this window', async () => {
  rpc.callToolJson = async (tool) => {
    if (tool === 'GetTransactions') {
      return { transactions: [{ id: 't1', date: new Date().toISOString().slice(0, 10), amount: -42, category: 'Groceries', category_type: 'expense' }] };
    }
    if (tool === 'GetCategories') return { categories: [{ name: 'Groceries', category_type: 'expense' }] };
    if (tool === 'GetAccounts') return { total_balance: 1000 };
    if (tool === 'GetCashFlow') return { data: [] };
    return {};
  };
  const result = await monarchMcpSync.syncViaMcp({});
  assert.ok(result.metrics.length > 0, 'a real (if income-free) sync should still write metrics, not throw');
});

test('the exported sync() wrapper falls back to the GraphQL connector when syncViaMcp throws on total outage', async () => {
  rpc.callToolJson = async (tool) => {
    if (tool === 'GetTransactions') return { transactions: [] };
    if (tool === 'GetCategories') return { categories: [] };
    if (tool === 'GetAccounts') return { total_balance: 0 };
    return {};
  };
  let fallbackCalled = false;
  monarchApi.sync = async () => { fallbackCalled = true; return { metrics: [{ fake: true }], documents: [] }; };
  const result = await monarchMcpSync.sync({});
  assert.equal(fallbackCalled, true, 'the GraphQL fallback must actually be attempted, not silently skipped');
  assert.deepEqual(result, { metrics: [{ fake: true }], documents: [] });
});

test('if BOTH the MCP path AND the GraphQL fallback fail, the error propagates out of sync() (so runConnector can mark status=error)', async () => {
  rpc.callToolJson = async (tool) => {
    if (tool === 'GetTransactions') return { transactions: [] };
    if (tool === 'GetCategories') return { categories: [] };
    if (tool === 'GetAccounts') return { total_balance: 0 };
    return {};
  };
  monarchApi.sync = async () => { throw new Error('Monarch 429 at data fetch'); };
  await assert.rejects(() => monarchMcpSync.sync({}), /429/);
});
