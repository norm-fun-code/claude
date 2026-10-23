import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createMonarchMcp, toolPayload } = require('../monarch-mcp.js');
const C = require('../monarch-mcp-compare.js');

function memDb() {
  const rows = new Map();
  return { rows, query: async (sql, params) => {
    if (/^SELECT/i.test(sql)) return { rows: rows.has(params[0]) ? [{ data: rows.get(params[0]) }] : [] };
    rows.set(params[0], JSON.parse(params[1])); return { rows: [] };
  } };
}
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });

// A fake Monarch: registration, tokens with rotation, and a JSON-RPC MCP endpoint.
function fakeMonarch({ tools, results, tokenTtl = 3600 } = {}) {
  const log = []; let issued = 0; const live = new Set();
  const fetchImpl = async (url, o = {}) => {
    const u = String(url);
    if (u.endsWith('/oauth/register')) { log.push('register'); return res(201, { client_id: 'cid' }); }
    if (u.endsWith('/oauth/token/')) {
      const f = new URLSearchParams(o.body);
      log.push('token:' + f.get('grant_type'));
      if (f.get('grant_type') === 'refresh_token') {
        if (!live.has(f.get('refresh_token'))) return res(400, { error: 'invalid_grant' });
        live.delete(f.get('refresh_token'));
      }
      issued++; live.add('r' + issued);
      return res(200, { access_token: 'a' + issued, refresh_token: 'r' + issued, expires_in: tokenTtl });
    }
    if (u.endsWith('/oauth/revoke/')) return res(200, {});
    if (u.endsWith('/mcp')) {
      const b = JSON.parse(o.body); log.push('mcp:' + b.method);
      if (b.method === 'initialize') return res(200, { jsonrpc: '2.0', id: b.id, result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 's1' });
      if (b.method === 'notifications/initialized') return res(202, '');
      if (b.method === 'tools/list') return res(200, `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { tools } })}\n\n`);
      if (b.method === 'tools/call') { log.push(b.params); return res(200, { jsonrpc: '2.0', id: b.id, result: results(b.params) }); }
    }
    return res(404, {});
  };
  return { fetchImpl, log, live };
}
async function connected(f, opts = {}) {
  const db = memDb(); let t = 0;
  const mcp = createMonarchMcp({ db, fetchImpl: f.fetchImpl, now: () => opts.now ? opts.now() : 1e12 + t });
  const { url, pending } = await mcp.startConnect('https://planner.example/api/monarch-mcp/callback');
  const q = new URL(url).searchParams;
  expect(q.get('code_challenge_method')).toBe('S256');
  expect(q.get('scope')).toBe('mcp:read');
  expect(q.get('resource')).toBe('https://api.monarch.com/mcp');
  await mcp.finishConnect({ code: 'c', state: pending.state }, pending);
  return { mcp, db };
}
const TOOLS = [
  { name: 'GetTransactions', inputSchema: { properties: { start_date: {}, end_date: {}, limit: {}, offset: {}, intent: { enum: ['budgeting', 'other'] } } } },
  { name: 'GetAccounts', inputSchema: { properties: { intent: { enum: ['other'] }, intent_description: {} } } },
];

describe('Monarch MCP sign-in and tokens', () => {
  it('registers, signs in with PKCE, and refuses a callback from another browser session', async () => {
    const f = fakeMonarch({ tools: TOOLS, results: () => ({}) });
    const { mcp } = await connected(f);
    expect(f.log.slice(0, 2)).toEqual(['register', 'token:authorization_code']);
    expect((await mcp.status()).connected).toBe(true);
    const other = createMonarchMcp({ db: memDb(), fetchImpl: f.fetchImpl });
    const { pending } = await other.startConnect('https://x/cb');
    await expect(other.finishConnect({ code: 'c', state: 'forged' }, pending)).rejects.toThrow(/did not match/);
  });
  it('refreshes once for concurrent callers, so a rotating refresh token is never spent twice', async () => {
    let clock = 1e12;
    const f = fakeMonarch({ tools: TOOLS, results: () => ({}), tokenTtl: 60 });
    const { mcp } = await connected(f, { now: () => clock });
    clock += 3600e3;   // expired
    const [a, b] = await Promise.all([mcp.accessToken(), mcp.accessToken()]);
    expect(a).toBe('a2'); expect(b).toBe('a2');
    expect(f.log.filter(x => x === 'token:refresh_token')).toHaveLength(1);
  });
  it('says plainly when the grant is dead, instead of failing quietly forever', async () => {
    let clock = 1e12;
    const f = fakeMonarch({ tools: TOOLS, results: () => ({}), tokenTtl: 60 });
    const { mcp } = await connected(f, { now: () => clock });
    f.live.clear(); clock += 3600e3;
    expect(await mcp.accessToken()).toBe(null);
    const st = await mcp.status();
    expect(st.connected).toBe(false); expect(st.needsReconnect).toBe(true);
    await expect(mcp.rpc('tools/list', {})).rejects.toThrow(/not connected/);
  });
});

describe('Monarch MCP calls', () => {
  it('hands shakes once, reads SSE, and builds arguments from each tool’s own schema', async () => {
    const f = fakeMonarch({ tools: TOOLS, results: () => ({ structuredContent: { transactions: [] } }) });
    const { mcp } = await connected(f);
    await mcp.call('GetTransactions', { startDate: '2026-01-01', endDate: '2026-01-31', limit: 100, offset: 0 });
    await mcp.call('GetAccounts');
    expect(f.log.filter(x => x === 'mcp:initialize')).toHaveLength(1);
    const calls = f.log.filter(x => x && x.name);
    expect(calls[0].arguments).toEqual({ start_date: '2026-01-01', end_date: '2026-01-31', limit: 100, offset: 0, intent: 'budgeting' });
    expect(calls[1].arguments).toEqual({ intent: 'other', intent_description: 'personal financial planning' });
  });
  it('reports a filter a tool cannot take, rather than dropping it', () => {
    const mcp = createMonarchMcp({ db: memDb() });
    const { missing } = mcp.buildArgs({ inputSchema: { properties: { limit: {} } } }, { startDate: '2026-01-01', limit: 5 });
    expect(missing).toEqual(['startDate']);
  });
  it('reads JSON from structured content or a text block, and never echoes upstream error text', () => {
    expect(toolPayload({ structuredContent: { a: 1 } })).toEqual({ a: 1 });
    expect(toolPayload({ content: [{ type: 'text', text: '{"b":2}' }] })).toEqual({ b: 2 });
    try { toolPayload({ isError: true, content: [{ type: 'text', text: 'acct 1234 balance $9' }] }); }
    catch (e) { expect(e.message).not.toMatch(/1234|\$9/); }
  });
});

describe('comparing the MCP with the current sync', () => {
  it('finds the records wherever the payload nests them, and refuses one without its fields', () => {
    expect(C.accountsFrom({ data: { accounts: [{ id: 1, displayName: 'Chk', currentBalance: '1,200.50' }] } })[0].balance).toBe(1200.5);
    expect(C.transactionsFrom({ allTransactions: { totalCount: 1, results: [{ id: 't', date: '2026-01-02T00:00', amount: -5, category: { id: 9 } }] } }).rows[0])
      .toMatchObject({ id: 't', date: '2026-01-02', amount: -5, categoryId: '9' });
    expect(() => C.transactionsFrom({ transactions: [{ id: 't', amount: -5 }] })).toThrow();
  });
  it('matches transactions by id and reports every kind of difference, with month totals', () => {
    const win = { startDate: '2026-01-01', endDate: '2026-02-28' };
    const mine = [{ id: '1', date: '2026-01-05', amount: -10, categoryId: 'a' }, { id: '2', date: '2026-02-01', amount: -20, categoryId: 'a' }, { id: '3', date: '2026-02-02', amount: -1, categoryId: 'a' }];
    const theirs = [{ id: '1', date: '2026-01-05', amount: -10, categoryId: 'a' }, { id: '2', date: '2026-02-01', amount: -25, categoryId: 'b' }, { id: '4', date: '2026-02-03', amount: -2, categoryId: 'a' }];
    const r = C.compareTransactions(mine, theirs, win);
    expect(r.matched).toBe(2); expect(r.ok).toBe(false);
    expect(r.amountDiffsCount).toBe(1); expect(r.categoryDiffsCount).toBe(1);
    expect(r.onlyPlannerCount).toBe(1); expect(r.onlyMcpCount).toBe(1);
    expect(r.months.find(m => m.month === '2026-02')).toMatchObject({ planner: -21, mcp: -27, diff: -6 });
    expect(C.compareTransactions(mine, mine, win).ok).toBe(true);
  });
  it('treats a missing balance on one side as a difference, never as zero', () => {
    const r = C.compareAccounts([{ id: '1', name: 'A', balance: null }], [{ id: '1', name: 'A', balance: 0 }]);
    expect(r.ok).toBe(false); expect(r.balanceDiffs[0]).toMatchObject({ planner: null, mcp: 0 });
  });
});

describe('the MCP is verification only', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  it('is not wired into any import, balance or holdings path', () => {
    const block = server.slice(server.indexOf("const monarchMcp = require('./monarch-mcp')"), server.indexOf("app.get('/api/monarch-diagnostics'"));
    expect(block).not.toMatch(/INSERT|UPDATE |DELETE |monarchSync\.(backfill|incremental|syncCategories)|save\(/);
    // The data paths still use the current client.
    expect(server).toContain("require('./monarch-holdings').createMonarchHoldings({db,client:monarchClient})");
    expect(server).toContain("require('./monarch-transactions').createMonarchTransactions({ db,client:monarchClient })");
  });
});
