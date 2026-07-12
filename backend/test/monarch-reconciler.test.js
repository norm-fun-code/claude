// P2 hardening: the ONE authoritative wealth-flow calculation
// (reconcileWealthFlows). Before this, the MCP sync mixed a refund-netted
// GetCashFlow *total* with a raw-negative fixed-housing *subset* (two
// universes), while the CSV/GraphQL/recompute path (mapTransactions) dropped
// positive refunds entirely and classified income differently. Now every path
// funnels through reconcileWealthFlows, so total and fixed come from the SAME
// netted universe and spending === fixed + discretionary to the cent.
//
// Pure-function tests — no DB, no network. Deterministic `today` so the
// pending/future-boundary cases don't depend on the wall clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/connectors/monarch');

const TODAY = '2026-07-12';
const INCOME_CATS = new Set(['paychecks']);

function recon(txns, opts = {}) {
  return m.reconcileWealthFlows(txns, { today: TODAY, incomeCategoryNames: INCOME_CATS, ...opts });
}
function day(byDay, d) {
  return byDay.get(d) || { spending: 0, discretionary: 0, fixed: 0, income: 0, netCashflow: 0 };
}

test('1. rent + ordinary discretionary: total splits into fixed + discretionary exactly', () => {
  const { byDay } = recon([
    { date: '2026-07-01', amount: -5695, category: 'Rent' },
    { date: '2026-07-01', amount: -120.5, category: 'Groceries' },
  ]);
  const b = day(byDay, '2026-07-01');
  assert.equal(b.fixed, 5695);
  assert.equal(b.discretionary, 120.5);
  assert.equal(b.spending, 5815.5);
  assert.equal(b.spending, b.fixed + b.discretionary); // the load-bearing invariant
});

test('2. a partial AND a full Rent refund net the fixed-housing category down (same universe as total)', () => {
  const partial = recon([
    { date: '2026-07-01', amount: -5695, category: 'Rent' },
    { date: '2026-07-03', amount: 500, category: 'Rent' }, // a $500 credit posted back to Rent
  ]);
  // Different days, but the MONTH total nets the refund.
  const monthFixed = [...partial.byDay.values()].reduce((a, b) => a + b.fixed, 0);
  const monthSpend = [...partial.byDay.values()].reduce((a, b) => a + b.spending, 0);
  assert.equal(Math.round(monthFixed * 100) / 100, 5195); // 5695 - 500
  assert.equal(Math.round(monthSpend * 100) / 100, 5195);

  const full = recon([
    { date: '2026-07-01', amount: -5695, category: 'Rent' },
    { date: '2026-07-01', amount: 5695, category: 'Rent' },
  ]);
  const b = day(full.byDay, '2026-07-01');
  assert.equal(b.fixed, 0);
  assert.equal(b.spending, 0);
});

test('3. an ordinary purchase refund nets its discretionary category down', () => {
  const { byDay } = recon([
    { date: '2026-07-01', amount: -120, category: 'Groceries' },
    { date: '2026-07-01', amount: 30, category: 'Groceries' }, // returned item
  ]);
  const b = day(byDay, '2026-07-01');
  assert.equal(b.discretionary, 90);
  assert.equal(b.fixed, 0);
  assert.equal(b.spending, 90);
});

test('4. recategorizing a transaction into/out of Rent moves spend between fixed and discretionary, total unchanged', () => {
  const asGroceries = recon([{ date: '2026-07-01', amount: -100, category: 'Groceries' }]);
  const asRent = recon([{ date: '2026-07-01', amount: -100, category: 'Rent' }]);
  assert.equal(day(asGroceries.byDay, '2026-07-01').discretionary, 100);
  assert.equal(day(asGroceries.byDay, '2026-07-01').fixed, 0);
  assert.equal(day(asRent.byDay, '2026-07-01').fixed, 100);
  assert.equal(day(asRent.byDay, '2026-07-01').discretionary, 0);
  // Total spend is identical either way — only the split changed.
  assert.equal(day(asGroceries.byDay, '2026-07-01').spending, day(asRent.byDay, '2026-07-01').spending);
});

test('5. a deleted transaction is simply absent — its day recomputes lower, and mapTransactions zero-fills an emptied day', () => {
  const before = recon([
    { date: '2026-07-01', amount: -100, category: 'Groceries' },
    { date: '2026-07-02', amount: -40, category: 'Dining' },
  ]);
  const afterDelete = recon([{ date: '2026-07-01', amount: -100, category: 'Groceries' }]);
  assert.equal(day(before.byDay, '2026-07-02').spending, 40);
  assert.equal(afterDelete.byDay.has('2026-07-02'), false); // the deleted day is gone from the recompute
  // With a window, mapTransactions emits an explicit 0 for the now-empty day so
  // a stale stored value can't survive (the replacement-state guarantee).
  const { metrics } = m.mapTransactions(
    [{ Date: '2026-07-01', Amount: '-100', Category: 'Groceries', Merchant: 'X', Account: 'A' }],
    { windowStart: '2026-07-01', windowEnd: '2026-07-02', today: TODAY }
  );
  const jul2 = metrics.find((x) => x.metric === 'spending' && x.ts.toISOString().startsWith('2026-07-02'));
  assert.equal(jul2.value, 0, 'the emptied day is written as an explicit 0');
});

test('6. transfers and credit-card payments are excluded from every flow', () => {
  const { byDay } = recon([
    { date: '2026-07-01', amount: -16000, category: 'Transfer' },
    { date: '2026-07-01', amount: -2164.22, category: 'Credit Card Payment' },
    { date: '2026-07-01', amount: 5000, category: 'Transfer' },
    { date: '2026-07-01', amount: -50, category: 'Groceries' },
  ]);
  const b = day(byDay, '2026-07-01');
  assert.equal(b.spending, 50);
  assert.equal(b.discretionary, 50);
  assert.equal(b.income, 0); // the incoming transfer is NOT income
});

test('7. pending / tomorrow-dated transactions are excluded on the LOCAL day boundary', () => {
  const { byDay } = recon([
    { date: '2026-07-12', amount: -30, category: 'Groceries' }, // today — counts
    { date: '2026-07-13', amount: -999, category: 'Groceries' }, // tomorrow (pending) — excluded
  ]);
  assert.equal(day(byDay, '2026-07-12').spending, 30);
  assert.equal(byDay.has('2026-07-13'), false);
});

test('8. repeated runs on the same input are idempotent (pure function)', () => {
  const txns = [
    { date: '2026-07-01', amount: -5695, category: 'Rent' },
    { date: '2026-07-01', amount: -120.5, category: 'Groceries' },
    { date: '2026-07-02', amount: 5000, category: 'Paychecks' },
  ];
  const a = recon(txns);
  const b = recon(txns);
  assert.deepEqual([...a.byDay.entries()], [...b.byDay.entries()]);
});

test('9. every path shares the calculation: mapTransactions produces identical flow values to the reconciler for identical input', () => {
  // Same logical transactions, no category_type (CSV/recompute shape), so both
  // entry points use the reconciler's name-heuristic income path.
  const records = [
    { Date: '2026-07-01', Amount: '-5695', Category: 'Rent', Merchant: 'Landlord', Account: 'Checking' },
    { Date: '2026-07-01', Amount: '-120.50', Category: 'Groceries', Merchant: 'WF', Account: 'Amex' },
    { Date: '2026-07-01', Amount: '30', Category: 'Groceries', Merchant: 'Refund', Account: 'Amex' },
    { Date: '2026-07-02', Amount: '5000', Category: 'Paycheck', Merchant: 'Employer', Account: 'Checking' },
  ];
  const normalized = records.map((r) => ({ date: r.Date, amount: Number(r.Amount), category: r.Category }));
  const direct = m.reconcileWealthFlows(normalized, { today: TODAY }); // no incomeCategoryNames -> name heuristic
  const { metrics } = m.mapTransactions(records, { today: TODAY });
  const get = (metric, d) => metrics.find((x) => x.metric === metric && x.ts.toISOString().startsWith(d))?.value ?? 0;
  for (const d of ['2026-07-01', '2026-07-02']) {
    const b = direct.byDay.get(d) || { spending: 0, discretionary: 0, income: 0, netCashflow: 0 };
    assert.equal(get('spending', d), b.spending, `spending ${d}`);
    assert.equal(get('spending_discretionary', d), b.discretionary, `discretionary ${d}`);
    assert.equal(get('income', d), b.income, `income ${d}`);
    assert.equal(get('net_cashflow', d), b.netCashflow, `net_cashflow ${d}`);
  }
});

test('10. MTD category totals reconcile exactly to total spending', () => {
  const txns = [
    { date: '2026-07-01', amount: -5695, category: 'Rent' },
    { date: '2026-07-02', amount: -120.5, category: 'Groceries' },
    { date: '2026-07-03', amount: -43.2, category: 'Dining' },
    { date: '2026-07-04', amount: 15, category: 'Groceries' }, // refund
    { date: '2026-07-05', amount: -2164.22, category: 'Credit Card Payment' }, // excluded
    { date: '2026-07-06', amount: 5000, category: 'Paychecks' }, // income
  ];
  const { byDay } = recon(txns);
  // Rebuild per-category net spend the same way, independently.
  const catNet = new Map();
  for (const t of txns) {
    const cls = m.classifyTransaction({ amount: t.amount, category: t.category, incomeCategoryNames: INCOME_CATS });
    if (cls !== 'expense') continue;
    catNet.set(t.category, (catNet.get(t.category) || 0) + -t.amount);
  }
  const categorySum = Math.round([...catNet.values()].reduce((a, v) => a + v, 0) * 100) / 100;
  const totalSpend = Math.round([...byDay.values()].reduce((a, b) => a + b.spending, 0) * 100) / 100;
  assert.equal(categorySum, totalSpend, 'sum of category net spend equals MTD total spending');
});

test('11. MTD discretionary equals total minus net fixed housing, to the cent, even with fixed-category refunds', () => {
  const txns = [
    { date: '2026-07-01', amount: -5695, category: 'Rent' },
    { date: '2026-07-02', amount: 200, category: 'Rent' }, // fixed-category credit
    { date: '2026-07-03', amount: -300, category: 'Groceries' },
    { date: '2026-07-04', amount: 45, category: 'Groceries' }, // discretionary refund
  ];
  const { byDay } = recon(txns);
  const totalSpend = Math.round([...byDay.values()].reduce((a, b) => a + b.spending, 0) * 100) / 100;
  const totalFixed = Math.round([...byDay.values()].reduce((a, b) => a + b.fixed, 0) * 100) / 100;
  const totalDisc = Math.round([...byDay.values()].reduce((a, b) => a + b.discretionary, 0) * 100) / 100;
  assert.equal(totalFixed, 5495); // 5695 - 200
  assert.equal(totalDisc, 255); // 300 - 45
  assert.equal(totalDisc, Math.round((totalSpend - totalFixed) * 100) / 100, 'discretionary === total - net fixed');
});
