import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { mapHoldings, normaliseType, extractHoldingEdges, createMonarchLive } = require('../monarch-live.js');

// A Monarch `portfolio` payload as the web API returns it. The query itself is undocumented,
// so the mapper is deliberately tolerant and these tests pin the shapes it must survive.
const node = (over = {}) => ({
  id: 'h1', quantity: 10, basis: 20000, totalValue: 30000,
  securityPriceChangeDollars: 500, securityPriceChangePercent: 1.7,
  security: { id: 's1', name: 'Fidelity 500 Index', ticker: 'FXAIX', type: 'mutual_fund' },
  holdings: [{ id: 'a1', ticker: 'FXAIX', value: 30000 }],
  ...over,
});
const payload = (nodes) => ({ aggregateHoldings: { edges: nodes.map(n => ({ node: n })) } });

describe('holdings mapper', () => {
  it('maps a position to the shape the portfolio view renders', () => {
    const [h] = mapHoldings(payload([node()]));
    expect(h).toMatchObject({
      ticker: 'FXAIX', name: 'Fidelity 500 Index', securityType: 'mutual_fund',
      value: 30000, periodChange: 500, periodChangePct: 1.7,
    });
    // all-time return is derived from cost basis, which the MCP feed never exposed
    expect(h.allTimeChange).toBe(10000);
    expect(h.allTimePct).toBe(50);
  });

  it('sorts by value, largest first', () => {
    const out = mapHoldings(payload([
      node({ totalValue: 1000, security: { ticker: 'A', type: 'equity' } }),
      node({ totalValue: 90000, security: { ticker: 'B', type: 'equity' } }),
    ]));
    expect(out.map(h => h.ticker)).toEqual(['B', 'A']);
  });

  it("translates Monarch's type names to the ones the view already renders", () => {
    expect(normaliseType('cryptocurrency')).toBe('crypto');
    expect(normaliseType('Mutual Fund')).toBe('mutual_fund');
    expect(normaliseType('fixed income')).toBe('bond');
    expect(normaliseType('equity')).toBe('equity');
    expect(normaliseType(undefined)).toBe('other');
  });

  it('falls back to the per-account holding when the security block is missing', () => {
    const [h] = mapHoldings(payload([node({ security: null, holdings: [{ ticker: 'MU', type: 'equity', value: 5000 }] })]));
    expect(h.ticker).toBe('MU');
    expect(h.securityType).toBe('equity');
  });

  it('survives string numerics and missing basis without producing NaN', () => {
    const [h] = mapHoldings(payload([node({ totalValue: '$12,500.00', basis: null, securityPriceChangeDollars: '-250' })]));
    expect(h.value).toBe(12500);
    expect(h.periodChange).toBe(-250);
    expect(h.allTimeChange).toBe(0); // no basis → no claimed all-time return
    expect(h.allTimePct).toBe(0);
  });

  it('drops zero-value positions but keeps real ones', () => {
    const out = mapHoldings(payload([node({ totalValue: 0 }), node({ totalValue: 7000 })]));
    expect(out).toHaveLength(1);
  });

  it('refuses to report an empty portfolio as a successful read', () => {
    expect(() => mapHoldings(payload([]))).toThrow(/no holdings/i);
    expect(() => mapHoldings({})).toThrow(/no holdings/i);
  });

  it('finds the edges whether or not the payload arrives unwrapped', () => {
    const nodes = [node()];
    expect(extractHoldingEdges(payload(nodes))).toHaveLength(1);
    expect(extractHoldingEdges({ data: { portfolio: payload(nodes) } })).toHaveLength(1);
    expect(extractHoldingEdges(payload(nodes).aggregateHoldings)).toHaveLength(1);
  });
});

describe('holdings transport', () => {
  const withToken = (fetchImpl) => createMonarchLive({
    db: { query: async () => ({ rows: [{ data: {} }] }) },
    fetchImpl, env: { MONARCH_TOKEN: 'tok', MONARCH_DEVICE_UUID: 'uuid' }, now: () => Date.now(),
  });
  const ok = body => async () => ({ ok: true, status: 200, json: async () => body });

  it('sends the period through and returns mapped rows', async () => {
    let sent;
    const live = withToken(async (url, opts) => { sent = { url, body: JSON.parse(opts.body), headers: opts.headers }; return { ok: true, status: 200, json: async () => ({ data: { portfolio: payload([node()]) } }) }; });
    const rows = await live.holdings({ startDate: '2026-01-01', endDate: '2026-09-10' });
    expect(sent.url).toBe('https://api.monarch.com/graphql');
    expect(sent.body.variables.input).toMatchObject({ startDate: '2026-01-01', endDate: '2026-09-10' });
    expect(sent.body.variables.input.topMoversLimit).toBe(100);
    expect(sent.headers.Authorization).toBe('Token tok'); // same auth path as balances
    expect(rows[0].ticker).toBe('FXAIX');
  });

  it('turns an expired session into a message worth showing', async () => {
    const live = withToken(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await expect(live.holdings({ startDate: 'a', endDate: 'b' })).rejects.toThrow(/session expired/i);
  });

  it('treats GraphQL errors on a 200 as unavailable, not as an empty portfolio', async () => {
    // Rejected unscoped, no account ids come back either → genuinely unavailable.
    const live = withToken(ok({ errors: [{ message: 'Cannot query field' }] }));
    await expect(live.holdings({ startDate: 'a', endDate: 'b' })).rejects.toThrow(/could not return holdings/i);
  });

  it('never asks for `value` on the holdings sub-object', async () => {
    // Not a field on Monarch's Holding type — selecting it fails the entire query, which is
    // exactly how the first version of this broke.
    let sent;
    const live = withToken(async (u, o) => { sent = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ data: { portfolio: payload([node()]) } }) }; });
    await live.holdings({ startDate: 'a', endDate: 'b' });
    const sub = sent.query.slice(sent.query.indexOf('holdings {'));
    expect(sub.slice(0, sub.indexOf('}'))).not.toMatch(/\bvalue\b/);
    expect(sent.query).toContain('totalValue'); // the aggregate does carry it
  });

  it('retries scoped to account ids when the unscoped query is rejected', async () => {
    const calls = [];
    const live = withToken(async (u, o) => {
      const b = JSON.parse(o.body); calls.push(b);
      if (b.query.includes('NormOS_AccountIds')) return { ok: true, status: 200, json: async () => ({ data: { accounts: [{ id: 11 }, { id: 22 }] } }) };
      if (!b.variables.input.accountIds) return { ok: true, status: 200, json: async () => ({ errors: [{ message: 'accountIds required' }] }) };
      return { ok: true, status: 200, json: async () => ({ data: { portfolio: payload([node()]) } }) };
    });
    const rows = await live.holdings({ startDate: 'a', endDate: 'b' });
    expect(rows[0].ticker).toBe('FXAIX');
    expect(calls).toHaveLength(3); // unscoped → ids → scoped
    expect(calls[2].variables.input.accountIds).toEqual(['11', '22']);
  });

  it('does not make the extra round trip when the unscoped query works', async () => {
    const calls = [];
    const live = withToken(async (u, o) => { calls.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ data: { portfolio: payload([node()]) } }) }; });
    await live.holdings({ startDate: 'a', endDate: 'b' });
    expect(calls).toHaveLength(1);
    expect(calls[0].variables.input.accountIds).toBeUndefined();
  });

  it('says so plainly when there is no direct Monarch connection', async () => {
    const live = createMonarchLive({ db: { query: async () => ({ rows: [{ data: {} }] }) }, fetchImpl: async () => { throw new Error('should not be called'); }, env: {}, now: () => Date.now() });
    await expect(live.holdings({ startDate: 'a', endDate: 'b' })).rejects.toThrow(/direct Monarch connection/i);
  });
});

// ── Diagnostics ──────────────────────────────────────────────────────────
describe('connection diagnostics', () => {
  const make = (env, fetchImpl, dbData = {}) => createMonarchLive({
    db: { query: async () => ({ rows: [{ data: dbData }] }) },
    fetchImpl, env, now: () => Date.now(),
  });
  const find = (d, name) => d.checks.find(c => c.name === name);

  it('names a missing token as the first thing to fix', async () => {
    const d = await make({}, async () => { throw new Error('should not be called'); }).diagnose();
    expect(find(d, 'MONARCH_TOKEN present').ok).toBe(false);
    expect(d.ok).toBe(false);
    // and stops there rather than reporting a cascade of downstream failures
    expect(find(d, 'holdings query')).toBeUndefined();
  });

  it('reports a paused sync distinctly from a missing token', async () => {
    const d = await make({ MONARCH_TOKEN: 't' }, async () => { throw new Error('nope'); }, { disabled: true }).diagnose();
    expect(find(d, 'MONARCH_TOKEN present').ok).toBe(true);
    expect(find(d, 'balance source').kind).toBe('info'); // descriptive, never a red X
    expect(find(d, 'planner sync enabled').ok).toBe(false);
    expect(find(d, 'planner sync enabled').detail).toMatch(/paused/i);
  });

  it('identifies a rejected token by status rather than calling it unreachable', async () => {
    const d = await make({ MONARCH_TOKEN: 'bad' }, async () => ({ ok: false, status: 401, json: async () => ({}) })).diagnose();
    const c = find(d, 'Monarch accepts the token');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/401/);
    expect(c.detail).toMatch(/rejected or expired/i);
  });

  it('surfaces the upstream GraphQL message verbatim so a schema mismatch names its field', async () => {
    const d = await make({ MONARCH_TOKEN: 't' }, async (u, o) => {
      const b = JSON.parse(o.body);
      if (b.query.includes('NormOS_AccountIds')) return { ok: true, status: 200, json: async () => ({ data: { accounts: [{ id: '1' }] } }) };
      return { ok: true, status: 200, json: async () => ({ errors: [{ message: "Cannot query field 'basis' on type 'AggregateHolding'" }] }) };
    }).diagnose();
    expect(find(d, 'Monarch accepts the token').ok).toBe(true);
    expect(find(d, 'holdings query').ok).toBe(false);
    expect(find(d, 'holdings query').detail).toBeTruthy();
  });

  it('passes cleanly when everything works', async () => {
    const d = await make({ MONARCH_TOKEN: 't' }, async (u, o) => {
      const b = JSON.parse(o.body);
      if (b.query.includes('NormOS_AccountIds')) return { ok: true, status: 200, json: async () => ({ data: { accounts: [{ id: '1' }] } }) };
      if (b.query.includes('NormOS_Categories')) return { ok: true, status: 200, json: async () => ({ data: { categories: [{ id: '1', name: 'Groceries', group: { id: 'g', type: 'expense' } }] } }) };
      if (b.query.includes('NormOS_Transactions')) return { ok: true, status: 200, json: async () => ({ data: { allTransactions: { totalCount: 42, results: [] } } }) };
      return { ok: true, status: 200, json: async () => ({ data: { portfolio: { aggregateHoldings: { edges: [{ node: { totalValue: 100, basis: 50, security: { ticker: 'X', type: 'equity' } } }] } } } }) };
    }).diagnose();
    expect(d.ok).toBe(true);
    expect(find(d, 'holdings query').detail).toMatch(/1 position/);
    expect(find(d, 'transactions query').detail).toMatch(/42 transactions/);
  });

  it('never returns the token itself', async () => {
    const d = await make({ MONARCH_TOKEN: 'super-secret-value' }, async () => ({ ok: false, status: 401, json: async () => ({}) })).diagnose();
    expect(JSON.stringify(d)).not.toContain('super-secret-value');
  });
});

// ── The guard that silently disabled the whole feature ───────────────────
describe('portfolio view reaches the investments fetch', () => {
  const src = require('fs').readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function renderPortfolioTab'), src.indexOf('\n}', src.indexOf('function renderPortfolioTab')));

  it('does not short-circuit on a snapshot having a source', () => {
    // Every snapshot carries source:'normos-bridge' or 'normos-api', so an early return on
    // `monarchSnapshot?.source` meant loadMonarchInvestments() was never called and holdings
    // could never populate — regardless of the token. Correct while holdings were a stubbed
    // 503; silently disabled the feature the moment they worked.
    expect(fn).not.toMatch(/if\(monarchSnapshot\?\.source\)\{[\s\S]{0,400}?return;/);
  });

  it('still triggers the load when nothing is cached', () => {
    expect(fn).toMatch(/monarchInvestments===null/);
    expect(fn).toMatch(/loadMonarchInvestments\(\)/);
  });

  it('keeps the accounts card and the diagnostic on the failure path', () => {
    const fail = fn.slice(fn.indexOf('monarchInvestments===false'));
    expect(fail).toMatch(/renderMonarchAccountsCard\(\)/); // balances not lost when holdings fail
    expect(fail).toMatch(/runMonarchDiagnostics\(\)/);
  });
});
