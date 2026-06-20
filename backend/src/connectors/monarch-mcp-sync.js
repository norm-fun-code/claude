// Monarch MCP sync connector (Wealth domain) — PRIMARY Monarch source.
//
// Pulls authoritative numbers straight from Monarch's official MCP server via
// direct JSON-RPC (no LLM), so the daily metrics match Monarch's own UI exactly
// (e.g. cash-flow that already excludes transfers + credit-card payments — the
// double-counting we kept fighting with the GraphQL scrape). Writes under source
// 'monarch', shared with the CSV importer and the GraphQL connector, so it
// upserts idempotently and never double-counts.
//
// Fallback: if Monarch MCP isn't configured, or any pull fails, this delegates to
// the existing GraphQL connector (./monarch-api) so finances keep flowing.
const rpc = require('../services/monarch-mcp-rpc');
const monarchMcp = require('../services/monarch-mcp');
const monarchApi = require('./monarch-api');
const { isFixedCategory, isInternalTransfer, isExcludedIncome } = require('./monarch');
const { registerSource } = require('../store/sources');

const SOURCE = 'monarch';
const DAY = 24 * 60 * 60 * 1000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const dayTs = (d) => new Date(`${d}T00:00:00Z`);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// --- pure helpers -------------------------------------------------------------

// Midpoint day (YYYY-MM-DD) between two inclusive dates, for adaptive chunking.
function midDate(start, end) {
  const s = dayTs(start).getTime();
  const e = dayTs(end).getTime();
  return ymd(new Date(s + Math.floor((e - s) / 2)));
}
function nextDay(d) {
  return ymd(new Date(dayTs(d).getTime() + DAY));
}

// GetTransactions has no offset/cursor, so page by recursively splitting the
// date range whenever a window comes back `truncated` (>limit transactions).
async function fetchTxnsInRange(start, end) {
  const res = await rpc.callToolJson('GetTransactions', { start_date: start, end_date: end, limit: 100 });
  const txns = Array.isArray(res?.transactions) ? res.transactions : [];
  if (res?.truncated && start !== end) {
    const mid = midDate(start, end);
    if (mid === end) return txns; // can't split further — accept what we got
    const [left, right] = await Promise.all([
      fetchTxnsInRange(start, mid),
      fetchTxnsInRange(nextDay(mid), end),
    ]);
    const byId = new Map();
    for (const t of [...txns, ...left, ...right]) if (t?.id != null) byId.set(t.id, t);
    return [...byId.values()];
  }
  return txns;
}

// Daily cash-flow buckets for a category_type, optionally excluding categories.
// Returns Map<day, amount> where amount is Monarch-signed (expense negative).
async function dailyCashflow(start, end, categoryType, excludeCategories) {
  const filters = { category_type: categoryType };
  if (excludeCategories && excludeCategories.length) filters.exclude_categories = excludeCategories;
  const res = await rpc.callToolJson('GetCashFlow', {
    start_date: start,
    end_date: end,
    base_query: JSON.stringify({ group_by_time: 'day' }),
    filters: JSON.stringify(filters),
  });
  const map = new Map();
  for (const row of res?.data || []) {
    if (row && row.month != null && Number.isFinite(row.amount)) map.set(row.month, row.amount);
  }
  return map;
}

// Collect all category names from GetCategories, then filter with the predicate.
// Defensive about the various shapes Monarch's MCP may return.
async function collectCategoryNames(predicate) {
  try {
    const cats = await rpc.callToolJson('GetCategories', {});
    const names = [];
    const collect = (arr) => {
      for (const x of arr || []) {
        if (x && typeof x.name === 'string') names.push(x.name);
        if (Array.isArray(x?.categories)) collect(x.categories);
      }
    };
    if (Array.isArray(cats)) collect(cats);
    else {
      collect(cats?.categories);
      collect(cats?.groups);
    }
    return names.filter(predicate);
  } catch {
    return [];
  }
}

// Fixed-housing categories to exclude from discretionary spend.
function fixedCategoryNames() {
  return collectCategoryNames(isFixedCategory);
}

// Transfer / CC-payment categories to exclude from all spending totals.
// GetCashFlow(category_type:'expense') sometimes includes credit-card payments
// when they're categorized under an expense-type category in Monarch (the classic
// Monarch double-count). Mirror the same guard the CSV connector uses.
function transferCategoryNames() {
  return collectCategoryNames(isInternalTransfer);
}

function txnToDocument(t) {
  return {
    source: SOURCE,
    domain: 'wealth',
    externalId: `monarch:${t.id}`,
    title: t.merchant || 'Transaction',
    url: null,
    content: [t.merchant, t.category, `$${t.amount}`, t.account].filter(Boolean).join(' — '),
    occurredAt: t.date,
    metadata: {
      amount: t.amount,
      category: t.category,
      account: t.account,
      merchant: t.merchant,
      original: t.original_statement,
    },
  };
}

// --- the actual MCP pull ------------------------------------------------------

async function syncViaMcp(ctx) {
  // Make sure the shared 'monarch' source row exists (FK for metrics/docs).
  await registerSource({ id: SOURCE, domain: 'wealth', displayName: 'Monarch (CSV import)' });

  // Incremental window: 35-day lookback from last sync (45 on first run) so
  // late recategorizations in Monarch reach our stored docs/metrics.
  const lookbackDays = Number(process.env.MONARCH_LOOKBACK_DAYS) || 35;
  const since = ctx.lastSyncAt
    ? new Date(new Date(ctx.lastSyncAt).getTime() - lookbackDays * DAY)
    : new Date(Date.now() - 45 * DAY);
  const startDate = ymd(since);
  const endDate = ymd(new Date());
  const today = ymd(new Date());

  const metrics = [];
  const m = (metric, value, day) => ({
    ts: dayTs(day), domain: 'wealth', metric, value: round2(value), unit: 'usd', source: SOURCE,
  });

  // 1) Net worth snapshot (today) from GetAccounts — Monarch's own totals.
  const acc = await rpc.callToolJson('GetAccounts', {});
  if (acc) {
    const networth = Number(acc.total_balance);
    const assets = Number(acc.total_asset_balance);
    const liabilities = Math.abs(Number(acc.total_liabilities_balance));
    if (Number.isFinite(networth)) metrics.push(m('net_worth', networth, today));
    if (Number.isFinite(assets)) metrics.push(m('assets', assets, today));
    if (Number.isFinite(liabilities)) metrics.push(m('liabilities', liabilities, today));
  }

  // 2+3) Derive both income and spending from individual transactions — the only
  //      reliable way to apply consistent filtering. Previously income came from
  //      GetCashFlow(category_type:'income') which includes dividends, capital
  //      gains, tax refunds, and interest — inflating savings rate vs Monarch's
  //      Reports view. Transaction-level lets us exclude those the same way the
  //      CSV connector's mapTransactions does, and use Monarch's category_type
  //      field when present as an authoritative transfer signal.
  const txns = await fetchTxnsInRange(startDate, endDate);
  const documents = txns.filter((t) => t && t.id != null).map(txnToDocument);

  const expByDay = new Map();
  const discByDay = new Map();
  const incByDay = new Map();
  for (const t of txns) {
    if (!t || !t.date) continue;
    const amount = Number(t.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const category = String(t.category || '');
    const categoryType = String(t.category_type || t.categoryType || '').toLowerCase();
    // Use Monarch's own category_type first (authoritative), then fall back to
    // name-matching. Catches CC payments/transfers regardless of custom names.
    if (categoryType === 'transfer' || isInternalTransfer(category)) continue;
    const day = String(t.date).slice(0, 10);
    if (day > today) continue; // skip pending/future-dated transactions
    if (amount < 0) {
      const spend = Math.abs(amount);
      expByDay.set(day, (expByDay.get(day) || 0) + spend);
      if (!isFixedCategory(category)) {
        discByDay.set(day, (discByDay.get(day) || 0) + spend);
      }
    } else if (!isExcludedIncome(category)) {
      // Earned income only: paychecks, freelance, other income.
      // Excludes dividends, capital gains, tax refunds, interest income.
      incByDay.set(day, (incByDay.get(day) || 0) + amount);
    }
  }

  const days = new Set([...expByDay.keys(), ...incByDay.keys()]);
  for (const day of days) {
    const spend = expByDay.get(day) || 0;
    const income = incByDay.get(day) || 0;
    if (expByDay.has(day)) metrics.push(m('spending', spend, day));
    if (discByDay.has(day)) metrics.push(m('spending_discretionary', discByDay.get(day) || 0, day));
    if (incByDay.has(day)) metrics.push(m('income', income, day));
    if (expByDay.has(day) || incByDay.has(day)) metrics.push(m('net_cashflow', income - spend, day));
  }

  // Reconcile the window against Monarch's current truth: prune stored docs it no
  // longer reports there (deleted, or moved to another month).
  const keepExternalIds = documents.map((d) => d.externalId);
  const reconcile = { source: SOURCE, domain: 'wealth', from: startDate, to: endDate, keepExternalIds };

  return { metrics, documents, reconcile };
}

module.exports = {
  id: 'monarch_mcp_sync',
  domain: 'wealth',
  displayName: 'Monarch (MCP auto-sync)',

  async sync(ctx = {}) {
    // Not configured → preserve existing behavior via the GraphQL connector.
    if (!monarchMcp.isConfigured()) {
      return monarchApi.sync(ctx);
    }

    // Once-per-day guard: runIngest() fires on every briefing rebuild; don't
    // re-pull Monarch all day. A `full` run (ctx.lastSyncAt === null) proceeds.
    if (ctx.lastSyncAt) {
      const tz = process.env.TZ || 'America/New_York';
      const localDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
      if (localDay(ctx.lastSyncAt) === localDay(new Date())) {
        return { metrics: [], documents: [] };
      }
    }

    try {
      return await syncViaMcp(ctx);
    } catch (err) {
      console.error('[monarch_mcp_sync] MCP pull failed, falling back to GraphQL:', err.message);
      return monarchApi.sync(ctx);
    }
  },

  // exported for testing
  fetchTxnsInRange,
  dailyCashflow,
  txnToDocument,
  syncViaMcp,
};
