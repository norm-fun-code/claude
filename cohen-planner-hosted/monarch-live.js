'use strict';
// ═══ ACCOUNT BALANCES, VIA NORMOS — THE ONLY MONARCH PATH ═══
//
// The planner holds no Monarch credential. It never signs in to Monarch, never calls
// Monarch's API, and stores no session. Every balance it shows comes from the NormOS
// account bridge:
//
//   GET <NORMOS_URL>/integrations/planner/accounts
//   Authorization: Bearer <PLANNER_BRIDGE_TOKEN>
//
// That is the whole integration. NormOS owns the Monarch session — one place that signs in,
// refreshes and backs off — and publishes the balances it observed. The planner used to keep
// a second copy of that session, which is the mistake this file exists to have undone: two
// copies of one credential means one of them is always the stale one, and the planner's copy
// was the one that could never refresh itself. Reintroducing any direct Monarch call here
// recreates that, whatever it is for.
//
// `PLANNER_BRIDGE_TOKEN` is scoped to this single endpoint. It is not a Monarch token and not
// the NormOS API token, and it never reaches the browser.
//
// What the bridge carries is ACCOUNT BALANCES. Individual holdings, transactions, categories,
// budgets and recurring charges are not on it, so the planner no longer reads them at all
// rather than keeping a credential alive to fetch them behind the scenes.

const { extractAccounts } = require('./monarch-accounts');
const DAY = 24 * 60 * 60 * 1000;
// NormOS refreshes from Monarch at most once every five minutes and backs off five minutes
// after a failure. Asking faster cannot produce newer data, so this is both our cache window
// and our retry floor.
const TTL = 5 * 60 * 1000;
const BRIDGE_PATH = '/integrations/planner/accounts';

// The bridge's own answer when the credential does not match. Its check is a length-first,
// timing-safe byte comparison, so a trailing newline in the environment variable fails
// exactly like a wrong token, with nothing in the response to tell them apart — which is
// worth saying out loud, because it is the likeliest cause and invisible everywhere else.
const UNAUTHORIZED = 'NormOS rejected PLANNER_BRIDGE_TOKEN (401). Check for a trailing newline or stray whitespace in the value before assuming it is the wrong one — the comparison is byte-exact and reports both the same way.';
const NOT_CONFIGURED = 'The NormOS account bridge is not configured. Set NORMOS_URL and PLANNER_BRIDGE_TOKEN to the values on the NormOS service.';
const NO_SNAPSHOT = 'Waiting for the first balances from NormOS. Run the Monarch sync in NormOS.';

function validSnapshot(value) {
  if (value?.version !== 1 || !Number.isFinite(Date.parse(value.asOf))) return null;
  try { extractAccounts(value.accounts); return value; } catch { return null; }
}

function createMonarchLive({ db, fetchImpl = fetch, env = process.env, now = Date.now }) {
  let pending = null, retryAfter = 0, lastWarning = null;

  async function context() {
    const { rows } = await db.query("SELECT data FROM oauth_tokens WHERE key = 'monarch_bridge'");
    const local = rows[0]?.data || {};
    // Snapshots a NormOS sync wrote straight into the shared database, for deployments that
    // share one. Same data, one hop shorter; the bridge is still the authority when both exist.
    let sources = [];
    try {
      const r = await db.query("SELECT config->'plannerAccounts' AS snapshot FROM sources WHERE id IN ('monarch', 'monarch_mcp_sync', 'monarch_api')");
      sources = r.rows;
    } catch (e) { if (e.code !== '42P01') throw e; } // Standalone planner DB.
    const snapshots = [local.snapshot, ...sources.map(s => s.snapshot)]
      .map(validSnapshot).filter(Boolean)
      .sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf));
    return {
      disabled: !!local.disabled,
      snapshot: snapshots[0] || null,
      url: env.NORMOS_URL || null,
      hasToken: !!env.PLANNER_BRIDGE_TOKEN,
      configured: !!(env.NORMOS_URL && env.PLANNER_BRIDGE_TOKEN),
    };
  }

  async function status() {
    const c = await context();
    return { connected: !c.disabled && !!(c.snapshot || c.configured), source: c.snapshot?.source || 'normos-bridge', asOf: c.snapshot?.asOf || null };
  }

  async function setEnabled(enabled) {
    await db.query(`INSERT INTO oauth_tokens (key,data) VALUES ('monarch_bridge',$1::jsonb)
      ON CONFLICT (key) DO UPDATE SET data = oauth_tokens.data || EXCLUDED.data`, [JSON.stringify({ disabled: !enabled })]);
  }

  // One request to the bridge. Every failure mode it defines is kept distinct, because they
  // have different cures and collapsing them into "unavailable" is what sent someone chasing
  // a credential for a week.
  async function askBridge(url, token) {
    const base = new URL(url);
    if (base.protocol !== 'https:' || base.username || base.password) throw new Error('NORMOS_URL must be a plain https origin, with no credentials in it.');
    let response;
    try {
      response = await fetchImpl(new URL(BRIDGE_PATH, base).href, {
        headers: { Authorization: `Bearer ${token}` },
        // The response is Cache-Control: no-store; never let an intermediary hold it either.
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw new Error(err && err.name === 'TimeoutError' ? 'NormOS timed out returning balances.' : 'NormOS is unreachable.');
    }
    const body = await response.json().catch(() => null);
    if (response.status === 401) throw new Error(UNAUTHORIZED);
    if (!response.ok) {
      // A 503 carries a human-readable message saying what NormOS is waiting on. It knows
      // things this process cannot, so it is passed through word for word rather than
      // translated into a guess.
      const said = body && typeof body.error === 'string' ? body.error.trim() : '';
      throw new Error(said || `NormOS returned HTTP ${response.status}.`);
    }
    if (!validSnapshot(body)) throw new Error('NormOS returned incomplete account data.');
    return body;
  }

  async function pull() {
    const c = await context();
    if (c.disabled) throw new Error('Planner sync is paused. Enable NormOS sync to resume.');
    let snapshot = c.snapshot;
    let warning = now() < retryAfter ? lastWarning : null;
    let partial = !!snapshot?.partial, missingAccounts = snapshot?.missingAccounts || [];
    let upstreamStale = null;

    if (c.configured && (!snapshot || now() - Date.parse(snapshot.asOf) >= TTL) && now() >= retryAfter) {
      try {
        const data = await askBridge(c.url, env.PLANNER_BRIDGE_TOKEN);
        // NormOS's warning means its own last refresh from Monarch failed and THESE are the
        // last known good balances. Data and warning together: it is not an error state, and
        // it must never blank the figures.
        warning = data.warning ? String(data.warning) : null;
        partial = !!data.partial;
        missingAccounts = Array.isArray(data.missingAccounts) ? data.missingAccounts : [];
        upstreamStale = typeof data.stale === 'boolean' ? data.stale : null;
        if (!snapshot || Date.parse(data.asOf) >= Date.parse(snapshot.asOf)) {
          snapshot = { ...data, source: data.source || 'normos-bridge' };
          await db.query(`INSERT INTO oauth_tokens (key,data) VALUES ('monarch_bridge',$1::jsonb)
            ON CONFLICT (key) DO UPDATE SET data = oauth_tokens.data || EXCLUDED.data`, [JSON.stringify({ snapshot })]);
        }
        lastWarning = warning;
        retryAfter = now() + TTL;
      } catch (err) {
        // Keep whatever we already had and say why it did not move. Balances already
        // observed are never discarded for a failed refresh.
        warning = err.message;
        lastWarning = warning;
        retryAfter = now() + TTL;
        if (!snapshot) throw new Error(warning);
      }
    }

    if (!snapshot && !c.configured) throw new Error(NOT_CONFIGURED);
    if (!snapshot) throw new Error(warning || NO_SNAPSHOT);
    // NormOS's own verdict wins when it gave one; otherwise fall back to the age of what we hold.
    const stale = upstreamStale != null ? upstreamStale : now() - Date.parse(snapshot.asOf) > DAY;
    return { ...snapshot, partial, missingAccounts, stale, warning, bankUpdatedAt: null };
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────
  // "It isn't populating" is unobservable from outside the server: an unset variable, a
  // paused sync, a rejected token and a NormOS that has nothing to publish yet all look
  // identical in the UI. Each precondition is probed in order and reported separately.
  //
  // It never returns the token, only whether one is set.
  async function diagnose() {
    const out = { checks: [], ok: false };
    const add = (name, ok, detail, kind, fix) => { out.checks.push({ name, ok, detail, kind: kind || 'check', fix: fix || null }); return ok; };
    let c;
    try { c = await context(); }
    catch (err) { add('read connection settings', false, err.message); return out; }

    const SET_ENV = 'Copy NORMOS_URL and PLANNER_BRIDGE_TOKEN from the NormOS service into this one. PLANNER_BRIDGE_TOKEN is scoped to the accounts endpoint — it is not a Monarch token and not the NormOS API token.';
    const configured = add('NormOS bridge configured', c.configured,
      c.configured ? `${c.url} · PLANNER_BRIDGE_TOKEN is set`
        : !c.url && !c.hasToken ? 'NORMOS_URL and PLANNER_BRIDGE_TOKEN are both unset'
          : !c.url ? 'NORMOS_URL is unset' : 'PLANNER_BRIDGE_TOKEN is unset',
      'check', c.configured ? null : SET_ENV);
    add('balance source', true, 'NormOS account bridge · the planner holds no Monarch credential', 'info');
    const enabled = add('planner sync enabled', !c.disabled, c.disabled ? 'sync is paused — enable it to resume' : 'enabled');
    if (!configured || !enabled) return out;

    let data = null;
    try {
      data = await askBridge(c.url, env.PLANNER_BRIDGE_TOKEN);
      add('NormOS accepts the bridge token', true, 'authenticated');
    } catch (err) {
      const is401 = err.message === UNAUTHORIZED;
      add(is401 ? 'NormOS accepts the bridge token' : 'NormOS returns balances', false, err.message,
        'check', is401 ? 'Re-copy PLANNER_BRIDGE_TOKEN from the NormOS service, taking care not to include a trailing newline.' : null);
      return out;
    }

    add('balances returned', data.accounts.length > 0, `${data.accounts.length} accounts · observed ${data.asOf}`);
    if (data.stale) add('freshness', true, 'NormOS reports this snapshot as more than 24h old; the balances below are still the last good ones', 'info');
    if (data.warning) add('NormOS refresh', true, `${data.warning} — these are the last known good balances`, 'info');
    if (data.partial) add('completeness', true, `${(data.missingAccounts || []).length} account(s) had no balance; the rest are valid`, 'info');
    out.ok = out.checks.every(x => x.kind === 'info' || x.ok);
    return out;
  }

  function getSnapshot() {
    if (!pending) pending = pull().finally(() => { pending = null; });
    return pending;
  }

  return { status, getSnapshot, setEnabled, diagnose };
}

module.exports = { createMonarchLive, validSnapshot, BRIDGE_PATH, TTL };
