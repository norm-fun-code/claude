// A single briefing build calls monarch-wealth's getRecurring/getAccounts from
// TWO places (server.js directly, then again inside buildWealthInsights()) —
// same RPC, same data, fetched twice per build. monarch-wealth.js now memoizes
// the parameterless call shape for a short TTL. These tests stub the RPC layer
// and verify: repeated calls within the TTL hit the RPC once, concurrent calls
// dedupe onto the same in-flight promise, a failure doesn't poison the cache,
// and calls with explicit args bypass the cache entirely.
const test = require('node:test');
const assert = require('node:assert/strict');
const rpc = require('../src/services/monarch-mcp-rpc');
const monarchMcp = require('../src/services/monarch-mcp');

monarchMcp.isConfigured = () => true;

// Re-require fresh each test file run — module-level `cache` Map persists across
// tests in this file, so each test uses a distinct RPC tool name/category where
// order matters, or we accept residual cache state and design around it below.
const monarchWealth = require('../src/services/monarch-wealth');

test('getAccounts hits the RPC once for repeated calls within the TTL', async () => {
  let calls = 0;
  rpc.callToolJson = async (tool) => {
    if (tool === 'GetAccounts') {
      calls++;
      return { total_balance: 1000, accounts: [{ name: 'Checking', type: 'depository', current_balance: 1000 }] };
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  const a = await monarchWealth.getAccounts();
  const b = await monarchWealth.getAccounts();
  assert.equal(calls, 1, 'second call within TTL should be served from cache, not a new RPC call');
  assert.equal(a.netWorth, b.netWorth);
});

test('concurrent getRecurring calls dedupe onto one in-flight RPC call', async () => {
  let calls = 0;
  rpc.callToolJson = async (tool) => {
    if (tool === 'GetRecurring') {
      calls++;
      await new Promise((r) => setTimeout(r, 15));
      return { recurring_expense_streams: [], recurring_income_streams: [] };
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  const [a, b] = await Promise.all([monarchWealth.getRecurring(), monarchWealth.getRecurring()]);
  assert.equal(calls, 1, 'two concurrent calls should share one in-flight RPC call');
  assert.deepEqual(a, b);
});

test('a failed call is not cached — the next call retries the RPC', async () => {
  let calls = 0;
  rpc.callToolJson = async (tool) => {
    if (tool === 'GetInvestments') {
      calls++;
      if (calls === 1) throw new Error('transient RPC failure');
      return { investments: [{ ticker: 'ABC', value: 500 }] };
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  await assert.rejects(() => monarchWealth.getInvestments());
  const result = await monarchWealth.getInvestments();
  assert.equal(calls, 2, 'the failed first call must not poison the cache for the retry');
  assert.equal(result.totalValue, 500);
});

test('getBudgetPacing with an explicit `now` bypasses the cache', async () => {
  let calls = 0;
  rpc.callToolJson = async (tool) => {
    if (tool === 'GetBudget') {
      calls++;
      return { data: [] };
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  await monarchWealth.getBudgetPacing({ now: new Date('2026-07-01') });
  await monarchWealth.getBudgetPacing({ now: new Date('2026-07-02') });
  assert.equal(calls, 2, 'explicit-args calls must each hit the RPC, never sharing the parameterless cache slot');
});
