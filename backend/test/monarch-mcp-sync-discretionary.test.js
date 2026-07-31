// MTD discretionary-spending reconciliation bug bash.
//
// Production report: Monarch Reports showed $8,153.15 total spend / $5,695.00
// Rent for July 2026 ($2,458.15 expected discretionary), but NormOS's Chief
// Brief reported $3,492 — an overstatement of ~$1,033.85.
//
// Root cause: syncViaMcp() only emitted 'spending'/'spending_discretionary'
// metric rows for days PRESENT in that run's expense maps. A day whose
// discretionary spend dropped to zero (every non-fixed transaction that day
// deleted, refunded, or recategorized into a fixed category like Rent) was
// simply ABSENT from those maps, so its stale, previously-stored (higher)
// value was never overwritten — it kept inflating every later MTD sum. A
// second, related bug: discretionary was computed via a SEPARATE, independently
// -filtered GetCashFlow call (exclude_categories: transfers+fixed), which
// could diverge from (total - fixed) if Monarch's exclude_categories filter
// doesn't behave exactly as assumed.
//
// Fix: discretionary is now DERIVED as total-expense minus fixed-housing,
// both drawn from the transaction loop's fixed subset (never an independent
// query), and spending/spending_discretionary emit for EVERY day in the sync
// window (0 when none) — exactly like income/net_cashflow already did —
// so a day that goes quiet gets an explicit 0 row that correctly REPLACES
// (not sums with) whatever was stored before.
const test = require('node:test');
const { afterEach } = test;
const assert = require('node:assert/strict');
const rpc = require('../src/services/monarch-mcp-rpc');
const monarchMcp = require('../src/services/monarch-mcp');
const sourcesStore = require('../src/store/sources');

monarchMcp.isConfigured = () => true;
sourcesStore.registerSource = async () => {}; // no live DB needed — syncViaMcp is pure aside from this call

const monarchMcpSync = require('../src/connectors/monarch-mcp-sync');

const ORIGINAL_CALL_TOOL_JSON = rpc.callToolJson;
afterEach(() => { rpc.callToolJson = ORIGINAL_CALL_TOOL_JSON; });

// Includes an income-type category so an intentionally-empty transaction
// list (simulating "everything in this window was deleted") isn't
// ambiguous with the total-outage guard, which fires on
// (0 income categories AND 0 transactions) — a real account's GetCategories
// always returns at least one income category, so this fixture mirrors that.
const CATEGORIES = { categories: [
  { name: 'Groceries', category_type: 'expense' }, { name: 'Rent', category_type: 'expense' },
  { name: 'Dining', category_type: 'expense' }, { name: 'Utilities', category_type: 'expense' },
  { name: 'Paychecks', category_type: 'income' },
] };

function stubRpc({ transactions = [], cashflow = { data: [] } } = {}) {
  rpc.callToolJson = async (tool, args) => {
    if (tool === 'GetTransactions') return { transactions };
    if (tool === 'GetCategories') return CATEGORIES;
    if (tool === 'GetAccounts') return { total_balance: 10000 };
    if (tool === 'GetCashFlow') return cashflow;
    return {};
  };
}

function metricsByDay(metrics, metric) {
  const out = new Map();
  for (const r of metrics) if (r.metric === metric) out.set(r.ts.toISOString().slice(0, 10), Number(r.value));
  return out;
}

// LOCAL calendar day, not UTC — syncViaMcp's own `today` (via localToday(),
// see its comment above) is local, and ctx.now here defaults to the real
// clock same as syncViaMcp's `now`. A UTC-sliced fixture drifts from that for
// ~4-5 hours every evening ET (after UTC has already rolled to the next
// calendar day but it's still "today" locally) — exactly the bug class this
// file exists to regression-test, just left unfixed in the fixture itself:
// a `today`-dated transaction would compare as tomorrow's (pending) date from
// syncViaMcp's local perspective and get silently excluded.
const TZ = process.env.TZ || 'America/New_York';
const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 864e5).toISOString().slice(0, 10);
const tomorrow = new Date(new Date(`${today}T00:00:00Z`).getTime() + 864e5).toISOString().slice(0, 10);

// ---- 1. MTD discretionary equals MTD total minus fixed housing to the cent ----

test('discretionary equals total minus fixed-housing to the cent, across multiple days and categories', async () => {
  stubRpc({
    transactions: [
      { id: 't1', date: yesterday, amount: -100, category: 'Groceries' },
      { id: 't2', date: yesterday, amount: -5695, category: 'Rent' },
      { id: 't3', date: today, amount: -30, category: 'Dining' },
    ],
    // GetCashFlow empty -> falls back to the transaction-derived total, which
    // is the SAME universe fixedByDay is drawn from, so the identity is exact
    // by construction, not by coincidence of two independent numbers agreeing.
    cashflow: { data: [] },
  });
  const { metrics } = await monarchMcpSync.syncViaMcp({});
  const spending = metricsByDay(metrics, 'spending');
  const discretionary = metricsByDay(metrics, 'spending_discretionary');

  const mtdTotal = [...spending.values()].reduce((a, v) => a + v, 0);
  const mtdDiscretionary = [...discretionary.values()].reduce((a, v) => a + v, 0);
  const fixed = mtdTotal - mtdDiscretionary;

  assert.equal(Math.round((mtdTotal - 5825) * 100), 0, `expected total 5825, got ${mtdTotal}`); // 100+5695+30
  assert.equal(Math.round((fixed - 5695) * 100), 0, `expected fixed 5695, got ${fixed}`);
  assert.equal(Math.round((mtdDiscretionary - 130) * 100), 0, `expected discretionary 130, got ${mtdDiscretionary}`); // 100+30
});

// ---- 2. Recategorization removes a transaction from discretionary on the next sync ----

test('a transaction recategorized from discretionary to Rent removes it from discretionary on the next sync', async () => {
  stubRpc({ transactions: [{ id: 't1', date: yesterday, amount: -800, category: 'Utilities' }] });
  const first = await monarchMcpSync.syncViaMcp({});
  assert.equal(metricsByDay(first.metrics, 'spending_discretionary').get(yesterday), 800);

  // Same transaction, same id/date/amount — now recategorized to Rent.
  stubRpc({ transactions: [{ id: 't1', date: yesterday, amount: -800, category: 'Rent' }] });
  const second = await monarchMcpSync.syncViaMcp({});
  assert.equal(metricsByDay(second.metrics, 'spending_discretionary').get(yesterday), 0, 'recategorized-to-fixed spend must drop OUT of discretionary');
  assert.equal(metricsByDay(second.metrics, 'spending').get(yesterday), 800, 'total spend is unaffected by recategorization, only the fixed/discretionary split changes');
});

// ---- 3. A deleted or refunded transaction removes the previously stored amount ----

test('a deleted transaction (absent from the next sync) zeroes the day, not leaving the stale amount', async () => {
  stubRpc({ transactions: [{ id: 't1', date: yesterday, amount: -250, category: 'Dining' }] });
  const first = await monarchMcpSync.syncViaMcp({});
  assert.equal(metricsByDay(first.metrics, 'spending_discretionary').get(yesterday), 250);

  // The transaction is gone entirely from this sync's window (deleted in Monarch).
  stubRpc({ transactions: [] });
  const second = await monarchMcpSync.syncViaMcp({});
  assert.equal(metricsByDay(second.metrics, 'spending').get(yesterday), 0, 'the day must get an explicit 0, not be silently absent');
  assert.equal(metricsByDay(second.metrics, 'spending_discretionary').get(yesterday), 0);
});

test('a refunded transaction (net-zero day) zeroes discretionary rather than keeping the pre-refund amount', async () => {
  stubRpc({ transactions: [{ id: 't1', date: yesterday, amount: -400, category: 'Shopping' }] });
  const first = await monarchMcpSync.syncViaMcp({});
  assert.equal(metricsByDay(first.metrics, 'spending_discretionary').get(yesterday), 400);

  // Refund posts as a same-day positive that nets the original purchase to
  // zero net expense — Monarch's own transaction record no longer shows a
  // net outflow for that item, so the original purchase transaction is gone
  // (refunded purchases are typically removed/reversed at the source, not
  // left as a negative amount) — simulate the post-refund state directly.
  stubRpc({ transactions: [] });
  const second = await monarchMcpSync.syncViaMcp({});
  assert.equal(metricsByDay(second.metrics, 'spending_discretionary').get(yesterday), 0);
});

// ---- 4. A day that changes to zero does not retain a stale metric ----

test('every day in the sync window gets an explicit spending/spending_discretionary row, including quiet days', async () => {
  stubRpc({ transactions: [{ id: 't1', date: yesterday, amount: -50, category: 'Groceries' }] });
  const { metrics } = await monarchMcpSync.syncViaMcp({});
  const spending = metricsByDay(metrics, 'spending');
  const discretionary = metricsByDay(metrics, 'spending_discretionary');
  // A day with no transactions at all must still be present with value 0 —
  // not simply absent from the metrics array — so a future re-sync with
  // still-zero data continues to correctly overwrite (not accumulate).
  // Derived from the same local-day `today` as yesterday/tomorrow above
  // (not an independently UTC-sliced Date.now()), so it can't drift a day
  // out of step with them during the UTC-ahead-of-ET window.
  const twoDaysAgo = new Date(new Date(`${today}T00:00:00Z`).getTime() - 2 * 864e5).toISOString().slice(0, 10);
  assert.equal(spending.get(twoDaysAgo), 0);
  assert.equal(discretionary.get(twoDaysAgo), 0);
});

// Self-review finding: `today` used to come from ymd(new Date()), which
// slices toISOString() — always UTC. For ~4-5 hours every evening ET (after
// UTC has already rolled to the next calendar day but it's still "today"
// locally), a genuinely pending transaction dated exactly tomorrow (from the
// user's LOCAL perspective) would compare EQUAL to (not greater than) a
// UTC-based `today` and slip past the `day > today` filter. localToday() +
// syncViaMcp's ctx.now override make this directly testable without mocking
// global Date.
test('localToday resolves the LOCAL calendar day, not the UTC one, during the evening-ET/already-tomorrow-UTC window', () => {
  // 9pm ET on July 31 is 1am UTC on August 1 — UTC has already rolled to
  // August while it's still July 31 locally.
  const now = new Date('2026-08-01T01:00:00Z');
  assert.equal(monarchMcpSync.localToday('America/New_York', now), '2026-07-31');
});

test('a transaction genuinely dated "tomorrow" (local) is still excluded as pending during the UTC-already-rolled-over window', async () => {
  const now = new Date('2026-08-01T01:00:00Z'); // 9pm ET, July 31 — still July 31 locally
  stubRpc({
    transactions: [
      { id: 't1', date: '2026-07-31', amount: -40, category: 'Groceries' }, // today, local
      { id: 't2', date: '2026-08-01', amount: -9999, category: 'Groceries' }, // tomorrow, local — pending
    ],
  });
  const { metrics } = await monarchMcpSync.syncViaMcp({ now, tz: 'America/New_York' });
  const spending = metricsByDay(metrics, 'spending');
  assert.equal(spending.get('2026-07-31'), 40, 'today\'s (local) settled transaction counts');
  assert.equal(spending.get('2026-08-01'), undefined, 'a locally-future transaction must be excluded even though UTC has already rolled to that date');
});

// ---- 5. Pending/future transactions follow the same policy as Monarch Reports ----

test('future-dated (pending/scheduled) transactions are excluded from spending and discretionary', async () => {
  stubRpc({
    transactions: [
      { id: 't1', date: today, amount: -20, category: 'Groceries' },
      { id: 't2', date: tomorrow, amount: -9999, category: 'Groceries' }, // pending/future
    ],
  });
  const { metrics } = await monarchMcpSync.syncViaMcp({});
  const spending = metricsByDay(metrics, 'spending');
  assert.equal(spending.get(today), 20, 'today\'s settled transaction counts');
  assert.equal(spending.get(tomorrow), undefined, 'a future-dated transaction must not appear at all, not even as a 0 offset');
});

// ---- 6. Repeated syncs are idempotent ----

test('running the same sync twice produces identical metrics (idempotent, no accumulation)', async () => {
  stubRpc({
    transactions: [
      { id: 't1', date: yesterday, amount: -120, category: 'Groceries' },
      { id: 't2', date: yesterday, amount: -900, category: 'Rent' },
    ],
  });
  const first = await monarchMcpSync.syncViaMcp({});
  stubRpc({
    transactions: [
      { id: 't1', date: yesterday, amount: -120, category: 'Groceries' },
      { id: 't2', date: yesterday, amount: -900, category: 'Rent' },
    ],
  });
  const second = await monarchMcpSync.syncViaMcp({});

  const firstSpend = metricsByDay(first.metrics, 'spending').get(yesterday);
  const secondSpend = metricsByDay(second.metrics, 'spending').get(yesterday);
  const firstDisc = metricsByDay(first.metrics, 'spending_discretionary').get(yesterday);
  const secondDisc = metricsByDay(second.metrics, 'spending_discretionary').get(yesterday);
  assert.equal(firstSpend, secondSpend, 'total spend must not accumulate across repeated syncs');
  assert.equal(firstDisc, secondDisc, 'discretionary must not accumulate across repeated syncs');
  assert.equal(firstSpend, 1020);
  assert.equal(firstDisc, 120);
});

// ---- 7. Category totals reconcile to the MTD total (derivation-level) ----

test('summing every category (fixed + non-fixed) reconciles exactly to the total spend metric', async () => {
  const txns = [
    { id: 't1', date: yesterday, amount: -75.5, category: 'Groceries' },
    { id: 't2', date: yesterday, amount: -1200, category: 'Rent' },
    { id: 't3', date: today, amount: -42.25, category: 'Dining' },
    { id: 't4', date: today, amount: -60, category: 'Utilities' },
  ];
  stubRpc({ transactions: txns });
  const { metrics } = await monarchMcpSync.syncViaMcp({});
  const spending = metricsByDay(metrics, 'spending');
  const mtdTotal = [...spending.values()].reduce((a, v) => a + v, 0);
  const categorySum = txns.reduce((a, t) => a + Math.abs(t.amount), 0);
  assert.equal(Math.round((mtdTotal - categorySum) * 100), 0, `category sum ${categorySum} must reconcile exactly to metric total ${mtdTotal}`);
});

// ---- expense-detection-failure guard (mirrors the pre-existing income guard) ----

test('a total expense-detection failure (real transactions, zero recognized as expenses) skips the write rather than zeroing real history', async () => {
  // All positive/income-shaped — no negative amounts at all this run, which
  // for EXPENSES (unlike income's sparse paycheck days) is a strong signal
  // something broke, not a genuinely expense-free window.
  stubRpc({ transactions: [{ id: 't1', date: yesterday, amount: 500, category: 'Paychecks' }] });
  const { metrics } = await monarchMcpSync.syncViaMcp({});
  const hasSpendingWrite = metrics.some((m) => m.metric === 'spending' || m.metric === 'spending_discretionary');
  assert.equal(hasSpendingWrite, false, 'no spending/spending_discretionary rows should be written on a detection failure');
});
