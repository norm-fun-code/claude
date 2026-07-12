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
const { isFixedCategory, isInternalTransfer, reconcileWealthFlows } = require('./monarch');
const { registerSource } = require('../store/sources');

const SOURCE = 'monarch';
const DAY = 24 * 60 * 60 * 1000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const dayTs = (d) => new Date(`${d}T00:00:00Z`);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// --- pure helpers -------------------------------------------------------------

// Bug bash finding: `today` drives every "is this transaction pending/future-
// dated" decision in syncViaMcp (and matches Monarch's own Reports semantics,
// which reason in the user's local day) — but ymd(new Date()) slices
// toISOString(), which is always UTC. For ~4-5 hours every evening ET (after
// UTC has already rolled to the next calendar day but it's still "today"
// locally), a genuinely pending transaction dated exactly tomorrow would
// compare EQUAL to (not greater than) a UTC-based `today` and slip past the
// `day > today` filter instead of being excluded. `now` is an explicit param
// (defaulting to the real clock) so this is directly testable without mocking
// globals — same pattern as util/date.js's localMonthStartUtc.
function localToday(tz = process.env.TZ || 'America/New_York', now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: tz });
}

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

// The set of category names Monarch classifies as INCOME (Paychecks, Other
// Income, …) — the same basis as Monarch's Income report. We sum income ONLY from
// these categories so positive amounts that are really transfers / deposits /
// reimbursements (which inflated the figure to ~$33k vs Monarch's ~$22k) are
// excluded. Reads category_type from the category or its inherited group type.
async function incomeCategoryNames() {
  try {
    const cats = await rpc.callToolJson('GetCategories', {});
    const names = new Set();
    const isIncome = (t) => String(t || '').toLowerCase() === 'income';
    const collect = (arr, inheritedType) => {
      for (const x of arr || []) {
        if (!x) continue;
        const type = x.category_type || x.type || x.group_type || x.group?.type || inheritedType;
        if (typeof x.name === 'string' && isIncome(type)) names.add(x.name.toLowerCase());
        if (Array.isArray(x.categories)) collect(x.categories, type);
      }
    };
    if (Array.isArray(cats)) collect(cats);
    else { collect(cats?.categories); collect(cats?.groups); }
    return names;
  } catch {
    return new Set();
  }
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

  // ctx.now is a test-only override (defaults to the real clock in
  // production) — see localToday's comment for why "today" must be
  // explicitly parameterizable to test the UTC-vs-local boundary directly.
  const now = ctx.now ? new Date(ctx.now) : new Date();

  // Incremental window: 35-day lookback from last sync (45 on first run) so
  // late recategorizations in Monarch reach our stored docs/metrics.
  const lookbackDays = Number(process.env.MONARCH_LOOKBACK_DAYS) || 35;
  const since = ctx.lastSyncAt
    ? new Date(new Date(ctx.lastSyncAt).getTime() - lookbackDays * DAY)
    : new Date(now.getTime() - 45 * DAY);
  const startDate = ymd(since);
  const endDate = localToday(process.env.TZ || 'America/New_York', now);
  const today = endDate;

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

  // Monarch's income-typed category names — income is summed ONLY from these, so
  // it matches Monarch's Income report instead of catching every positive inflow.
  const incomeCats = await incomeCategoryNames();

  // Total-outage guard: GetCategories (static reference data — should basically
  // NEVER be empty for a working, configured connection) AND GetTransactions
  // (zero transactions across a 35-45 DAY window) both coming back empty at once
  // is not "a quiet month" — it's Monarch's API rejecting/rate-limiting every
  // call this run (expired MCP token, IP block, outage). Previously this
  // silently wrote hollow zero-valued metrics and reported success, so the
  // sources-staleness alert (which only fires on a thrown error or a stale
  // last_sync_at) never caught it — `markSync` recorded a fresh "successful"
  // sync every single run even though the data was empty, permanently masking
  // the failure. Throwing here routes through runConnector's catch, which marks
  // the source status='error' and lets the existing "Monarch hasn't synced —
  // reconnect" alert actually fire.
  if (incomeCats.size === 0 && txns.length === 0) {
    throw new Error(
      'Monarch MCP returned nothing (0 categories, 0 transactions in a ' +
      `${lookbackDays}-day window) — treating as a total sync failure, not a genuinely empty month.`
    );
  }

  // ── THE ONE authoritative flow calculation ─────────────────────────────
  // Every writing path (this MCP sync, the GraphQL/CSV importer, the document
  // recompute) funnels through reconcileWealthFlows so spending, discretionary,
  // fixed housing, income, and net cashflow all come from ONE transaction
  // universe with ONE refund-netting / transfer / income / fixed-housing rule
  // set. Total expense and fixed housing are the SAME netted universe, so
  // spending === fixed + discretionary to the cent — the previous path mixed a
  // refund-netted GetCashFlow *total* with a raw-negative fixed-housing *subset*,
  // which diverged on any fixed-category refund/credit. incomeCats (Monarch's
  // own income category names) is the authoritative income signal; category_type
  // and the name heuristic are the documented fallbacks (see monarch.js).
  const normTxns = txns.map((t) => ({
    date: t && t.date ? String(t.date).slice(0, 10) : null,
    amount: Number(t?.amount),
    category: t?.category,
    categoryType: t?.category_type || t?.categoryType,
  }));
  const { byDay: flowsByDay, expenseTxns, incomeTxns } = reconcileWealthFlows(normTxns, {
    incomeCategoryNames: incomeCats, today, tz: process.env.TZ || 'America/New_York',
  });
  const expSrc = new Map([...flowsByDay].map(([d, b]) => [d, b.spending]));
  const discretionaryByDay = new Map([...flowsByDay].map(([d, b]) => [d, b.discretionary]));
  const incSrc = new Map([...flowsByDay].map(([d, b]) => [d, b.income]));

  // GetCashFlow cross-check — DIAGNOSTIC ONLY, never mixed into the written
  // metrics. Monarch's Reports aggregation is the external reference; if the
  // reconciler's window total drifts from it by more than a rounding cent, log
  // it so a real data/rule mismatch is visible instead of silently blended in
  // (the exact anti-pattern this rework removes). Best-effort, never blocks.
  try {
    const transferCats = await transferCategoryNames();
    const [ci, ce] = await Promise.allSettled([
      dailyCashflow(startDate, endDate, 'income', transferCats),
      dailyCashflow(startDate, endDate, 'expense', transferCats),
    ]);
    const sumCash = (r) => {
      if (r.status !== 'fulfilled') return null;
      let s = 0;
      for (const [k, v] of r.value) { if (String(k).slice(0, 10) > today) continue; s += Math.abs(v); }
      return round2(s);
    };
    const reconSpend = round2([...flowsByDay.values()].reduce((a, b) => a + b.spending, 0));
    const reconIncome = round2([...flowsByDay.values()].reduce((a, b) => a + b.income, 0));
    const cashSpend = sumCash(ce);
    const cashInc = sumCash(ci);
    const drift = (recon, cash) => cash == null ? 'unavailable' : `$${cash}` + (Math.abs(round2(recon - cash)) > 0.01 ? ` DRIFT=$${round2(recon - cash)}` : ' (match)');
    console.log(`[monarch_mcp_sync] flows source=transaction-reconciler days=${flowsByDay.size} ` +
      `reconSpend=$${reconSpend} getCashFlowSpend=${drift(reconSpend, cashSpend)} ` +
      `reconIncome=$${reconIncome} getCashFlowIncome=${drift(reconIncome, cashInc)} ` +
      `(expenseTxns=${expenseTxns} incomeTxns=${incomeTxns} incomeCats=${incomeCats.size})`);
  } catch (err) {
    console.error('[monarch_mcp_sync] GetCashFlow cross-check failed (non-fatal):', err.message);
  }

  // Bug bash root cause: this used to emit spending/spending_discretionary
  // ONLY on days present in expSrc/discSrc — a day whose spend dropped to
  // ZERO (every transaction that day deleted, refunded, or recategorized
  // into a fixed category) was simply ABSENT from this run's maps, so its
  // stale, previously-stored (higher) value was never overwritten and kept
  // inflating every MTD sum indefinitely. Spending/discretionary now emit for
  // EVERY day in the window (0 when none), exactly like income/net_cashflow
  // already do below — a day that goes quiet gets an explicit 0 row that
  // correctly replaces (not sums with, per insertMetrics' upsert semantics)
  // whatever was stored before.
  //
  // Guard mirrors income's: expSrc.size === 0 while real transactions exist
  // this window is an expense-DETECTION failure (GetCashFlow down and the
  // transaction fallback also came up empty), not a genuinely expense-free
  // month — skip the write rather than zeroing out real history.
  const expenseDetectionFailed = expenseTxns === 0 && txns.length > 0;
  if (expenseDetectionFailed) {
    console.error(`[monarch_mcp_sync] no expenses detected across ${txns.length} transactions in ${startDate}..${endDate} — treating as a detection failure and skipping the spending/spending_discretionary write rather than zeroing real history`);
  } else {
    for (let day = startDate; day <= endDate; day = nextDay(day)) {
      metrics.push(m('spending', expSrc.get(day) || 0, day));
      metrics.push(m('spending_discretionary', discretionaryByDay.get(day) || 0, day));
    }
  }

  // Income / net_cashflow: emit for EVERY day in the window (0 when none). Income
  // lands on only ~10 paycheck days, but the OLD transaction-level sync counted
  // deposits/transfers as income across many more days. Emitting only on new-income
  // days left that stale per-day income in place, inflating the 30-day total
  // (~$30k vs Monarch's ~$19.5k). Writing 0 on the non-income days overwrites it.
  //
  // Guard: incSrc.size === 0 across a 35-45 day window with real transactions
  // present is a signal that income detection FAILED this run (GetCashFlow down
  // AND the category-type/name classification missed every paycheck), not that
  // income was genuinely zero for over a month straight. Writing 0 for every day
  // in that case would overwrite real stored income with a fabricated absence —
  // skip the write instead and leave whatever's already stored alone.
  const incomeDetectionFailed = incomeTxns === 0 && txns.length > 0;
  if (incomeDetectionFailed) {
    console.error(`[monarch_mcp_sync] no income detected across ${txns.length} transactions in ${startDate}..${endDate} — treating as a detection failure and skipping the income/net_cashflow write rather than zeroing real history`);
  } else {
    for (let day = startDate; day <= endDate; day = nextDay(day)) {
      const income = incSrc.get(day) || 0;
      const spend = expSrc.get(day) || 0;
      metrics.push(m('income', income, day));
      metrics.push(m('net_cashflow', income - spend, day));
    }
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

  // exported for testing / diagnostics
  fetchTxnsInRange,
  dailyCashflow,
  txnToDocument,
  syncViaMcp,
  incomeCategoryNames,
  transferCategoryNames,
  fixedCategoryNames,
  localToday,
};
