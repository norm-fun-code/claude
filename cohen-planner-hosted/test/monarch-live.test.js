import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createMonarchLive, validSnapshot, BRIDGE_PATH, TTL } = require('../monarch-live');

// Balances reach the planner one way: the NormOS account bridge. There is no Monarch client
// here any more, no stored session and nothing to sign in to — so what these tests pin is the
// bridge contract, and above all the three things NormOS can say about a snapshot that are
// NOT errors: stale, warning, and partial. Each one used to be a reason the view went blank.

const now = Date.parse('2026-09-09T12:00:00Z');
const ENV = { NORMOS_URL: 'https://normos.example.com', PLANNER_BRIDGE_TOKEN: 'bridge-secret' };
const payload = (over = {}) => ({
  version: 1, asOf: '2026-09-09T11:59:00Z', source: 'normos-api',
  accounts: [{ id: '1', displayName: 'Checking', currentBalance: 0 }, { id: '2', displayName: '401k', currentBalance: 200 }],
  partial: false, missingAccounts: [], warning: null, stale: false, ...over,
});
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body) => ({ ok: false, status, json: async () => body });

function setup({ local = {}, shared = null, env = ENV, respond, missing = false } = {}) {
  const db = { query: vi.fn(async (sql, args) => {
    if (sql.startsWith('SELECT data')) return { rows: [{ data: local }] };
    if (sql.includes('FROM sources')) { if (missing) throw Object.assign(new Error('missing'), { code: '42P01' }); return { rows: [{ snapshot: shared }] }; }
    if (sql.startsWith('INSERT')) Object.assign(local, JSON.parse(args[0]));
    return { rows: [] };
  }) };
  const fetchImpl = vi.fn(respond || (async () => ok(payload())));
  return { bridge: createMonarchLive({ db, fetchImpl, env, now: () => now }), db, fetchImpl, local };
}

describe('the NormOS account bridge is the only path', () => {
  it('asks the one endpoint, with a bearer token, and never reaches Monarch', async () => {
    const { bridge, fetchImpl } = setup();
    const data = await bridge.getSnapshot();
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://normos.example.com' + BRIDGE_PATH);
    expect(opts.headers.Authorization).toBe('Bearer bridge-secret');
    expect(opts.cache).toBe('no-store');   // the response is no-store; do not let anything hold it
    expect(opts.redirect).toBe('error');   // a redirect must never carry the credential onward
    expect(url).not.toMatch(/monarch/i);
    expect(data.accounts[0].currentBalance).toBe(0);   // a real zero survives
  });

  it('says what is missing when it is not configured, rather than failing vaguely', async () => {
    await expect(setup({ env: {} }).bridge.getSnapshot()).rejects.toThrow(/NORMOS_URL and PLANNER_BRIDGE_TOKEN/);
    await expect(setup({ env: { NORMOS_URL: ENV.NORMOS_URL } }).bridge.getSnapshot()).rejects.toThrow(/NORMOS_URL and PLANNER_BRIDGE_TOKEN/);
  });

  it('refuses to send the credential over anything but a plain https origin', async () => {
    for (const NORMOS_URL of ['http://normos.example.com', 'https://user:pw@normos.example.com']) {
      const { bridge, fetchImpl } = setup({ env: { ...ENV, NORMOS_URL } });
      await expect(bridge.getSnapshot()).rejects.toThrow(/https origin/);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('never returns the bridge token to a caller', async () => {
    const { bridge } = setup();
    expect(JSON.stringify(await bridge.status())).not.toContain('bridge-secret');
    expect(JSON.stringify(await bridge.diagnose())).not.toContain('bridge-secret');
    expect(JSON.stringify(await bridge.getSnapshot())).not.toContain('bridge-secret');
  });
});

// ── The three states that are not errors ─────────────────────────────────
describe('a snapshot NormOS qualifies is still a snapshot', () => {
  it('renders stale balances and flags them, never discards them', async () => {
    const { bridge } = setup({ respond: async () => ok(payload({ stale: true })) });
    const d = await bridge.getSnapshot();
    expect(d.stale).toBe(true);
    expect(d.accounts).toHaveLength(2);     // the whole point: the data is still here
  });

  it('shows the data AND the warning when NormOS could not refresh from Monarch', async () => {
    const said = 'Monarch refresh failed at 04:12; showing the last successful observation.';
    const { bridge } = setup({ respond: async () => ok(payload({ warning: said })) });
    const d = await bridge.getSnapshot();
    expect(d.warning).toBe(said);           // verbatim — NormOS knows things this process cannot
    expect(d.accounts).toHaveLength(2);
    expect(d.stale).toBe(false);            // a warning is not staleness and not an error
  });

  it('keeps the accounts that did report when some had no balance', async () => {
    const { bridge } = setup({ respond: async () => ok(payload({ partial: true, missingAccounts: [{ id: '9', name: 'Unlinked' }] })) });
    const d = await bridge.getSnapshot();
    expect(d.partial).toBe(true);
    expect(d.missingAccounts).toEqual([{ id: '9', name: 'Unlinked' }]);
    expect(d.accounts).toHaveLength(2);
  });

  it('trusts NormOS’s own staleness verdict over the age of what we hold', async () => {
    // Fresh by the clock, but NormOS says the underlying observation is old.
    const { bridge } = setup({ respond: async () => ok(payload({ stale: true, asOf: '2026-09-09T11:59:00Z' })) });
    expect((await bridge.getSnapshot()).stale).toBe(true);
  });
});

// ── Failures ─────────────────────────────────────────────────────────────
describe('failures are distinguished, and never blank what was already observed', () => {
  it('names the trailing-newline trap on a 401, because nothing else can', async () => {
    const { bridge } = setup({ respond: async () => fail(401, { error: 'unauthorized' }) });
    await expect(bridge.getSnapshot()).rejects.toThrow(/trailing newline|whitespace/i);
  });

  it('passes a 503 message through word for word', async () => {
    const said = 'No Monarch snapshot yet; the first sync runs at 07:00.';
    const { bridge } = setup({ respond: async () => fail(503, { error: said }) });
    await expect(bridge.getSnapshot()).rejects.toThrow(said);
  });

  it('holds the last good balances through a failed refresh and explains why', async () => {
    const held = payload({ asOf: '2026-09-09T10:00:00Z' });
    const { bridge } = setup({ local: { snapshot: held }, respond: async () => fail(503, { error: 'NormOS is reindexing.' }) });
    const d = await bridge.getSnapshot();
    expect(d.asOf).toBe(held.asOf);          // nothing was discarded
    expect(d.accounts).toHaveLength(2);
    expect(d.warning).toBe('NormOS is reindexing.');
  });

  it('refuses a malformed payload rather than storing it over real balances', async () => {
    const held = payload({ asOf: '2026-09-09T10:00:00Z' });
    for (const body of [{ version: 2, asOf: held.asOf, accounts: held.accounts }, { version: 1, asOf: 'nonsense', accounts: [] }, { version: 1, asOf: held.asOf, accounts: [] }]) {
      const { bridge } = setup({ local: { snapshot: held }, respond: async () => ok(body) });
      expect((await bridge.getSnapshot()).asOf).toBe(held.asOf);
      expect(validSnapshot(body)).toBeNull();
    }
  });

  it('never advances the observation time backwards', async () => {
    const newer = payload({ asOf: '2026-09-09T11:00:00Z' });
    const { bridge } = setup({ local: { snapshot: newer }, respond: async () => ok(payload({ asOf: '2026-09-01T00:00:00Z' })) });
    expect((await bridge.getSnapshot()).asOf).toBe(newer.asOf);
  });
});

describe('request pacing', () => {
  it('does not poll faster than NormOS refreshes, and coalesces concurrent callers', async () => {
    const { bridge, fetchImpl } = setup({ local: {} });
    const [a, b] = await Promise.all([bridge.getSnapshot(), bridge.getSnapshot()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);   // coalesced server-side too, but never twice from here
    expect(a).toEqual(b);
    await bridge.getSnapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(1);   // still inside the window NormOS itself honours
    expect(TTL).toBe(5 * 60 * 1000);
  });

  it('backs off for the same window after a failure instead of hammering', async () => {
    const { bridge, fetchImpl } = setup({ local: { snapshot: payload({ asOf: '2026-09-09T10:00:00Z' }) }, respond: async () => fail(503, { error: 'not ready' }) });
    await bridge.getSnapshot();
    await bridge.getSnapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serves a snapshot already in the database without calling out at all', async () => {
    const { bridge, fetchImpl } = setup({ shared: payload() });
    expect((await bridge.getSnapshot()).accounts).toHaveLength(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('works against a standalone planner database with no sources table', async () => {
    const { bridge } = setup({ missing: true });
    expect((await bridge.getSnapshot()).accounts).toHaveLength(2);
  });

  it('a paused sync stops the refresh outright', async () => {
    const { bridge, fetchImpl } = setup({ local: { disabled: true } });
    await expect(bridge.getSnapshot()).rejects.toThrow(/paused/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('diagnostics', () => {
  const find = (d, name) => d.checks.find(c => c.name === name);

  it('names an unset variable instead of reporting a connection failure', async () => {
    const d = await setup({ env: {} }).bridge.diagnose();
    expect(find(d, 'NormOS bridge configured').ok).toBe(false);
    expect(find(d, 'NormOS bridge configured').detail).toMatch(/both unset/);
    expect(find(d, 'NormOS bridge configured').fix).toMatch(/not a Monarch token/);
    expect(find(d, 'NormOS accepts the bridge token')).toBeUndefined();  // no cascade
  });

  it('distinguishes a rejected token from a NormOS with nothing to publish', async () => {
    const un = await setup({ respond: async () => fail(401, { error: 'unauthorized' }) }).bridge.diagnose();
    expect(find(un, 'NormOS accepts the bridge token').ok).toBe(false);
    expect(find(un, 'NormOS accepts the bridge token').fix).toMatch(/trailing newline/i);

    const empty = await setup({ respond: async () => fail(503, { error: 'Planner connection is not configured.' }) }).bridge.diagnose();
    expect(find(empty, 'NormOS returns balances').ok).toBe(false);
    expect(find(empty, 'NormOS returns balances').detail).toBe('Planner connection is not configured.');
  });

  it('reports stale, warning and partial as notes on a working connection, not failures', async () => {
    const d = await setup({ respond: async () => ok(payload({ stale: true, warning: 'Monarch refresh failed.', partial: true, missingAccounts: [{ id: '9', name: 'X' }] })) }).bridge.diagnose();
    expect(find(d, 'NormOS accepts the bridge token').ok).toBe(true);
    expect(find(d, 'balances returned').ok).toBe(true);
    for (const n of ['freshness', 'NormOS refresh', 'completeness']) expect(find(d, n).kind).toBe('info');
    expect(d.ok).toBe(true);   // a qualified snapshot is a working connection
  });

  it('says plainly that no Monarch credential is involved', async () => {
    const d = await setup().bridge.diagnose();
    expect(find(d, 'balance source').detail).toMatch(/holds no Monarch credential/);
    expect(d.ok).toBe(true);
  });
});
