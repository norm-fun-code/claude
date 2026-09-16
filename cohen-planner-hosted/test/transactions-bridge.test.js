import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { createTransactionsBridge } = require('../transactions-bridge.js');
const { createMonarchSync } = require('../monarch-sync.js');

const ENV = { NORMOS_URL: 'https://normos.example.com', PLANNER_BRIDGE_TOKEN: 'bridge-secret' };
const row = (id, over = {}) => ({ id: String(id), date: '2026-03-05', amount: -100,
  merchant: 'Store', plaidName: '', notes: '', categoryId: '1', categoryName: 'Groceries',
  accountId: 'a1', accountName: 'Chase', pending: false, hideFromReports: false,
  isRecurring: false, isSplitTransaction: false, tags: [], updatedAt: '2026-03-06T00:00:00Z',
  createdAt: null, ...over });

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body) => ({ ok: false, status, json: async () => body });

function bridge({ respond, env = ENV } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, opts) => { calls.push({ url, opts }); return respond ? respond(url) : ok({ totalCount: 1, results: [row(1)] }); });
  return { b: createTransactionsBridge({ env, fetchImpl }), calls, fetchImpl };
}

describe('the transaction feed travels the same bridge as the balances', () => {
  it('asks the planner endpoint with the bridge token and the window it was given', async () => {
    const { b, calls } = bridge();
    await b.transactionsPage({ startDate: '2026-03-01', endDate: '2026-03-31', offset: 200, limit: 50 });
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe('https://normos.example.com/integrations/planner/transactions');
    expect(Object.fromEntries(u.searchParams)).toEqual({ start: '2026-03-01', end: '2026-03-31', offset: '200', limit: '50' });
    expect(calls[0].opts.headers.Authorization).toBe('Bearer bridge-secret');
    expect(calls[0].opts.cache).toBe('no-store');
    expect(calls[0].opts.redirect).toBe('error');   // a redirect must not carry the credential on
    expect(u.href).not.toMatch(/monarch/i);
  });

  it('refuses to send the credential anywhere but a plain https origin', async () => {
    for (const NORMOS_URL of ['http://normos.example.com', 'https://user:pw@normos.example.com']) {
      const { b, fetchImpl } = bridge({ env: { ...ENV, NORMOS_URL } });
      await expect(b.transactionsPage({ startDate: '2026-03-01', endDate: '2026-03-31' })).rejects.toThrow(/HTTPS origin/);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('says what is missing when it is not configured', async () => {
    const { b } = bridge({ env: {} });
    await expect(b.transactionsPage({ startDate: '2026-03-01', endDate: '2026-03-31' })).rejects.toThrow(/not configured/);
  });

  it('never returns the bridge token to a caller', async () => {
    const { b } = bridge();
    const page = await b.transactionsPage({ startDate: '2026-03-01', endDate: '2026-03-31' });
    expect(JSON.stringify(page)).not.toContain('bridge-secret');
  });
});

describe('a page the sync can trust, or no page at all', () => {
  // monarch-sync reads a malformed page as evidence its own stored history is corrupt and
  // abandons the window. Rejecting here means a bad payload costs one window, not a backfill.
  it('rejects a page missing its total or its rows', async () => {
    for (const body of [{}, { totalCount: 'many', results: [] }, { totalCount: -1, results: [] }, { totalCount: 1 }, { totalCount: 1, results: 'nope' }]) {
      const { b } = bridge({ respond: () => ok(body) });
      await expect(b.transactionsPage({ startDate: '2026-03-01', endDate: '2026-03-31' })).rejects.toThrow(/incomplete transaction page/i);
    }
  });

  it('rejects rows with no id or no date, which cannot be upserted', async () => {
    for (const results of [[{ amount: -1 }], [row(1), { id: null, date: '2026-03-05' }], [{ id: '1' }]]) {
      const { b } = bridge({ respond: () => ok({ totalCount: results.length, results }) });
      await expect(b.transactionsPage({ startDate: '2026-03-01', endDate: '2026-03-31' })).rejects.toThrow(/without ids or dates/i);
    }
  });

  it('passes a well-formed page through untouched', async () => {
    const { b } = bridge({ respond: () => ok({ totalCount: 2, results: [row(1), row(2)] }) });
    const page = await b.transactionsPage({ startDate: '2026-03-01', endDate: '2026-03-31' });
    expect(page.totalCount).toBe(2);
    expect(page.results.map(r => r.id)).toEqual(['1', '2']);
  });
});

describe('failures that read differently because they are different', () => {
  it('names a rejected credential', async () => {
    const { b } = bridge({ respond: () => fail(401, { error: 'unauthorized' }) });
    await expect(b.transactionsPage({ startDate: '2026-03-01', endDate: '2026-03-31' })).rejects.toThrow(/rejected the planner connection/i);
  });

  it('passes a 400 through as this side\'s bug, not as "try again"', async () => {
    // A window NormOS refuses will never succeed on retry, and saying "temporarily
    // unavailable" would have the sync waiting for a fix that is not coming.
    const { b } = bridge({ respond: () => fail(400, { error: 'The window ends before it starts.' }) });
    await expect(b.transactionsPage({ startDate: '2026-03-31', endDate: '2026-03-01' })).rejects.toThrow('The window ends before it starts.');
  });

  it('passes a 503 message through word for word', async () => {
    const said = 'The Monarch connection in NormOS needs to reconnect.';
    const { b } = bridge({ respond: () => fail(503, { error: said }) });
    await expect(b.transactionsPage({ startDate: '2026-03-01', endDate: '2026-03-31' })).rejects.toThrow(said);
  });
});

// ── The contract the sync was written against ────────────────────────────
// Its paging, idempotency and deletion guards were built for Monarch. They are unchanged, so
// the bridge has to satisfy the same contract — proven by driving the real sync through it.
describe('the real sync runs on it, unchanged', () => {
  function fakeDb() {
    const tx = new Map(), kv = new Map();
    return { tx, async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('CREATE')) return { rows: [] };
      if (s.startsWith('SELECT data FROM oauth_tokens')) { const v = kv.get(params[0]); return { rows: v ? [{ data: v }] : [] }; }
      if (s.startsWith('INSERT INTO oauth_tokens')) { kv.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
      if (s.startsWith('INSERT INTO monarch_transactions')) {
        const [id, date, amount] = params; tx.set(id, { id, date, amount }); return { rows: [] };
      }
      if (s.startsWith('UPDATE monarch_transactions SET deleted_at')) return { rows: [] };
      if (s.startsWith('SELECT COUNT(*)::int AS n')) return { rows: [{ n: tx.size, first_date: null, last_date: null, pending: 0, last_row_sync: null }] };
      return { rows: [] };
    } };
  }

  it('pages a window through the bridge and stores every row once', async () => {
    const all = Array.from({ length: 5 }, (_, i) => row(i));
    const fetchImpl = async (url) => {
      const u = new URL(url), off = Number(u.searchParams.get('offset')), lim = Number(u.searchParams.get('limit'));
      return ok({ totalCount: all.length, results: all.slice(off, off + lim) });
    };
    const live = createTransactionsBridge({ env: ENV, fetchImpl });
    const db = fakeDb();
    const sync = createMonarchSync({ db, live });
    const r = await sync.pullWindow('2026-03-01', '2026-03-31');
    expect(r.written).toBe(5);
    expect(db.tx.size).toBe(5);
  });

  it('no longer refuses with "No transaction feed"', async () => {
    // The whole point: monarch-sync guards every write path on the feed being present, and
    // monarchLive — which reads balances — never satisfied it.
    const sync = createMonarchSync({ db: fakeDb(), live: createTransactionsBridge({ env: ENV, fetchImpl: async () => ok({ totalCount: 0, results: [] }) }) });
    await expect(sync.pullWindow('2026-03-01', '2026-03-31')).resolves.toBeTruthy();

    const without = createMonarchSync({ db: fakeDb(), live: { status: async () => ({}) } });
    await expect(without.pullWindow('2026-03-01', '2026-03-31')).rejects.toThrow(/No transaction feed/);
  });

  it('is what the server actually hands the sync', () => {
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    expect(src).toContain("createMonarchSync({ db, live: require('./transactions-bridge').createTransactionsBridge() })");
    expect(src).not.toContain('createMonarchSync({ db, live: monarchLive })');
  });
});
