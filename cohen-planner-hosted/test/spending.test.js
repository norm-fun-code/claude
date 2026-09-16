import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import vm from 'node:vm';
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
const kindOf = (o, opts) => S.classify(tx(o), cats, opts);

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

  it('a split parent is excluded when the children really are present', () => {
    // Counting both is the hazard this rule exists for — but only a caller that holds the
    // children can know, so it says so rather than the classifier assuming it.
    const { totals } = S.summarize([
      tx({ id: 'parent', amount: -300, isSplitTransaction: true }),
      tx({ id: 'c1', amount: -100 }), tx({ id: 'c2', amount: -200 }),
    ], CATS, { hasSplitChildren: true });
    expect(totals.expense).toBe(300);
    expect(totals.splitParents).toBe(300);   // reported, never silently removed
  });

  it('counts a split parent when its children are NOT in the feed', () => {
    // The NormOS bridge delivers parents only. Dropping them lost $5,695 of rent in silence,
    // showing up as one category short against Monarch and no line saying why.
    const { totals } = S.summarize([
      tx({ id: 'parent', amount: -5695.03, isSplitTransaction: true }),
      tx({ id: 'other', amount: -37494 }),
    ], CATS);
    expect(totals.expense).toBeCloseTo(43189.03, 2);
    expect(totals.splitParents).toBe(0);
  });

  it('separates what Monarch hid from what we set aside ourselves', () => {
    // One is the provider's decision and one is ours; lumping them made ours invisible.
    expect(kindOf({ hideFromReports: true })).toBe(S.KIND.HIDDEN);
    expect(kindOf({ isSplitTransaction: true }, { hasSplitChildren: true })).toBe(S.KIND.SPLIT_PARENT);
    const t = S.summarize([tx({ hideFromReports: true })], CATS).totals;
    expect(t.expense).toBe(0);
    expect(t.hidden).toBe(t.excluded);
    expect(t.splitParents).toBe(0);
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

// ── The period the category breakdown answers for ────────────────────────
// "Where does my money go" has a period attached to it, and twelve months and last March are
// different questions. The filter has to re-aggregate, not relabel.
describe('the spending scope filter', () => {
  const src = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const ctx = () => {
    const c = { _spendScope: { kind: 'all' } };
    vm.createContext(c);
    vm.runInContext(src.slice(src.indexOf('function spendCurrentYear'), src.indexOf('function setSpendScope(')), c);
    vm.runInContext(src.slice(src.indexOf('function monthLabel'), src.indexOf('\n\nfunction renderSpendingTab')), c);
    return c;
  };
  const all = Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}` }));
  // Two calendar years: all of 2025, then January–August 2026 closed.
  const twoYears = [...Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(i + 1).padStart(2, '0')}` })),
    ...Array.from({ length: 8 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}` }))];

  it('narrows to a rolling window, taking the most recent months', () => {
    const c = ctx();
    c._spendScope = { kind: 'recent', months: 3 };
    expect(c.spendScopeMonths(all).map(m => m.month)).toEqual(['2026-10', '2026-11', '2026-12']);
  });

  it('narrows to one named month', () => {
    const c = ctx();
    c._spendScope = { kind: 'month', month: '2026-07' };
    expect(c.spendScopeMonths(all).map(m => m.month)).toEqual(['2026-07']);
  });

  it('falls back to everything when the chosen month has left the loaded history', () => {
    // An empty donut reads as a month with no spending, which is a different claim entirely.
    const c = ctx();
    c._spendScope = { kind: 'month', month: '2019-01' };
    expect(c.spendScopeMonths(all)).toHaveLength(12);
  });

  it('defaults to every complete month, so the figure nobody changed does not move', () => {
    expect(ctx().spendScopeMonths(all)).toHaveLength(12);
  });

  it('cannot ask for more months than exist, or fewer than one', () => {
    const c = ctx();
    c._spendScope = { kind: 'recent', months: 999 };
    expect(c.spendScopeMonths(all)).toHaveLength(12);
    c._spendScope = { kind: 'recent', months: 0 };
    expect(c.spendScopeMonths(all)).toHaveLength(1);
  });

  it('survives an empty history without throwing', () => {
    const c = ctx();
    for (const scope of [{ kind: 'all' }, { kind: 'recent', months: 3 }, { kind: 'month', month: '2026-01' }]) {
      c._spendScope = scope;
      expect(c.spendScopeMonths([])).toEqual([]);
      expect(c.spendScopeMonths(undefined)).toEqual([]);
    }
  });

  it('takes the year to date from the OBSERVATION date, not the last closed month', () => {
    // In January the most recent closed month is December of the year before. Reading the
    // current year off that would quietly report last year under a "YTD" label.
    const c = ctx();
    c._spendScope = { kind: 'ytd' };
    expect(c.spendScopeMonths(twoYears, '2026-09-16').map(m => m.month))
      .toEqual(['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08']);
    // Standing in January 2027, with nothing closed in 2027 yet.
    expect(c.spendScopeMonths(twoYears, '2027-01-09')).toHaveLength(twoYears.length);
  });

  it('narrows to one named year, including a year that has fully closed', () => {
    const c = ctx();
    c._spendScope = { kind: 'year', year: '2025' };
    const got = c.spendScopeMonths(twoYears, '2026-09-16');
    expect(got).toHaveLength(12);
    expect(got.every(m => m.month.startsWith('2025-'))).toBe(true);
  });

  it('falls back to everything for a year with no records, never an empty donut', () => {
    const c = ctx();
    c._spendScope = { kind: 'year', year: '2019' };
    expect(c.spendScopeMonths(twoYears, '2026-09-16')).toHaveLength(twoYears.length);
  });

  it('says which year and how much of it, so YTD is not mistaken for a full year', () => {
    const c = ctx();
    c._spendScope = { kind: 'ytd' };
    expect(c.spendScopeLabel(twoYears, '2026-09-16')).toBe('2026 so far — 8 closed months');
    c._spendScope = { kind: 'year', year: '2025' };
    expect(c.spendScopeLabel(twoYears, '2026-09-16')).toBe('2025');
  });

  it('routes one dropdown to the right scope', () => {
    // Years and months share a control, so `year:2025` and `month:2025-03` arrive together.
    const src2 = src.slice(src.indexOf('function setSpendScopeFromSelect'), src.indexOf('function setSpendScopeFromSelect') + 400);
    expect(src2).toContain("String(v||'').split(':')");
    expect(src2).toContain("if(!kind)return setSpendScope('all')");
  });

  it('does not offer the current year beside YTD, which would be the same set', () => {
    expect(src).toContain(".filter(y=>y!==thisYear).sort().reverse()");
  });

  it('writes a month the way a person does', () => {
    const c = ctx();
    expect(c.monthLabel('2026-01')).toBe('January 2026');
    expect(c.monthLabel('2026-12')).toBe('December 2026');
    // …and hands back anything unparseable untouched rather than inventing a date.
    for (const junk of ['', null, 'nonsense', '2026']) expect(c.monthLabel(junk)).toBe(String(junk ?? ''));
  });

  it('labels the trend axis with the same formatter, not the raw key', () => {
    const cockpit = fs.readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');
    expect(cockpit).toContain('labels:months.map(m=>monthLabel(m.month)+');
    expect(cockpit).not.toContain('labels:months.map(m=>m.month+');
  });
});

// ── What the filter must NOT change ──────────────────────────────────────
// Scoping the donut silently rescoped two things beside it that describe the whole imported
// history, producing a line that contradicted itself and a trend built from nothing.
describe('the scope filter leaves the history summary alone', () => {
  const src = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  it('counts the imported months, not the scoped ones, in the coverage line', () => {
    // "8 past months with records · 20 verified full months" — both true, together nonsense.
    expect(src).toContain('${completeAll.length} past month${completeAll.length===1?\'\':\'s\'} with records · ${verifiedCount} verified full months');
  });

  it('claims a trend only when the CHOSEN period holds enough months for one', () => {
    // A one-month scope leaves `prior` empty, so every category reads as risen from zero.
    // It counts the CLOSED months in the scope: year-to-date now carries the month in
    // progress, and a fortnight of it standing in for a month would tilt both sides.
    expect(src).toContain('const canTrend=closedScoped.length>=6&&');
    expect(src).toContain('const recent=closedScoped.slice(-3),prior=closedScoped.slice(-6,-3);');
  });
});

// ── Year to date means to date ───────────────────────────────────────────
describe('the year-to-date scope', () => {
  const src = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  it('reads from the full history, so the month in progress is in it', () => {
    expect(src).toContain('const complete=spendScopeMonths(completeAll,asOf,months);');
    expect(src).toContain('const src=(every&&every.length?every:rows);');
  });

  it('says which of the two is happening, from the scope rather than its name', () => {
    // "current month excluded" is true whenever the partial month is out of range — including
    // when year-to-date falls back for want of records this year — and false when it is in.
    expect(src).toContain("${partialInScope?' · per-month figures divide by months elapsed':(cov.partial&&!['month','year'].includes(_spendScope.kind))?' · current month excluded':''}");
  });

  it('divides per-month figures by months ELAPSED, not months listed', () => {
    // 53% of September counted as a whole month would report the run rate about half again
    // too low — the one way including the partial month could mislead.
    expect(src).toContain('const n=(closedScoped.length+(partialInScope?(Number(cov.fractionElapsed)||1):0))||1;');
  });

  it('offers the chip even before a month of the year has closed', () => {
    expect(src).toContain("const hasYtd=closedThisYear>0||months.some(m=>String(m.month).slice(0,4)===thisYear);");
    expect(src).toContain("${hasYtd?scopeChip('ytd',null,'YTD',_spendScope.kind==='ytd'):''}");
  });

  it('is what the breakdown opens on', () => {
    expect(src).toContain("let _spendScope={kind:'ytd'};");
  });

  it('lights All instead when there is no year to date to show', () => {
    // The scope itself falls back to everything; leaving no chip pressed would make the
    // default look like a filter nobody chose.
    expect(src).toContain("scopeChip('all',null,'All',_spendScope.kind==='all'||(!hasYtd&&_spendScope.kind==='ytd'))");
  });
});

// ── The trailing twelve months, laid over the months ─────────────────────
// Monthly bars are noisy — one holiday, one insurance renewal, one quarter of tuition — and
// the shape of the year disappears into them. The trailing line separates the month from the
// trend, but only where it can honestly be computed.
describe('the rolling LTM series', () => {
  const run = (n, fn) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2025, i, 1));
    return { month: d.toISOString().slice(0, 7), ...fn(i) };
  });

  it('says nothing until a full window exists', () => {
    const rows = run(14, () => ({ income: 40000, expense: 5000 }));
    const out = S.rollingSeries(rows, 12);
    expect(out.slice(0, 11).every(x => x === null)).toBe(true);
    expect(out[11]).toMatchObject({ month: '2025-12', income: 40000, expense: 5000 });
  });

  it('reports a per-month average, so it shares the axis with the bars', () => {
    // A twelve-month TOTAL is twelve times taller and needs a second axis — and a second axis
    // is the easiest way to make two series look related when they are not.
    const rows = run(12, () => ({ income: 12000, expense: 1200 }));
    expect(S.rollingSeries(rows, 12)[11]).toMatchObject({ income: 12000, expense: 1200 });
  });

  it('shows drift the bars hide', () => {
    // Spending steps up halfway and stays there: every bar after the step is identical, while
    // the line climbs as the cheaper months fall out of the window. That climb is the signal.
    const rows = run(18, i => ({ income: 40000, expense: i < 12 ? 5000 : 8000 }));
    const out = S.rollingSeries(rows, 12).filter(Boolean).map(x => Math.round(x.expense));
    expect(out[0]).toBe(5000);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
  });

  it('breaks across a gap rather than averaging eleven months as twelve', () => {
    // A missing record would otherwise read as a fall in spending that never happened.
    const rows = run(15, () => ({ income: 40000, expense: 5000 }));
    rows.splice(5, 1);                       // 2025-06 never imported
    const out = S.rollingSeries(rows, 12);
    expect(out.every(x => x === null)).toBe(true);
  });

  it('gives an incomplete month no window of its own, and excludes it from others', () => {
    // Including a month two-thirds through would drag the line down for a month that has
    // simply not finished.
    const rows = run(14, () => ({ income: 40000, expense: 5000 }));
    const partial = rows[13].month;
    const out = S.rollingSeries(rows, 12, { skip: [partial] });
    expect(out[13]).toBeNull();
    expect(out[12]).not.toBeNull();          // the month before still has its own full window
  });

  it('survives an empty or unusable history without throwing', () => {
    for (const rows of [[], null, undefined]) expect(S.rollingSeries(rows, 12)).toEqual([]);
    expect(S.rollingSeries(run(3, () => ({})), 12).every(x => x === null)).toBe(true);
  });

  it('is a chart of its own, not lines laid over the monthly bars', () => {
    const cockpit = fs.readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(cockpit).toContain("PlannerSpending.rollingSeries(months,12,{skip:[asOf.slice(0,7)]})");
    expect(cockpit).toContain("document.getElementById('spendLtmChart')");
    expect(cockpit).toContain('charts.spendingLtm=new Chart');
    expect(html).toContain('id="spendLtmChart"');
    // The bar chart carries the two bars and nothing else — the whole point of splitting.
    const barChart = cockpit.slice(cockpit.indexOf('charts.spendingMonths='), cockpit.indexOf('const ltmCanvas'));
    expect(barChart).toContain("type:'bar'");
    expect(barChart).not.toMatch(/12-month average/);
  });

  it('puts the last twelve closed months on the axis, with no control over it', () => {
    // One fixed, obvious period, like the bars next door — so the shape means the same thing
    // every time it is looked at, and nothing has to be chosen first.
    const cockpit = fs.readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');
    expect(cockpit).toContain("const closed=months.filter(m=>m.month!==asOf.slice(0,7));");
    expect(cockpit).toContain('const from=Math.max(0,closed.length-12);');
    expect(cockpit).toContain('closed.slice(from).map(m=>ltm[months.indexOf(m)]||null)');
    // Nothing to draw is said in words, not shown as a flat line at zero.
    expect(cockpit).toContain('spendLtmNote');
  });

  it('offers twelve months as a period once twelve exist, not only once thirteen do', () => {
    const src = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(src).toContain('const ranges=[3,6,12].filter(n=>n<=completeAll.length);');
  });
});

// ── One point is not a line ──────────────────────────────────────────────
// A trailing twelve-month average over twelve months of records is exactly one window. Chart.js
// draws a lone point with pointRadius 0 as nothing at all: an empty grid with one tick on it,
// which reads as a chart that is broken rather than a history that is short.
describe('the drift chart when the history is too short to drift', () => {
  const src = fs.readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  it('says so in words when there is no window at all, rather than drawing an empty grid', () => {
    expect(src).toContain('const points=series.filter(Boolean).length;');
    // Named `series`, not `window`: a local `window` shadows the global one and puts the
    // `window.PlannerSpending` read three lines above it in the temporal dead zone.
    expect(src).not.toMatch(/\bconst window=/);
    expect(src).toContain('if(!points){');
    expect(src).toMatch(/Twelve consecutive months of records are needed/);
  });

  it('marks a point that has no neighbour to join, rather than drawing a zero-length line', () => {
    expect(src).toContain("pointRadius:c=>{const d=c.dataset.data,i=c.dataIndex;");
    expect(src).toContain('d[i]!=null&&d[i-1]==null&&d[i+1]==null?3.5:0');
  });

  it('loads enough history for there to be a second window at all', () => {
    // Twelve months of summary can only ever hold one twelve-month window — the chart was
    // empty by arithmetic, whatever it drew.
    expect(html).toContain("fetch('/api/monarch/spending?months=36')");
    expect(html).not.toContain("fetch('/api/monarch/spending?months=12')");
  });
});
