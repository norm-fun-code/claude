import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const S = require('../public/spending.js');

// Monarch's own taxonomy: categories belong to groups, groups carry a type.
const CATS = [
  { id: '1', name: 'Groceries', group: { id: 'g1', name: 'Food', type: 'expense' } },
  { id: '2', name: 'Restaurants', group: { id: 'g1', name: 'Food', type: 'expense' } },
  { id: '3', name: 'Paycheck', group: { id: 'g2', name: 'Income', type: 'income' } },
  { id: '4', name: 'Transfer', systemCategory: 'transfer', group: { id: 'g3', name: 'Transfers', type: 'transfer' } },
  { id: '5', name: 'Credit Card Payment', systemCategory: 'credit_card_payment', group: { id: 'g3', name: 'Transfers', type: 'transfer' } },
  { id: '6', name: 'Investment Contribution', group: { id: 'g3', name: 'Transfers', type: 'transfer' } },
  { id: '7', name: 'Mortgage', group: { id: 'g4', name: 'Housing', type: 'expense' } },
];
const tx = (o) => ({ id: 'x', date: '2026-03-05', amount: -100, categoryId: '1', accountId: 'a1', ...o });
const cats = S.indexCategories(CATS);
const kindOf = (o) => S.classify(tx(o), cats);

// ── The three ways a household ledger double-counts ──────────────────────
describe('double counting', () => {
  it('an internal transfer is not spending', () => {
    expect(kindOf({ categoryId: '4', amount: -5000 })).toBe(S.KIND.TRANSFER);
    expect(kindOf({ categoryId: '4', amount: 5000 })).toBe(S.KIND.TRANSFER); // both legs
  });

  it('a credit-card payment is not spending — the purchases it settles are', () => {
    expect(kindOf({ categoryId: '5', amount: -3200 })).toBe(S.KIND.CARD_PAYMENT);
    // …while a purchase ON the card is a real expense
    expect(kindOf({ categoryId: '1', accountId: 'card1', amount: -140 })).toBe(S.KIND.EXPENSE);
  });

  it('paying the card and buying on it does not count the money twice', () => {
    const { totals } = S.summarize([
      tx({ id: 'p1', categoryId: '1', accountId: 'card1', amount: -140 }),
      tx({ id: 'p2', categoryId: '2', accountId: 'card1', amount: -60 }),
      tx({ id: 'pay', categoryId: '5', accountId: 'chk', amount: -200 }), // settles both
    ], CATS);
    expect(totals.expense).toBe(200);     // the purchases, once
    expect(totals.cardPayment).toBe(200); // tracked, but not as spending
  });

  it('a split parent is excluded so its children are not counted twice', () => {
    const { totals } = S.summarize([
      tx({ id: 'parent', amount: -300, isSplitTransaction: true }),
      tx({ id: 'c1', amount: -100 }), tx({ id: 'c2', amount: -200 }),
    ], CATS);
    expect(totals.expense).toBe(300);
  });

  it('respects hideFromReports', () => {
    expect(kindOf({ hideFromReports: true })).toBe(S.KIND.EXCLUDED);
    expect(S.summarize([tx({ hideFromReports: true })], CATS).totals.expense).toBe(0);
  });

  it('every transaction lands in exactly one bucket, so buckets reconcile to the ledger', () => {
    const rows = [
      tx({ id: 'a', categoryId: '1', amount: -100 }), tx({ id: 'b', categoryId: '3', amount: 5000 }),
      tx({ id: 'c', categoryId: '4', amount: -900 }), tx({ id: 'd', categoryId: '5', amount: -300 }),
      tx({ id: 'e', categoryId: '6', amount: -1000 }), tx({ id: 'f', categoryId: '1', amount: 25 }),
      tx({ id: 'g', hideFromReports: true, amount: -50 }),
    ];
    const { counts } = S.summarize(rows, CATS);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(rows.length);
  });
});

// ── Refunds ──────────────────────────────────────────────────────────────
describe('refunds and reimbursements', () => {
  it('money back in an expense category is a refund, not income', () => {
    expect(kindOf({ categoryId: '1', amount: 40 })).toBe(S.KIND.REFUND);
  });

  it('a refund nets down its own category rather than inflating income', () => {
    const { months, totals } = S.summarize([
      tx({ id: 'buy', categoryId: '1', amount: -200 }),
      tx({ id: 'ret', categoryId: '1', amount: 50 }),
    ], CATS);
    const g = months[0].categories.find(c => c.name === 'Groceries');
    expect(g.net).toBe(150);      // what was actually spent
    expect(g.gross).toBe(200);    // …with the purchase still visible
    expect(g.refunds).toBe(50);
    expect(totals.income).toBe(0); // and nothing leaked into income
    expect(totals.expense).toBe(150);
  });

  it('a full return zeroes the category without going negative on income', () => {
    const { months, totals } = S.summarize([
      tx({ id: 'buy', amount: -200 }), tx({ id: 'ret', amount: 200 }),
    ], CATS);
    expect(months[0].categories[0].net).toBe(0);
    expect(totals.income).toBe(0);
  });
});

// ── Investment vs. transfer vs. expense ──────────────────────────────────
describe('investment activity is separated from consumption', () => {
  it('a brokerage contribution is investment, not a transfer and not spending', () => {
    expect(kindOf({ categoryId: '6', amount: -2000 })).toBe(S.KIND.INVESTMENT);
    const { totals } = S.summarize([tx({ categoryId: '6', amount: -2000 })], CATS);
    expect(totals.investment).toBe(2000);
    expect(totals.expense).toBe(0);
    expect(totals.transfer).toBe(0);
  });

  it('an account flagged as investment classifies even when the category does not say so', () => {
    const k = S.classify(tx({ categoryId: '4', accountId: 'brk1', amount: -2000 }), cats,
      { investmentAccountIds: new Set(['brk1']) });
    expect(k).toBe(S.KIND.INVESTMENT);
  });
});

// ── Loan principal vs interest ───────────────────────────────────────────
describe('loan payments', () => {
  it('splits interest from principal while keeping the whole payment as a commitment', () => {
    const { months } = S.summarize([tx({ categoryId: '7', accountId: 'mtg', amount: -5000 })], CATS,
      { loanSplits: { mtg: { interestShare: 0.7 } } });
    expect(months[0].interest).toBeCloseTo(3500, 6);
    expect(months[0].principal).toBeCloseTo(1500, 6);
    expect(months[0].expense).toBe(5000); // full payment still a cash commitment
  });

  it('leaves the split alone when none is supplied rather than guessing', () => {
    const { months } = S.summarize([tx({ categoryId: '7', accountId: 'mtg', amount: -5000 })], CATS);
    expect(months[0].interest).toBe(0);
    expect(months[0].principal).toBe(0);
    expect(months[0].expense).toBe(5000);
  });
});

// ── User overrides ───────────────────────────────────────────────────────
describe('user categorisation overrides', () => {
  it('a user override beats the provider taxonomy', () => {
    expect(kindOf({ categoryId: '4', userKind: S.KIND.EXPENSE })).toBe(S.KIND.EXPENSE);
    expect(kindOf({ categoryId: '1', userKind: S.KIND.TRANSFER })).toBe(S.KIND.TRANSFER);
  });

  it('ignores an override that is not a real kind', () => {
    expect(kindOf({ categoryId: '1', userKind: 'nonsense' })).toBe(S.KIND.EXPENSE);
  });
});

// ── Coverage and averages ────────────────────────────────────────────────
describe('coverage and rolling averages', () => {
  const months = (n, start = 1) => Array.from({ length: n }, (_, i) => ({
    coverageVerified:true, month: `2026-${String(start + i).padStart(2, '0')}`, expense: 1000 + i * 100,
  }));

  it('marks the month in progress as partial and excludes it from complete months', () => {
    const c = S.coverage(months(3), '2026-03-10');
    expect(c.partial).toBe('2026-03');
    expect(c.completeMonths).toEqual(['2026-01', '2026-02']);
    expect(c.fractionElapsed).toBeCloseTo(10 / 31, 3);
  });

  it('refuses to compute an average over a window it does not cover', () => {
    expect(S.rollingAverage(months(4), 12, null, '2026-04-10')).toBeNull();
    expect(S.rollingAverage(months(4), 6, null, '2026-04-10')).toBeNull();
  });

  it('averages only complete months once the window is covered', () => {
    // 6 complete months (Jan–Jun) plus a partial July
    const m = months(7);
    const avg = S.rollingAverage(m, 6, null, '2026-07-10');
    expect(avg).toBe((1000 + 1100 + 1200 + 1300 + 1400 + 1500) / 6);
    expect(avg).not.toBe(m.reduce((s, x) => s + x.expense, 0) / 7); // partial month left out
  });

  it('reports no coverage for an empty ledger instead of zero', () => {
    expect(S.coverage([]).monthsCovered).toBe(0);
    expect(S.coverage([]).first).toBeNull();
  });
});

// ── Budgets ──────────────────────────────────────────────────────────────
describe('budget comparison', () => {
  const month = S.summarize([
    tx({ id: 'a', categoryId: '1', amount: -700 }),
    tx({ id: 'b', categoryId: '2', amount: -300 }),
    tx({ id: 'c', categoryId: '7', amount: -4000 }),
  ], CATS).months[0];
  const budgets = [{ categoryId: '1', planned: 600 }, { categoryId: '2', planned: 500 }];

  it('compares actual against plan and ranks by overage', () => {
    const s = S.budgetStatus(month, budgets);
    expect(s.rows[0].categoryId).toBe('1');
    expect(s.rows[0].actual).toBe(700);
    expect(s.rows[0].overBy).toBe(100);
    expect(s.rows[1].overBy).toBe(-200); // Restaurants under
  });

  it('pro-rates the plan for a month still in progress', () => {
    const s = S.budgetStatus(month, budgets, { fractionElapsed: 0.5 });
    expect(s.rows.find(r => r.categoryId === '1').expected).toBe(300);
    // …so a category tracking exactly on plan is not flagged mid-month
    const onPlan = S.budgetStatus(
      S.summarize([tx({ categoryId: '1', amount: -300 })], CATS).months[0],
      [{ categoryId: '1', planned: 600 }], { fractionElapsed: 0.5 });
    expect(onPlan.rows[0].overBy).toBe(0);
  });

  it('surfaces spending in categories with no budget rather than hiding it', () => {
    const s = S.budgetStatus(month, budgets);
    expect(s.unbudgeted.map(c => c.name)).toContain('Mortgage');
    expect(s.actualTotal).toBe(700 + 300 + 4000); // unbudgeted included in the total
  });
});

// ── Month bucketing ──────────────────────────────────────────────────────
describe('month bucketing', () => {
  it('groups by calendar month and keeps them ordered', () => {
    const { months } = S.summarize([
      tx({ id: 'a', date: '2026-02-27', amount: -100 }),
      tx({ id: 'b', date: '2026-01-15', amount: -200 }),
      tx({ id: 'c', date: '2026-02-01', amount: -300 }),
    ], CATS);
    expect(months.map(m => m.month)).toEqual(['2026-01', '2026-02']);
    expect(months[1].expense).toBe(400);
  });

  it('counts pending rows separately so a month can be labelled unsettled', () => {
    const { months } = S.summarize([
      tx({ id: 'a', amount: -100, pending: true }), tx({ id: 'b', amount: -100 }),
    ], CATS);
    expect(months[0].pending).toBe(1);
    expect(months[0].count).toBe(2);
  });
});

// ── Destination-based investment detection ───────────────────────────────
describe('money arriving in a non-cash account is saving', () => {
  const classes = { brk: 'taxable', ret: 'retirement', chk: 'cash', card: 'debt', priv: 'private' };
  const opts = { accountClasses: classes };

  it('counts an inflow to a brokerage as investment even when filed as a plain Transfer', () => {
    // The real case: Monarch categorises the contribution as "Transfer", so a name rule
    // misses it entirely and it disappears into the transfer bucket.
    expect(S.classify(tx({ categoryId: '4', accountId: 'brk', amount: 4000 }), cats, opts)).toBe(S.KIND.INVESTMENT);
    expect(S.classify(tx({ categoryId: '4', accountId: 'ret', amount: 2000 }), cats, opts)).toBe(S.KIND.INVESTMENT);
    expect(S.classify(tx({ categoryId: '4', accountId: 'priv', amount: 9000 }), cats, opts)).toBe(S.KIND.INVESTMENT);
  });

  it('does not count the matching outflow, so the dollars are not recorded twice', () => {
    const { totals } = S.summarize([
      tx({ id: 'out', categoryId: '4', accountId: 'chk', amount: -4000 }), // leaves checking
      tx({ id: 'in', categoryId: '4', accountId: 'brk', amount: 4000 }),   // lands in brokerage
    ], CATS, opts);
    expect(totals.investment).toBe(4000);   // counted once
    expect(totals.transfer).toBe(4000);     // the cash leg, still not spending
    expect(totals.expense).toBe(0);
  });

  it('leaves an inflow to a cash account as a transfer, not saving', () => {
    expect(S.classify(tx({ categoryId: '4', accountId: 'chk', amount: 4000 }), cats, opts)).toBe(S.KIND.TRANSFER);
  });

  it('does not treat a card payment as investment just because the card is non-cash', () => {
    expect(S.classify(tx({ categoryId: '5', accountId: 'card', amount: 3000 }), cats, opts)).toBe(S.KIND.CARD_PAYMENT);
  });

  it('falls back to name matching when no account classes are supplied', () => {
    expect(S.classify(tx({ categoryId: '6', accountId: 'brk', amount: -2000 }), cats, {})).toBe(S.KIND.INVESTMENT);
    expect(S.classify(tx({ categoryId: '4', accountId: 'brk', amount: 4000 }), cats, {})).toBe(S.KIND.TRANSFER);
  });

  it('still lets a user override win', () => {
    expect(S.classify(tx({ categoryId: '4', accountId: 'brk', amount: 4000, userKind: S.KIND.TRANSFER }), cats, opts))
      .toBe(S.KIND.TRANSFER);
  });
});

describe('averages from imported records',()=>{
  it('shows an observed average without declaring history verified',()=>{
    const months=['2026-06','2026-07','2026-08','2026-09'].map((month,i)=>({month,expense:100+i*100}));
    expect(S.observedAverage(months,3,'2026-09-10')).toBe(200);
    expect(S.coverage(months,'2026-09-10').completeMonths).toEqual([]);
    expect(S.rollingAverage(months,3,null,'2026-09-10')).toBe(null);
  });
  it('leaves an observed average unavailable for a missing calendar month',()=>{
    expect(S.observedAverage([{month:'2026-06',expense:100},{month:'2026-08',expense:200}],3,'2026-09-10')).toBe(null);
  });
});
