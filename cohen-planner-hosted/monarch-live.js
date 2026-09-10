'use strict';
const crypto = require('crypto');
const { extractAccounts } = require('./monarch-accounts');
const TTL = 5 * 60 * 1000;
// Reuse the exact account query already used by NormOS. Credentials never leave the server.
const QUERY = 'query NormOS_Accounts { accounts { id displayName currentBalance } }';
// Individual holdings. Monarch's own Investments page reads them through `portfolio`, and
// aggregateHoldings rolls the same security held in several accounts into one position,
// which is what the portfolio view wants. `basis` is what makes an all-time return possible.
const HOLDINGS_QUERY = `query NormOS_Holdings($input: PortfolioInput) {
  portfolio(input: $input) {
    aggregateHoldings { edges { node {
      id quantity basis totalValue
      securityPriceChangeDollars securityPriceChangePercent
      security { id name ticker type typeDisplay }
      holdings { id name ticker type typeDisplay value }
    } } }
  }
}`;
// Monarch's type names vs. the ones the portfolio view already renders.
const TYPE_ALIASES = { cryptocurrency: 'crypto', mutualfund: 'mutual_fund', fixed_income: 'bond', fixedincome: 'bond' };
function normaliseType(t) {
  const k = String(t || 'other').toLowerCase().replace(/[\s-]+/g, '_');
  return TYPE_ALIASES[k] || TYPE_ALIASES[k.replace(/_/g, '')] || k;
}
const numOr0 = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') { const n = parseFloat(v.replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; }
  return 0;
};
// Tolerant of where the edges land: this query shape is Monarch's undocumented web API, so
// accept the payload whether it arrives nested under data/portfolio or already unwrapped.
function extractHoldingEdges(payload) {
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node.edges)) return node.edges;
    for (const v of Object.values(node)) { const hit = walk(v, depth + 1); if (hit) return hit; }
    return null;
  };
  return walk(payload?.aggregateHoldings ?? payload, 0) || [];
}
function mapHoldings(payload) {
  const rows = extractHoldingEdges(payload).map(e => {
    const n = e?.node ?? e ?? {};
    const sec = n.security || (Array.isArray(n.holdings) ? n.holdings[0] : null) || {};
    const value = numOr0(n.totalValue ?? n.value);
    const basis = numOr0(n.basis);
    const allTimeChange = basis > 0 ? value - basis : 0;
    return {
      ticker: sec.ticker || sec.name || '\u2014',
      name: sec.name || sec.ticker || '',
      value: Math.round(value),
      securityType: normaliseType(sec.type ?? sec.typeDisplay),
      periodChange: Math.round(numOr0(n.securityPriceChangeDollars) * 100) / 100,
      periodChangePct: Math.round(numOr0(n.securityPriceChangePercent) * 100) / 100,
      allTimeChange: Math.round(allTimeChange * 100) / 100,
      allTimePct: basis > 0 ? Math.round(allTimeChange / basis * 10000) / 100 : 0,
    };
  }).filter(h => h.value !== 0);
  if (!rows.length) throw new Error('Monarch returned no holdings.');
  return rows.sort((a, b) => b.value - a.value);
}
function validSnapshot(value) {
  if (value?.version !== 1 || !Number.isFinite(Date.parse(value.asOf))) return null;
  try { extractAccounts(value.accounts); return value; } catch { return null; }
}
function createMonarchLive({ db, fetchImpl = fetch, env = process.env, now = Date.now }) {
  let pending = null, retryAfter = 0, lastWarning = null;
  async function context() {
    const { rows } = await db.query("SELECT data FROM oauth_tokens WHERE key = 'monarch_bridge'");
    const local = rows[0]?.data || {};
    let sources = [];
    try {
      const r = await db.query("SELECT id, config->'plannerAccounts' AS snapshot, config->>'monarchToken' AS token FROM sources WHERE id IN ('monarch', 'monarch_mcp_sync', 'monarch_api')");
      sources = r.rows;
    } catch (e) { if (e.code !== '42P01') throw e; } // Standalone planner DB.
    const snapshots = [local.snapshot, ...sources.map(s => s.snapshot)].map(validSnapshot).filter(Boolean).sort((a,b) => Date.parse(b.asOf)-Date.parse(a.asOf));
    return { disabled: !!local.disabled, snapshot: snapshots[0] || null, token: env.MONARCH_TOKEN || sources.find(s => s.token)?.token || null, remote: !!(env.NORMOS_URL && env.PLANNER_BRIDGE_TOKEN) };
  }
  async function status() {
    const c = await context();
    return { connected: !c.disabled && !!(c.snapshot || c.token || c.remote), source: c.snapshot?.source || 'normos-api', asOf: c.snapshot?.asOf || null };
  }
  async function setEnabled(enabled) {
    await db.query(`INSERT INTO oauth_tokens (key,data) VALUES ('monarch_bridge',$1::jsonb)
      ON CONFLICT (key) DO UPDATE SET data = oauth_tokens.data || EXCLUDED.data`, [JSON.stringify({ disabled: !enabled })]);
  }
  async function pull() {
    const c = await context();
    if (c.disabled) throw new Error('Planner sync is paused. Enable NormOS sync to resume.');
    let snapshot = c.snapshot, warning = now() < retryAfter ? lastWarning : null;
    if (c.remote) {
      if ((!snapshot || now()-Date.parse(snapshot.asOf)>=TTL) && now()>=retryAfter) {
        try {
          const base = new URL(env.NORMOS_URL);
          if(base.protocol!=='https:' || base.username || base.password)throw new Error('Invalid NormOS connection URL.');
          const response = await fetchImpl(new URL('/integrations/planner/accounts',base).href, {
            headers:{Authorization:`Bearer ${env.PLANNER_BRIDGE_TOKEN}`},
            signal:AbortSignal.timeout(30000), redirect:'error',
          });
          if(!response.ok)throw new Error('NormOS account source is unavailable.');
          const data=await response.json();
          if(!validSnapshot(data))throw new Error('NormOS returned incomplete account data.');
          warning = data.warning ? 'NormOS could not refresh Monarch; showing its last successful observation.' : null;
          if(!snapshot || Date.parse(data.asOf)>=Date.parse(snapshot.asOf)) {
            snapshot={...data,source:'normos-bridge'};
            await db.query(`INSERT INTO oauth_tokens (key,data) VALUES ('monarch_bridge',$1::jsonb)
              ON CONFLICT (key) DO UPDATE SET data = oauth_tokens.data || EXCLUDED.data`, [JSON.stringify({snapshot})]);
          }
          lastWarning=warning;
          // Even a stale-but-valid imported snapshot should not cause repeated network calls.
          retryAfter=now()+TTL;
        } catch(e) {
          warning='NormOS account sync unavailable. Previous balances retained.';
          lastWarning=warning;retryAfter=now()+TTL;
        }
      }
    }
    if (!c.remote && c.token && (!snapshot || now() - Date.parse(snapshot.asOf) >= TTL) && now() >= retryAfter) {
      try {
        const response = await graphql(c.token, QUERY, {});
        if (!response.ok) throw new Error(response.status === 401 ? 'Monarch session expired. Reconnect Monarch in NormOS.' : response.status === 429 ? 'Monarch is rate-limiting refreshes. Showing the last successful sync.' : 'Monarch refresh is temporarily unavailable.');
        const data = await response.json();
        if (data.errors) throw new Error('Monarch could not return complete balances.');
        const accounts = extractAccounts(data.data?.accounts);
        lastWarning = null;
        snapshot = { version: 1, accounts, asOf: new Date(now()).toISOString(), source: 'normos-api' };
        await db.query(`INSERT INTO oauth_tokens (key,data) VALUES ('monarch_bridge',$1::jsonb)
          ON CONFLICT (key) DO UPDATE SET data = oauth_tokens.data || EXCLUDED.data`, [JSON.stringify({ snapshot })]);
      } catch (err) {
        retryAfter = now() + TTL;
        warning = err.name === 'TimeoutError' ? 'Monarch refresh timed out. Showing the last successful sync.' : 'Monarch refresh unavailable. Check the connection in NormOS; previous balances retained.';
        lastWarning = warning;
        if (!snapshot) throw new Error(warning);
      }
    }
    if (!snapshot && warning) throw new Error(warning);
    if (!snapshot) throw new Error('Waiting for the next NormOS Monarch account sync. Run the existing Monarch sync in NormOS.');
    const stale = now() - Date.parse(snapshot.asOf) > 24 * 60 * 60 * 1000;
    return { ...snapshot, stale, warning, bankUpdatedAt: null };
  }
  // One request path for every Monarch GraphQL call, so headers and auth can't drift.
  function graphql(token, query, variables) {
    return fetchImpl('https://api.monarch.com/graphql', {
      method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        Authorization: `Token ${token}`, Origin: 'https://app.monarchmoney.com',
        'Client-Platform': 'web', 'x-cio-client-platform': 'web',
        'x-cio-site-id': '2598be4aa410159198b2',
        'device-uuid': env.MONARCH_DEVICE_UUID || crypto.randomUUID(),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
      }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000),
    });
  }

  // Individual holdings. Deliberately NOT cached alongside the balance snapshot: balances
  // are the plan's anchor and are worth serving stale, whereas holdings are a live view and
  // a stale one is worse than an honest "unavailable".
  async function holdings({ startDate, endDate }) {
    const c = await context();
    if (c.disabled) throw new Error('Planner sync is paused. Enable NormOS sync to resume.');
    if (!c.token) throw new Error('Individual holdings need a direct Monarch connection. Reconnect Monarch in NormOS.');
    let response;
    try {
      response = await graphql(c.token, HOLDINGS_QUERY, { input: { startDate, endDate, includeHiddenHoldings: false } });
    } catch (err) {
      throw new Error(err.name === 'TimeoutError' ? 'Monarch timed out returning holdings.' : 'Monarch is unreachable for holdings.');
    }
    if (!response.ok) {
      throw new Error(response.status === 401 ? 'Monarch session expired. Reconnect Monarch in NormOS.'
        : response.status === 429 ? 'Monarch is rate limiting. Try again shortly.'
        : 'Monarch could not return holdings.');
    }
    const body = await response.json();
    // A GraphQL 200 can still carry errors, and the schema here is undocumented — surface
    // that as "unavailable" rather than rendering an empty portfolio as though it were real.
    // Log the upstream detail: this query was written against Monarch's web API without a
    // token to verify it, so a field-name mismatch is the most likely first failure and
    // "Cannot query field X on type Y" is the difference between a fix and a guess.
    if (body.errors) {
      try { console.warn('Monarch holdings query rejected:', body.errors.map(e => e && e.message).filter(Boolean).join(' | ')); } catch {}
      throw new Error('Monarch could not return holdings for this account.');
    }
    return mapHoldings(body.data?.portfolio ?? body.data ?? body);
  }

  function getSnapshot() {
    if (!pending) pending = pull().finally(() => { pending = null; });
    return pending;
  }
  return { status, getSnapshot, setEnabled, holdings };
}
module.exports = { createMonarchLive, validSnapshot, mapHoldings, normaliseType, extractHoldingEdges };
