'use strict';
// ═══ TRANSACTIONS, VIA NORMOS ═══
//
// The planner holds no Monarch credential. It reads transactions the same way it reads
// balances and holdings: from the NormOS bridge, under a token scoped to those endpoints.
//
//   GET <NORMOS_URL>/integrations/planner/transactions?start=&end=&offset=&limit=
//   GET <NORMOS_URL>/integrations/planner/categories
//
// What this satisfies is monarch-sync.js's `live` contract — `transactionsPage` and
// `categories`. That contract predates the bridge and is unchanged: the sync's paging,
// idempotency, pending-to-posted reconciliation and deletion guards all work exactly as they
// did against Monarch, because NormOS hands back the same shaped rows.
//
// Deliberately NOT cached here. A page is one step of a backfill walk, and serving a stale
// step would make the walk skip or repeat rows — the one thing the sync's own guards would
// then report as corruption. NormOS holds the cooldown that protects the upstream.

const PAGE_SIZE = 100;

function createTransactionsBridge({ env = process.env, fetchImpl = fetch } = {}) {
  function endpoint(path, params) {
    if (!env.NORMOS_URL || !env.PLANNER_BRIDGE_TOKEN) throw new Error('The NormOS connection is not configured.');
    const base = new URL(env.NORMOS_URL);
    if (base.protocol !== 'https:' || base.username || base.password) throw new Error('NormOS must use an HTTPS origin.');
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, String(v));
    return url.href;
  }

  async function ask(path, params, label) {
    let response;
    try {
      response = await fetchImpl(endpoint(path, params), {
        headers: { Authorization: `Bearer ${env.PLANNER_BRIDGE_TOKEN}` },
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(60000),
      });
    } catch (err) {
      if (err && /not configured|HTTPS origin/.test(err.message)) throw err;
      throw new Error(err && err.name === 'TimeoutError'
        ? `NormOS timed out returning ${label}.`
        : `NormOS could not be reached for ${label}. Try again shortly.`);
    }
    const body = await response.json().catch(() => null);
    if (response.status === 401) throw new Error('NormOS rejected the planner connection.');
    // A 400 is this side's bug — a window NormOS refused — and saying so plainly beats
    // "temporarily unavailable" on something that will never succeed on retry.
    if (response.status === 400) throw new Error(body?.error || `NormOS refused the ${label} request.`);
    if (!response.ok) throw new Error(body?.error || `NormOS ${label} are temporarily unavailable.`);
    return body;
  }

  // One page, in the exact shape monarch-sync.js validates: a total it can page against, and
  // rows carrying the ids its upsert is keyed on. Anything malformed is rejected HERE rather
  // than handed on, because the sync reads a broken page as evidence its own history is
  // corrupt and abandons the window.
  async function transactionsPage({ startDate, endDate, offset = 0, limit = PAGE_SIZE }) {
    const body = await ask('/integrations/planner/transactions',
      { start: startDate, end: endDate, offset, limit }, 'transactions');
    if (!body || !Number.isInteger(body.totalCount) || body.totalCount < 0 || !Array.isArray(body.results))
      throw new Error('NormOS returned an incomplete transaction page.');
    if (body.results.some(r => !r || r.id == null || !r.date))
      throw new Error('NormOS returned transactions without ids or dates.');
    return { totalCount: body.totalCount, results: body.results };
  }

  async function categories() {
    const body = await ask('/integrations/planner/categories', null, 'categories');
    const rows = Array.isArray(body) ? body : (body && body.categories);
    if (!Array.isArray(rows) || !rows.length) throw new Error('NormOS returned no categories.');
    return rows;
  }

  return { transactionsPage, categories, PAGE_SIZE };
}

module.exports = { createTransactionsBridge, PAGE_SIZE };
