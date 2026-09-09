'use strict';
const crypto = require('crypto');
const { extractAccounts } = require('./monarch-accounts');
const TTL = 5 * 60 * 1000;
// Reuse the exact account query already used by NormOS. Credentials never leave the server.
const QUERY = 'query NormOS_Accounts { accounts { id displayName currentBalance } }';
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
    return { disabled: !!local.disabled, snapshot: snapshots[0] || null, token: env.MONARCH_TOKEN || sources.find(s => s.token)?.token || null };
  }
  async function status() {
    const c = await context();
    return { connected: !c.disabled && !!(c.snapshot || c.token), source: c.snapshot?.source || 'normos-api', asOf: c.snapshot?.asOf || null };
  }
  async function setEnabled(enabled) {
    await db.query(`INSERT INTO oauth_tokens (key,data) VALUES ('monarch_bridge',$1::jsonb)
      ON CONFLICT (key) DO UPDATE SET data = oauth_tokens.data || EXCLUDED.data`, [JSON.stringify({ disabled: !enabled })]);
  }
  async function pull() {
    const c = await context();
    if (c.disabled) throw new Error('Planner sync is paused. Enable NormOS sync to resume.');
    let snapshot = c.snapshot, warning = now() < retryAfter ? lastWarning : null;
    if (c.token && (!snapshot || now() - Date.parse(snapshot.asOf) >= TTL) && now() >= retryAfter) {
      try {
        const response = await fetchImpl('https://api.monarch.com/graphql', {
          method: 'POST', headers: {
            'Content-Type': 'application/json', Accept: 'application/json',
            Authorization: `Token ${c.token}`, Origin: 'https://app.monarchmoney.com',
            'Client-Platform': 'web', 'x-cio-client-platform': 'web',
            'x-cio-site-id': '2598be4aa410159198b2',
            'device-uuid': env.MONARCH_DEVICE_UUID || crypto.randomUUID(),
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
          }, body: JSON.stringify({ query: QUERY, variables: {} }), signal: AbortSignal.timeout(15000),
        });
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
    if (!snapshot) throw new Error('Waiting for the next NormOS Monarch account sync. Run the existing Monarch sync in NormOS.');
    const stale = now() - Date.parse(snapshot.asOf) > 24 * 60 * 60 * 1000;
    return { ...snapshot, stale, warning, bankUpdatedAt: null };
  }
  function getSnapshot() {
    if (!pending) pending = pull().finally(() => { pending = null; });
    return pending;
  }
  return { status, getSnapshot, setEnabled };
}
module.exports = { createMonarchLive, validSnapshot };
