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
 * Aggregate transaction records into daily spending/income/cashflow metrics and
 * one document per transaction. Aggregating per day (not per row) guarantees
 * unique (ts, metric) keys so the bulk metric insert can't conflict with itself.
 */
function mapTransactions(records = []) {
  const spendByDay = new Map();
  const discretionaryByDay = new Map(); // spend excluding fixed housing (rent/mortgage)
  const incomeByDay = new Map();
  const documents = [];

  for (const rec of records) {
    const day = parseDay(field(rec, ['date']));
    const amount = parseAmount(field(rec, ['amount']));
    if (!day || !Number.isFinite(amount)) continue;

    const merchant = field(rec, ['merchant', 'description', 'name']) || 'Transaction';
    const category = field(rec, ['category']);
    const account = field(rec, ['account']);
    if (isExcludedAccount(account)) continue;
    const tags = field(rec, ['tags']);
    const original = field(rec, ['original statement', 'originalstatement', 'notes']);

    // Internal transfers / card payments are not spending or income — skip them
    // from every flow metric (they still post as documents below for searchability).
    const internal = isInternalTransfer(category);

    // Monarch convention: negative = money out, positive = money in.
    if (internal) {
      // no-op: excluded from spend/discretionary/income/cashflow
    } else if (amount < 0) {
      spendByDay.set(day, (spendByDay.get(day) || 0) + -amount);
      // Discretionary = everything except fixed housing, so rent/mortgage doesn't
      // masquerade as a spending spike in the weekly review.
      if (!isFixedCategory(category)) {
        discretionaryByDay.set(day, (discretionaryByDay.get(day) || 0) + -amount);
      }
    } else if (amount > 0 && !isExcludedIncome(category) && !isNonIncomePositive(category)) {
      // CSV path has no category_type, so guard against refunds/reimbursements/
      // cashback being miscounted as income via the category name.
      incomeByDay.set(day, (incomeByDay.get(day) || 0) + amount);
    }

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

  const metrics = [];
  const m = (metric, value, day) => ({
    ts: dayTs(day), domain: 'wealth', metric, value: round2(value), unit: 'usd', source: SOURCE,
  });
  const days = new Set([...spendByDay.keys(), ...incomeByDay.keys()]);
  for (const day of days) {
    const spend = spendByDay.get(day) || 0;
    const income = incomeByDay.get(day) || 0;
    if (spendByDay.has(day)) metrics.push(m('spending', spend, day));
    if (discretionaryByDay.has(day)) metrics.push(m('spending_discretionary', discretionaryByDay.get(day), day));
    if (incomeByDay.has(day)) metrics.push(m('income', income, day));
    metrics.push(m('net_cashflow', income - spend, day));
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
};
