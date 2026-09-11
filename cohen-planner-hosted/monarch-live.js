'use strict';
const crypto = require('crypto');
const { extractAccounts } = require('./monarch-accounts');
const TTL = 5 * 60 * 1000;
// Reuse the exact account query already used by NormOS. Credentials never leave the server.
const QUERY = 'query NormOS_Accounts { accounts { id displayName currentBalance } }';
// Individual holdings. Monarch's own Investments page reads them through `portfolio`, and
// aggregateHoldings rolls the same security held across several accounts into one position,
// which is what the portfolio view wants. `basis` is what makes an all-time return possible.
//
// The selection set is deliberately a subset of Monarch's own Web_GetHoldings operation —
// every field here is one that query is known to request. Notably `value` is NOT selected on
// the holdings sub-object: it isn't a field on that type, and asking for it fails the whole
// query. Position value comes from the aggregate's totalValue instead.
const HOLDINGS_QUERY = `query NormOS_Holdings($input: PortfolioInput) {
  portfolio(input: $input) {
    performance {
      totalValue totalBasis totalChangePercent totalChangeDollars oneDayChangePercent
      historicalChart { date returnPercent }
    }
    aggregateHoldings { edges { node {
      id quantity basis totalValue
      securityPriceChangeDollars securityPriceChangePercent
      security { id name ticker type typeDisplay }
      holdings { id name ticker type typeDisplay }
    } } }
  }
}`;
const ACCOUNT_IDS_QUERY = 'query NormOS_AccountIds { accounts { id } }';

// Transactions. Every field below appears in Monarch's own TransactionOverviewFields
// fragment — nothing invented. `updatedAt` is the one that matters most: it is what makes
// incremental sync possible at all, and `id` is what makes it idempotent.
const TRANSACTIONS_QUERY = `query NormOS_Transactions($offset: Int, $limit: Int, $filters: TransactionFilterInput, $orderBy: TransactionOrdering) {
  allTransactions(filters: $filters) {
    totalCount
    results(offset: $offset, limit: $limit, orderBy: $orderBy) {
      id amount pending date hideFromReports plaidName notes
      isRecurring isSplitTransaction createdAt updatedAt
      category { id name }
      merchant { id name }
      account { id displayName }
      tags { id name }
    }
  }
}`;
// Categories carry the group `type` (income / expense / transfer) the whole accounting
// model hangs off, plus systemCategory for Monarch's built-ins like credit-card payment.
const CATEGORIES_QUERY = `query NormOS_Categories {
  categories { id order name systemCategory isSystemCategory isDisabled updatedAt group { id name type } }
}`;
const BUDGETS_QUERY = `query NormOS_Budgets($startDate: Date!, $endDate: Date!) {
  budgetData(startMonth: $startDate, endMonth: $endDate) {
    monthlyAmountsByCategory {
      category { id }
      monthlyAmounts { month plannedCashFlowAmount actualAmount remainingAmount cumulativeActualAmount }
    }
  }
  categoryGroups { id name type }
}`;
const RECURRING_QUERY = `query NormOS_Recurring($startDate: Date!, $endDate: Date!) {
  recurringTransactionItems(startDate: $startDate, endDate: $endDate) {
    stream { id frequency amount isApproximate merchant { id name } }
    date isPast transactionId amount amountDiff
    category { id name }
    account { id displayName }
  }
}`;
const PAGE_SIZE = 100;
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
const numOrNull = v => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { const n = parseFloat(v.replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; }
  return null;
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
// Flatten Monarch's nested transaction into the flat row the accounting model and the
// database both use. Ids are stringified because they arrive as numbers or strings
// depending on the field, and a mixed-type primary key breaks idempotent upserts.
function mapTransaction(t) {
  const id = t && t.id != null ? String(t.id) : null;
  if (!id) return null;
  return {
    id,
    date: String(t.date || '').slice(0, 10),
    amount: numOr0(t.amount),
    merchant: (t.merchant && t.merchant.name) || '',
    plaidName: t.plaidName || '',
    notes: t.notes || '',
    categoryId: t.category && t.category.id != null ? String(t.category.id) : null,
    categoryName: (t.category && t.category.name) || '',
    accountId: t.account && t.account.id != null ? String(t.account.id) : null,
    accountName: (t.account && t.account.displayName) || '',
    pending: !!t.pending,
    hideFromReports: !!t.hideFromReports,
    isRecurring: !!t.isRecurring,
    isSplitTransaction: !!t.isSplitTransaction,
    tags: (t.tags || []).map(x => (x && x.name) || '').filter(Boolean),
    updatedAt: t.updatedAt || null,
    createdAt: t.createdAt || null,
  };
}

// Budgets arrive as a per-category array of monthly amounts; the cockpit wants one row per
// (month, category).
function mapBudgets(d) {
  const byCat = (d && d.budgetData && d.budgetData.monthlyAmountsByCategory) || [];
  const rows = [];
  for (const entry of byCat) {
    const categoryId = entry && entry.category && entry.category.id != null ? String(entry.category.id) : null;
    if (!categoryId) continue;
    for (const m of entry.monthlyAmounts || []) {
      rows.push({
        month: String(m.month || '').slice(0, 7),
        categoryId,
        planned: numOr0(m.plannedCashFlowAmount),
        actual: numOr0(m.actualAmount),
        remaining: numOr0(m.remainingAmount),
      });
    }
  }
  return { rows, groups: (d && d.categoryGroups) || [] };
}

function mapHoldings(payload) {
  const rows = extractHoldingEdges(payload).map(e => {
    const n = e?.node ?? e ?? {};
    const sec = n.security || (Array.isArray(n.holdings) ? n.holdings[0] : null) || {};
    const value = numOr0(n.totalValue ?? n.value);
    const basis = numOr0(n.basis);
    const allTimeChange = basis > 0 ? value - basis : 0;
    const priceChangePct = numOrNull(n.securityPriceChangePercent);
    const priceChangePerShare = numOrNull(n.securityPriceChangeDollars);
    const quantity = numOrNull(n.quantity);
    // securityPriceChangeDollars is the change in one security's price, not this
    // position's dollar change. Prefer the percentage applied to the current position;
    // fall back to price change × quantity when Monarch omits the percentage.
    const positionPriceChange = priceChangePct != null && priceChangePct > -100
      ? value - value / (1 + priceChangePct / 100)
      : (priceChangePerShare != null && quantity != null ? priceChangePerShare * quantity : null);
    return {
      ticker: sec.ticker || sec.name || '\u2014',
      name: sec.name || sec.ticker || '',
      value: Math.round(value),
      securityType: normaliseType(sec.type ?? sec.typeDisplay),
      periodChange: positionPriceChange == null ? null : Math.round(positionPriceChange * 100) / 100,
      periodChangePct: priceChangePct == null ? null : Math.round(priceChangePct * 100) / 100,
      allTimeChange: Math.round(allTimeChange * 100) / 100,
      allTimePct: basis > 0 ? Math.round(allTimeChange / basis * 10000) / 100 : 0,
    };
  }).filter(h => h.value !== 0);
  if (!rows.length) throw new Error('Monarch returned no holdings.');
  return rows.sort((a, b) => b.value - a.value);
}
function mapPerformance(payload) {
  const p = payload?.performance ?? payload?.portfolio?.performance ?? payload?.data?.portfolio?.performance;
  if (!p) return null;
  const dollars = numOrNull(p.totalChangeDollars);
  const percent = numOrNull(p.totalChangePercent);
  if (dollars == null || percent == null) return null;
  return {
    totalValue: numOrNull(p.totalValue),
    totalBasis: numOrNull(p.totalBasis ?? p.totalCostBasis),
    totalChangeDollars: Math.round(dollars * 100) / 100,
    totalChangePercent: Math.round(percent * 100) / 100,
    oneDayChangePercent: numOrNull(p.oneDayChangePercent),
    historicalChart: Array.isArray(p.historicalChart) ? p.historicalChart : [],
  };
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
  // A GraphQL 200 can still carry errors, and this schema is undocumented, so log the
  // upstream detail. "Cannot query field X on type Y" is the difference between a fix and
  // a guess, and it never reaches the user.
  function logGraphqlErrors(label, errors) {
    try { console.warn(`Monarch ${label} query rejected:`, errors.map(e => e && e.message).filter(Boolean).join(' | ')); } catch {}
  }

  async function accountIds(token) {
    try {
      const r = await graphql(token, ACCOUNT_IDS_QUERY, {});
      if (!r.ok) return [];
      const b = await r.json();
      return (b.data?.accounts || []).map(a => String(a.id)).filter(Boolean);
    } catch { return []; }
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
    return (await investmentPortfolio({ startDate, endDate })).holdings;
  }

  async function investmentPortfolio({ startDate, endDate }) {
    const c = await context();
    if (c.disabled) throw new Error('Planner sync is paused. Enable NormOS sync to resume.');
    if (!c.token) throw new Error('Individual holdings need a direct Monarch connection. Reconnect Monarch in NormOS.');
    const ask = async (input) => {
      let response;
      try {
        response = await graphql(c.token, HOLDINGS_QUERY, { input });
      } catch (err) {
        throw new Error(err.name === 'TimeoutError' ? 'Monarch timed out returning holdings.' : 'Monarch is unreachable for holdings.');
      }
      if (!response.ok) {
        throw new Error(response.status === 401 ? 'Monarch session expired. Reconnect Monarch in NormOS.'
          : response.status === 429 ? 'Monarch is rate limiting. Try again shortly.'
          : 'Monarch could not return holdings.');
      }
      return response.json();
    };

    // Monarch only calculates securityPriceChange* for the number of positions named by
    // topMoversLimit. When it is omitted those fields come back null, which made every
    // period return look like $0 even though the date window was sent correctly. Ask for
    // enough movers to cover the whole household portfolio so every displayed holding can
    // participate in the period total and gainers/losers lists.
    const window = { startDate, endDate, includeHiddenHoldings: false, topMoversLimit: 100 };
    // Monarch's own call always scopes to explicit accountIds. Omitting it *should* return
    // the whole portfolio, which is what we want and one fewer round trip — but that is an
    // assumption about an undocumented schema, so if it is rejected, fetch the ids and ask
    // again the way Monarch itself does rather than reporting the portfolio unavailable.
    let body = await ask(window);
    if (body.errors) {
      logGraphqlErrors('holdings (unscoped)', body.errors);
      const ids = await accountIds(c.token);
      if (!ids.length) throw new Error('Monarch could not return holdings for this account.');
      body = await ask({ ...window, accountIds: ids });
    }
    if (body.errors) {
      logGraphqlErrors('holdings (scoped)', body.errors);
      throw new Error('Monarch could not return holdings for this account.');
    }
    const portfolio = body.data?.portfolio ?? body.data ?? body;
    return { holdings: mapHoldings(portfolio), performance: mapPerformance(portfolio) };
  }

  // ── Transactions, categories, budgets, recurring ────────────────────────
  // All four ride the same authenticated GraphQL path the balances use. None of them are
  // reachable through the NormOS bridge, which only publishes /integrations/planner/accounts.
  async function ask(label, query, variables) {
    const c = await context();
    if (c.disabled) throw new Error('Planner sync is paused. Enable NormOS sync to resume.');
    if (!c.token) throw new Error(`${label} needs a direct Monarch connection. Reconnect Monarch in NormOS.`);
    let response;
    try {
      response = await graphql(c.token, query, variables);
    } catch (err) {
      throw new Error(err.name === 'TimeoutError' ? `Monarch timed out returning ${label}.` : `Monarch is unreachable for ${label}.`);
    }
    if (!response.ok) {
      throw new Error(response.status === 401 ? 'Monarch session expired. Reconnect Monarch in NormOS.'
        : response.status === 429 ? 'Monarch is rate limiting. Try again shortly.'
        : `Monarch could not return ${label}.`);
    }
    const body = await response.json();
    if (body.errors) { logGraphqlErrors(label, body.errors); throw new Error(`Monarch could not return ${label}.`); }
    return body.data || {};
  }

  // One page of transactions. Paging is by offset against a stable date-descending order so
  // a backfill walks the history deterministically instead of re-reading the same window.
  async function transactionsPage({ startDate, endDate, offset = 0, limit = PAGE_SIZE }) {
    const d = await ask('transactions', TRANSACTIONS_QUERY, {
      offset, limit,
      filters: { startDate, endDate },
      orderBy: 'date',
    });
    const all = d.allTransactions;
    if (!all || !Number.isInteger(all.totalCount) || all.totalCount < 0 || !Array.isArray(all.results))
      throw new Error('Monarch returned an incomplete transaction response. Saved history was retained.');
    return { totalCount: all.totalCount, results: all.results.map(mapTransaction) };
  }

  async function categories() {
    const d = await ask('categories', CATEGORIES_QUERY, {});
    if (!Array.isArray(d.categories) || !d.categories.length) throw new Error('Monarch returned no categories.');
    return d.categories;
  }

  async function budgets({ startDate, endDate }) {
    const d = await ask('budgets', BUDGETS_QUERY, { startDate, endDate });
    return mapBudgets(d);
  }

  async function recurring({ startDate, endDate }) {
    const d = await ask('recurring', RECURRING_QUERY, { startDate, endDate });
    return (d.recurringTransactionItems || []).map(r => ({
      streamId: r.stream && r.stream.id != null ? String(r.stream.id) : null,
      merchant: (r.stream && r.stream.merchant && r.stream.merchant.name) || '',
      frequency: (r.stream && r.stream.frequency) || null,
      isApproximate: !!(r.stream && r.stream.isApproximate),
      date: r.date || null,
      isPast: !!r.isPast,
      transactionId: r.transactionId != null ? String(r.transactionId) : null,
      amount: numOr0(r.amount),
      // How far this occurrence drifted from the stream's usual amount — the signal for
      // "a recurring charge changed" without having to diff history ourselves.
      amountDiff: numOr0(r.amountDiff),
      categoryId: r.category && r.category.id != null ? String(r.category.id) : null,
      categoryName: (r.category && r.category.name) || '',
      accountId: r.account && r.account.id != null ? String(r.account.id) : null,
    }));
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────
  // "It isn't populating" is unobservable from outside the server: the failure could be a
  // missing token, a paused sync, an expired session or a rejected query, and they all look
  // identical in the UI. This probes each precondition in order and reports which one
  // actually failed, including the upstream GraphQL message.
  //
  // It never returns the token, only whether one is present.
  async function diagnose() {
    const out = { checks: [], ok: false };
    // `info` rows describe the setup without passing judgement on it — having no NormOS
    // bridge is perfectly fine when a direct token exists, and flagging it red would send
    // someone chasing a non-problem.
    const add = (name, ok, detail, kind) => { out.checks.push({ name, ok, detail, kind: kind || 'check' }); return ok; };
    let c;
    try {
      c = await context();
    } catch (err) {
      add('read connection settings', false, err.message);
      return out;
    }
    add('MONARCH_TOKEN present', !!c.token, c.token ? 'a direct token is configured' : 'no token — holdings and transactions need one; balances can still come from the NormOS bridge');
    add('balance source', true, c.remote ? 'NormOS bridge' : 'direct Monarch token', 'info');
    add('planner sync enabled', !c.disabled, c.disabled ? 'sync is paused — enable it to resume' : 'enabled');
    if (!c.token || c.disabled) return out;

    // Cheapest possible authenticated call: proves the token and headers, nothing else.
    let reachable = false;
    try {
      const r = await graphql(c.token, ACCOUNT_IDS_QUERY, {});
      reachable = add('Monarch accepts the token', r.ok,
        r.ok ? 'authenticated' : `HTTP ${r.status}` + (r.status === 401 ? ' — the token is rejected or expired' : ''));
      if (r.ok) {
        const b = await r.json();
        if (b.errors) reachable = add('accounts query', false, b.errors.map(e => e && e.message).filter(Boolean).join(' | '));
        else add('accounts query', true, `${(b.data?.accounts || []).length} accounts visible`);
      }
    } catch (err) {
      add('Monarch reachable', false, err.name === 'TimeoutError' ? 'timed out' : err.message);
      return out;
    }
    if (!reachable) return out;

    // Now the queries that actually back the views, each reported separately so a schema
    // change in one does not read as everything being broken.
    const today = new Date().toISOString().slice(0, 10);
    const probe = async (name, fn) => {
      try { const n = await fn(); add(name, true, n); }
      catch (err) { add(name, false, err.message); }
    };
    await probe('holdings query', async () => `${(await holdings({ startDate: today, endDate: today })).length} positions`);
    await probe('categories query', async () => `${(await categories()).length} categories`);
    await probe('transactions query', async () => {
      const p = await transactionsPage({ startDate: today.slice(0, 8) + '01', endDate: today, limit: 1 });
      return `${p.totalCount} transactions this month`;
    });
    out.ok = out.checks.every(c => c.kind === 'info' || c.ok);
    return out;
  }

  function getSnapshot() {
    if (!pending) pending = pull().finally(() => { pending = null; });
    return pending;
  }
  return { status, getSnapshot, setEnabled, holdings, investmentPortfolio, transactionsPage, categories, budgets, recurring, diagnose };
}
module.exports = { createMonarchLive, validSnapshot, mapHoldings, mapPerformance, normaliseType, extractHoldingEdges, mapTransaction, mapBudgets, PAGE_SIZE };
