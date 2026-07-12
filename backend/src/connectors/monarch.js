// Monarch connector (Wealth domain) — monthly CSV "file drop" import.
//
// Unlike the API connectors, this one reads files you export from Monarch Money
// (Settings → Data → Download) and drop into an import folder
// (MONARCH_IMPORT_DIR, default backend/imports/monarch/). On each ingest run it
// imports any new/changed CSVs, remembering processed files by content hash so
// re-runs never double-count.
//
// Monarch is the *authoritative* wealth source: it already aggregates every
// institution plus manual accounts (real estate, vehicles, crypto) that Plaid
// can't see, and it's pre-categorized. Monthly resolution is the right cadence
// for wealth — the life-pattern questions NormOS answers don't need real-time.
//
// Auto-detects two export shapes:
//   • transactions — Date, Merchant, Category, Account, Amount, Tags, ...
//       → daily wealth:spending / wealth:income / wealth:net_cashflow metrics
//         + one knowledge document per transaction (for life chat).
//   • balances/net worth — Date + Net Worth (or per-account Balance [+ Type])
//       → wealth:net_worth (and assets/liabilities when classifiable) snapshots.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseCsvObjects } = require('../util/csv');

const SOURCE = 'monarch';
const DEFAULT_DIR = path.join(__dirname, '..', '..', 'imports', 'monarch');

function importDir() {
  return process.env.MONARCH_IMPORT_DIR || DEFAULT_DIR;
}

// --- small pure helpers -------------------------------------------------------

function norm(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Get a field from a record by trying normalized candidate header names. */
function field(rec, candidates) {
  const map = {};
  for (const k of Object.keys(rec)) map[norm(k)] = rec[k];
  for (const c of candidates) {
    const v = map[norm(c)];
    if (v != null && v !== '') return v;
  }
  return null;
}

// Account names (substrings) to exclude from imports, e.g. MONARCH_EXCLUDE_ACCOUNTS="401k,Pension".
// Lets you keep, say, retirement balances out of the net-worth/cashflow totals.
function excludedAccounts() {
  return (process.env.MONARCH_EXCLUDE_ACCOUNTS || '')
    .split(',')
    .map((s) => norm(s))
    .filter(Boolean);
}

function isExcludedAccount(name) {
  const n = norm(name);
  if (!n) return false;
  return excludedAccounts().some((e) => n.includes(e));
}

// Fixed housing categories to exclude from DISCRETIONARY spending, so a big but
// expected rent/mortgage payment doesn't read as a behavioral "spike". Override
// the list with MONARCH_FIXED_CATEGORIES="rent,mortgage,hoa".
function fixedCategories() {
  const custom = (process.env.MONARCH_FIXED_CATEGORIES || '').split(',').map((s) => norm(s)).filter(Boolean);
  return custom.length ? custom : ['rent', 'mortgage', 'housing', 'hoa', 'home loan'];
}
function isFixedCategory(category) {
  const c = norm(category);
  if (!c) return false;
  // norm() strips spaces, so multi-word entries ("home loan") must be normed
  // on both sides or they'd never match.
  return fixedCategories().some((f) => c.includes(norm(f)));
}

// Internal money movements that are NOT economic spending/income: transfers
// between your own accounts, credit-card payments (the purchases they pay for
// are already counted), and balance adjustments. Counting these as "spending"
// is the classic Monarch double-count — a $16k transfer to Fidelity or a credit
// card payment would swamp the real number and not match the Wealth tab.
// Override with MONARCH_TRANSFER_CATEGORIES="transfer,credit card payment".
function transferCategories() {
  const custom = (process.env.MONARCH_TRANSFER_CATEGORIES || '').split(',').map((s) => norm(s)).filter(Boolean);
  return custom.length ? custom : ['transfer', 'credit card payment', 'balance adjustment', 'loan payment', 'investments', 'investment'];
}
function isInternalTransfer(category) {
  const c = norm(category);
  if (!c) return false;
  // Norm both sides: "credit card payment" -> "creditcardpayment".
  return transferCategories().some((t) => c.includes(norm(t)));
}

// Investment / non-earned income categories to exclude from the savings-rate
// income total. Monarch lumps dividends, capital gains, tax refunds, and
// interest into its "income" category type, but those inflate the rate vs
// what Monarch's Reports → Cash Flow view shows (which focuses on earned
// income like paychecks). Override with MONARCH_EXCLUDE_INCOME_CATEGORIES.
function excludeIncomeCategories() {
  const custom = (process.env.MONARCH_EXCLUDE_INCOME_CATEGORIES || '')
    .split(',').map((s) => norm(s)).filter(Boolean);
  return custom.length ? custom : [
    'dividends',
    'capital gains',
    'interest income',
    'investment income',
    'tax return',
    'tax refund',
    'realized gain',
    'unrealized gain',
  ];
}
function isExcludedIncome(category) {
  const c = norm(category);
  if (!c) return false;
  return excludeIncomeCategories().some((e) => c.includes(norm(e)));
}

// Positive (money-in) transactions that are NOT earned income: refunds,
// reimbursements, cashback/rewards, returned purchases, balance adjustments.
// Monarch's own Income report excludes these (they aren't category_type=income),
// so counting them inflated the 30-day income figure. Used as a name-based guard
// only when Monarch's authoritative category_type isn't available (e.g. CSV).
const NON_INCOME_POSITIVE = [
  'refund', 'reimburs', 'cashback', 'cash back', 'rewards', 'returned purchase',
  'balance adjustment', 'credit card payment',
];
function isNonIncomePositive(category) {
  const c = norm(category);
  if (!c) return false;
  return NON_INCOME_POSITIVE.some((e) => c.includes(norm(e)));
}

/** Parse a currency/number cell: strips $ and commas, treats (x) as negative. */
function parseAmount(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim().replace(/[$,\s]/g, '');
  if (s === '') return NaN; // Number('') is 0 — guard against silent zeros
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return neg ? -n : n;
}

/** Parse a date cell (YYYY-MM-DD or M/D/YYYY) to an ISO day string, or null. */
function parseDay(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const mm = m[1].padStart(2, '0');
    const dd = m[2].padStart(2, '0');
    return `${m[3]}-${mm}-${dd}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function dayTs(dayIso) {
  return new Date(`${dayIso}T00:00:00Z`);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function stableId(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 24);
}

// --- classification -----------------------------------------------------------

/** Decide what a file is from its headers: 'transactions' | 'balances' | 'unknown'. */
function detectKind(headers = []) {
  const set = new Set(headers.map(norm));
  const has = (x) => set.has(norm(x));
  const some = (re) => [...set].some((h) => re.test(h));

  const hasDate = has('date');
  const hasAmount = has('amount');
  const hasNetWorth = some(/networth/);
  const hasBalance = has('balance') || has('currentbalance');
  const hasTxnish = has('merchant') || has('category') || has('account') || has('description');

  if (hasDate && hasAmount && hasTxnish) return 'transactions';
  if (hasNetWorth || (hasDate && hasBalance)) return 'balances';
  return 'unknown';
}

// --- mappers (pure) -----------------------------------------------------------

/**
 * Classify ONE transaction into exactly one wealth-flow bucket. This is the
 * single decision every path uses, so an identical transaction is bucketed
 * identically whether it arrives from the MCP sync, a GraphQL scrape, a CSV
 * import, or the document recompute.
 *
 *   'transfer' — internal money movement / card payment: never a flow.
 *   'excluded' — investment income, tax refunds, and standalone
 *                reimbursement/cashback categories: neither earned income nor a
 *                spend, and NOT attached to a real spend category, so they must
 *                not net one down (Monarch's Income report excludes them too).
 *   'income'   — an earned-income category (signed: a clawback reduces income).
 *   'expense'  — everything else. Signed spend = -amount, so a positive refund
 *                that Monarch keeps IN its original expense category nets that
 *                category down — the same refund-netting Monarch Reports applies.
 *
 * Authoritative signals win: an explicit income-category NAME (from Monarch's
 * GetCategories) first, then Monarch's category_type; the amount-sign name
 * heuristic is used only as a last resort for the CSV/recompute path that
 * carries neither.
 */
function classifyTransaction({ amount, category, categoryType, incomeCategoryNames }) {
  const type = String(categoryType || '').toLowerCase();
  if (type === 'transfer' || isInternalTransfer(category)) return 'transfer';
  if (isExcludedIncome(category)) return 'excluded';
  if (amount > 0 && isNonIncomePositive(category)) return 'excluded';
  const isIncomeCat = (incomeCategoryNames && incomeCategoryNames.size)
    ? incomeCategoryNames.has(String(category || '').toLowerCase())
    : (type ? type === 'income' : amount > 0);
  return isIncomeCat ? 'income' : 'expense';
}

/**
 * THE single authoritative daily wealth-flow calculation. Every path that
 * writes wealth:spending / spending_discretionary / income / net_cashflow —
 * the MCP sync (monarch-mcp-sync.js), the GraphQL/CSV importer + the recompute
 * (via mapTransactions below) — funnels through here, so all four metrics come
 * from ONE transaction universe with ONE set of refund-netting / transfer /
 * income / fixed-housing rules. Total expense and fixed housing are the SAME
 * netted universe, so `spending === fixed + discretionary` and
 * `discretionary === spending - fixed` hold to the cent BY CONSTRUCTION — never
 * by coincidence of two independently-filtered queries.
 *
 * @param {Array} txns - normalized: { date:'YYYY-MM-DD', amount: signed number
 *   (negative = money out, positive = money in), category, categoryType? }
 * @param {object} opts
 * @param {Set<string>} [opts.incomeCategoryNames] - lower-cased Monarch income
 *   category names (authoritative when present).
 * @param {string} [opts.today] - LOCAL YYYY-MM-DD; transactions dated AFTER this
 *   (pending / future) are excluded. Defaults to local today in `tz`.
 * @returns {{ byDay: Map<string,{spending,discretionary,fixed,income,netCashflow}>,
 *             expenseTxns:number, incomeTxns:number }}
 */
function reconcileWealthFlows(txns = [], opts = {}) {
  const tz = opts.tz || process.env.TZ || 'America/New_York';
  const today = opts.today || new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const incomeCategoryNames = opts.incomeCategoryNames || null;
  const byDay = new Map();
  const ensure = (day) => {
    let b = byDay.get(day);
    if (!b) { b = { spending: 0, discretionary: 0, fixed: 0, income: 0, netCashflow: 0 }; byDay.set(day, b); }
    return b;
  };
  let expenseTxns = 0, incomeTxns = 0;
  for (const t of txns) {
    const day = t.date ? String(t.date).slice(0, 10) : null;
    const amount = Number(t.amount);
    if (!day || !Number.isFinite(amount) || amount === 0) continue;
    if (day > today) continue; // pending / future-dated excluded (LOCAL boundary)
    const cls = classifyTransaction({ amount, category: t.category, categoryType: t.categoryType, incomeCategoryNames });
    if (cls === 'transfer' || cls === 'excluded') continue;
    const b = ensure(day);
    if (cls === 'income') {
      b.income += amount; // signed — a reversal reduces income
      incomeTxns += 1;
    } else {
      const spend = -amount; // signed — a positive refund nets its category down
      if (isFixedCategory(t.category)) b.fixed += spend; else b.discretionary += spend;
      expenseTxns += 1;
    }
  }
  for (const b of byDay.values()) {
    // Round the PARTS, then derive the total from them, so the invariant
    // spending === fixed + discretionary survives float cleanup exactly.
    b.fixed = round2(b.fixed);
    b.discretionary = round2(b.discretionary);
    b.spending = round2(b.fixed + b.discretionary);
    b.income = round2(b.income);
    b.netCashflow = round2(b.income - b.spending);
  }
  return { byDay, expenseTxns, incomeTxns };
}

/**
 * Aggregate transaction records into daily spending/income/cashflow metrics and
 * one document per transaction. Aggregating per day (not per row) guarantees
 * unique (ts, metric) keys so the bulk metric insert can't conflict with itself.
 * The FLOW math is delegated to reconcileWealthFlows (the single authoritative
 * calculation); this function only adds the document-per-transaction mapping and
 * the metric-row emission (with optional full-window zero-fill).
 *
 * opts.windowStart/windowEnd (YYYY-MM-DD, LOCAL calendar dates): when given,
 * flow metrics are emitted for EVERY day in that range (0 when a day has none)
 * instead of only days present in `records` — see the stale-day-survival note
 * below. Passed by the live Monarch API sync (monarch-api.js), which queries a
 * known date window; omitted by the CSV importer and recompute-wealth.js,
 * which have no such window and must keep their existing sparse-day behavior.
 */
function mapTransactions(records = [], opts = {}) {
  const { windowStart, windowEnd } = opts;
  const documents = [];
  // Monarch can return pending/scheduled transactions dated today-or-later.
  // LOCAL calendar day, not UTC — new Date().toISOString().slice(0,10) is the
  // UTC day, wrong for several hours around each local midnight (same bug
  // class fixed via localToday in monarch-mcp-sync.js). opts.today lets callers
  // (and tests) pin it deterministically.
  const tz = process.env.TZ || 'America/New_York';
  const today = opts.today || new Date().toLocaleDateString('en-CA', { timeZone: tz });

  // Survivors of the account/date/parse filters, normalized for the shared
  // flow reconciler. CSV/GraphQL/document records carry no category_type, so
  // the reconciler falls back to its amount-sign name heuristic (unchanged
  // behavior for these paths) — but through the SAME code the MCP sync uses.
  const flowTxns = [];
  for (const rec of records) {
    const day = parseDay(field(rec, ['date']));
    const amount = parseAmount(field(rec, ['amount']));
    if (!day || !Number.isFinite(amount)) continue;
    if (day > today) continue; // skip pending/future-dated transactions

    const merchant = field(rec, ['merchant', 'description', 'name']) || 'Transaction';
    const category = field(rec, ['category']);
    const account = field(rec, ['account']);
    if (isExcludedAccount(account)) continue;
    const tags = field(rec, ['tags']);
    const original = field(rec, ['original statement', 'originalstatement', 'notes']);

    flowTxns.push({ date: day, amount, category, categoryType: field(rec, ['category type', 'categorytype']) });

    // Prefer Monarch's stable transaction id (from the API) as the document
    // identity: it survives edits to date/category/amount, so recategorizing or
    // MOVING a transaction to another month updates the same document (its
    // occurred_at changes) instead of orphaning a stale copy at the old date.
    // CSV exports carry no id, so those fall back to a content hash.
    const monarchId = field(rec, ['id', 'transactionid']);
    const externalId = monarchId
      ? `monarch:${monarchId}`
      : stableId([day, String(amount), merchant, account || '', original || '']);

    documents.push({
      source: SOURCE,
      domain: 'wealth',
      externalId,
      title: merchant,
      url: null,
      content: [merchant, category, `$${amount}`, account].filter(Boolean).join(' — '),
      occurredAt: day,
      metadata: { amount, category, account, tags, merchant },
    });
  }

  // ── Flow metrics: the ONE authoritative calculation (shared with the MCP sync).
  const { byDay } = reconcileWealthFlows(flowTxns, { today, tz });
  const spendByDay = new Map([...byDay].map(([d, b]) => [d, b.spending]));
  const discretionaryByDay = new Map([...byDay].map(([d, b]) => [d, b.discretionary]));
  const incomeByDay = new Map([...byDay].map(([d, b]) => [d, b.income]));

  const metrics = [];
  const m = (metric, value, day) => ({
    ts: dayTs(day), domain: 'wealth', metric, value: round2(value), unit: 'usd', source: SOURCE,
  });
  const nextDay = (d) => new Date(dayTs(d).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (windowStart && windowEnd) {
    // Bug bash root cause (same class as monarch-mcp-sync.js): emitting flow
    // metrics ONLY on days present in spendByDay/incomeByDay leaves a day
    // whose spend dropped to zero (every transaction that day deleted,
    // refunded, or recategorized into a fixed category) with its stale,
    // previously-stored (higher) value never overwritten — inflating every
    // MTD sum indefinitely. This path (the live GraphQL/scrape sync, used
    // whenever the primary MCP path is unavailable) queries a KNOWN date
    // window, so emit for every day in it, 0 when none — exactly like the
    // MCP path already does.
    //
    // Guard: this only fires when Monarch's own fetch call has already
    // resolved (a hard failure there throws before ever reaching this
    // function, aborting the whole sync) — so an EMPTY records array here
    // means the fetch succeeded but reported nothing at all, which is worth
    // treating with suspicion rather than blasting zeros across the window.
    // Unlike the primary MCP path, spendByDay/incomeByDay individually being
    // empty is NOT ambiguous here: this connector has only one data source
    // (the transaction records themselves, already fetched), so a real fetch
    // with real records that simply has no income this window (or no
    // discretionary spend, etc.) is a normal, legitimate state — write it.
    if (records.length > 0) {
      for (let day = windowStart; day <= windowEnd; day = nextDay(day)) {
        metrics.push(m('spending', spendByDay.get(day) || 0, day));
        metrics.push(m('spending_discretionary', discretionaryByDay.get(day) || 0, day));
        metrics.push(m('income', incomeByDay.get(day) || 0, day));
        metrics.push(m('net_cashflow', (incomeByDay.get(day) || 0) - (spendByDay.get(day) || 0), day));
      }
    }
  } else {
    // Sparse (CSV import / recompute-without-window): emit only days that had
    // any activity — but a complete four-metric row for each, straight from the
    // reconciler, so spending === fixed + discretionary holds per day.
    for (const [day, b] of byDay) {
      metrics.push(m('spending', b.spending, day));
      metrics.push(m('spending_discretionary', b.discretionary, day));
      metrics.push(m('income', b.income, day));
      metrics.push(m('net_cashflow', b.netCashflow, day));
    }
  }
  return { metrics, documents };
}

/**
 * Map balance/net-worth records into snapshot metrics. Tolerant of formats:
 * a Net Worth column, or per-account Balance rows (summed per date, classified
 * into assets/liabilities when a Type column is present).
 */
function mapBalances(records = []) {
  const byDay = new Map(); // day -> { networth, assets, liabilities, sawType }

  for (const rec of records) {
    const day = parseDay(field(rec, ['date']));
    if (!day) continue;
    if (isExcludedAccount(field(rec, ['account']))) continue;
    const slot = byDay.get(day) || { networth: null, assets: 0, liabilities: 0, sawType: false, summed: 0 };

    const nw = parseAmount(field(rec, ['net worth', 'networth']));
    if (Number.isFinite(nw)) slot.networth = nw;

    const bal = parseAmount(field(rec, ['balance', 'current balance', 'amount']));
    if (Number.isFinite(bal)) {
      slot.summed += bal;
      const type = norm(field(rec, ['type', 'account type', 'group']) || '');
      if (type) {
        slot.sawType = true;
        if (/credit|loan|liabilit|debt|mortgage/.test(type)) slot.liabilities += Math.abs(bal);
        else slot.assets += bal;
      }
    }
    byDay.set(day, slot);
  }

  const metrics = [];
  const push = (metric, value, day) =>
    metrics.push({ ts: dayTs(day), domain: 'wealth', metric, value: round2(value), unit: 'usd', source: SOURCE });

  for (const [day, s] of byDay) {
    if (s.networth != null) {
      push('net_worth', s.networth, day);
    } else if (s.sawType) {
      push('assets', s.assets, day);
      push('liabilities', s.liabilities, day);
      push('net_worth', s.assets - s.liabilities, day);
    } else if (s.summed) {
      // No net-worth column and no account types — best-effort sum of balances.
      push('net_worth', s.summed, day);
    }
  }
  return { metrics };
}

/** Pure: turn a parsed file into metrics+documents based on detected kind. */
function mapFile({ headers, records }) {
  const kind = detectKind(headers);
  if (kind === 'transactions') return { kind, ...mapTransactions(records) };
  if (kind === 'balances') return { kind, metrics: mapBalances(records).metrics, documents: [] };
  return { kind: 'unknown', metrics: [], documents: [] };
}

/**
 * Pure: turn raw CSV text (one uploaded Monarch export) into metrics+documents.
 * Used by the upload endpoint so the cloud can ingest a file it never sees on
 * disk. Mirrors the per-file branch of sync().
 */
function importText(text) {
  const parsed = parseCsvObjects(text);
  const kind = detectKind(parsed.headers);
  if (kind === 'transactions') {
    const { metrics, documents } = mapTransactions(parsed.records);
    return { kind, rows: parsed.records.length, metrics: dedupeMetrics(metrics), documents };
  }
  if (kind === 'balances') {
    return { kind, rows: parsed.records.length, metrics: dedupeMetrics(mapBalances(parsed.records).metrics), documents: [] };
  }
  return { kind: 'unknown', rows: parsed.records.length, metrics: [], documents: [] };
}

/** De-dupe metrics so the bulk insert never sees a repeated (ts, metric) key. */
function dedupeMetrics(metrics) {
  const byKey = new Map();
  for (const row of metrics) {
    const key = `${row.ts.toISOString()}|${row.metric}`;
    const prev = byKey.get(key);
    // Flows (spending/income/cashflow) sum; snapshots (net_worth/...) take last.
    if (prev && /spending|spending_discretionary|income|cashflow/.test(row.metric)) {
      prev.value = round2(prev.value + row.value);
    } else {
      byKey.set(key, { ...row });
    }
  }
  return [...byKey.values()];
}

module.exports = {
  id: SOURCE,
  domain: 'wealth',
  displayName: 'Monarch (CSV import)',

  async sync(ctx = {}) {
    // The MCP auto-sync is the source of truth when configured; this CSV importer
    // is only the manual fallback for when it isn't. Running BOTH writes the same
    // transactions under different external_id schemes (monarch:<id> vs a content
    // hash), producing transient duplicate documents that double category spend
    // until a reconcile prunes them. Stay dormant when MCP is live.
    try {
      const monarchMcp = require('../services/monarch-mcp');
      if (monarchMcp.isConfigured && monarchMcp.isConfigured()) {
        return { metrics: [], documents: [], config: ctx.config || {} };
      }
    } catch { /* MCP module unavailable — run the CSV importer normally */ }

    const dir = importDir();
    if (!fs.existsSync(dir)) {
      return { metrics: [], documents: [], config: ctx.config || {} };
    }

    const processed = { ...(ctx.config?.processed || {}) };
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.csv'))
      .sort();

    const txnRecords = [];
    const balanceRecords = [];
    const documents = [];
    const summary = [];

    for (const file of files) {
      const full = path.join(dir, file);
      const text = fs.readFileSync(full, 'utf8');
      const hash = crypto.createHash('sha1').update(text).digest('hex');
      if (processed[file] === hash) {
        summary.push({ file, kind: 'skipped (unchanged)' });
        continue;
      }

      const parsed = parseCsvObjects(text);
      const kind = detectKind(parsed.headers);
      if (kind === 'transactions') {
        txnRecords.push(...parsed.records);
        const { documents: docs } = mapTransactions(parsed.records);
        documents.push(...docs);
      } else if (kind === 'balances') {
        balanceRecords.push(...parsed.records);
      }
      summary.push({ file, kind, rows: parsed.records.length });
      processed[file] = hash;
    }

    // Aggregate across all files of each kind so daily keys stay unique.
    const metrics = dedupeMetrics([
      ...mapTransactions(txnRecords).metrics,
      ...mapBalances(balanceRecords).metrics,
    ]);

    return { metrics, documents, config: { processed }, summary };
  },

  // exported for unit testing
  detectKind,
  mapTransactions,
  mapBalances,
  mapFile,
  importText,
  dedupeMetrics,
  parseAmount,
  parseDay,
  isInternalTransfer,
  isFixedCategory,
  isExcludedIncome,
  isNonIncomePositive,
  // the single authoritative wealth-flow calculation, shared by every path
  reconcileWealthFlows,
  classifyTransaction,
};
