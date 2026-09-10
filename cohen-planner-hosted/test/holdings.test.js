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
    expect(sent.headers.Authorization).toBe('Token tok'); // same auth path as balances
    expect(rows[0].ticker).toBe('FXAIX');
  });

  it('turns an expired session into a message worth showing', async () => {
    const live = withToken(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await expect(live.holdings({ startDate: 'a', endDate: 'b' })).rejects.toThrow(/session expired/i);
  });

  it('treats GraphQL errors on a 200 as unavailable, not as an empty portfolio', async () => {
    const live = withToken(ok({ errors: [{ message: 'Cannot query field' }] }));
    await expect(live.holdings({ startDate: 'a', endDate: 'b' })).rejects.toThrow(/could not return holdings/i);
  });

  it('says so plainly when there is no direct Monarch connection', async () => {
    const live = createMonarchLive({ db: { query: async () => ({ rows: [{ data: {} }] }) }, fetchImpl: async () => { throw new Error('should not be called'); }, env: {}, now: () => Date.now() });
    await expect(live.holdings({ startDate: 'a', endDate: 'b' })).rejects.toThrow(/direct Monarch connection/i);
  });
});
