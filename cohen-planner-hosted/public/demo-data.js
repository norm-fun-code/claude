'use strict';
// ═══ DEMO DATA ═══
// One fictional household, shared by the server (which rewrites the shared /demo page) and the
// browser (which fills every screen in Demo Mode). Pure: no DOM, no network, and the engines it
// runs are passed in, so the same code is exercised by the tests.
//
// Two rules shape everything here.
//
// NOTHING IS TYPED IN THAT AN ENGINE COULD COMPUTE. The accounts, a year of transactions and the
// holdings are invented; the summaries, the spending pace, the watchlist and the tax screen are
// the app's own engines run over them. A hand-written "3 alerts" panel would demo a mock-up. This
// demos the product.
//
// NOTHING REAL SURVIVES. The page's default plan holds real figures as fallbacks, so every money
// value in it is replaced — explicitly where the demo should look deliberate, by a coarse
// rounding otherwise. And the owner's own Demo Mode button runs through the same function: it
// used to start from the unscrubbed defaults and override a dozen keys, which left every other
// budget line showing the real household while presenting.

(function (root) {

  // ── The default plan, with every money figure replaced ───────────────────
  const DEMO_OVERRIDES = {
    startingLiquid: 725000, k401Start: 285000, liquidReserveFloor: 150000,
    homePrice: 1850000, nycRent: 4800, propTaxBase: 16000, maintBase: 9000,
    // Every year of pay set explicitly, rising smoothly. Left to the scrub, years four onward
    // came out at about two thirds of year three — a pay cut off a cliff that turned the demo
    // household into one drawing on savings for thirty years.
    normCashY0: 240000, normCashY1: 252000, normCashY2: 265000, normCashY3: 275000,
    normCashY4: 285000, normCashY5: 295000, normCashY6: 305000, normCashY7: 315000,
    normCashY8: 325000, normCashY9: 335000, normCashY10: 345000,
    normStockY0: 115000, normStockY1: 125000, normStockY2: 130000, normStockY3: 135000,
    normStockY4: 140000, normStockY5: 145000, normStockY6: 152000, normStockY7: 157000,
    normStockY8: 160000, normStockY9: 165000, normStockY10: 170000,
    nancyW2Y0: 105000, nancyW2Y1: 112000, nancyW2Y2: 118000, nancyW2Y3: 124000,
    nancyPracticeOverhead: 12000, nancyHomeOfficeDeduct: 6000,
    pretax401k: 19000, pretaxBenefits: 9000, company401kMatch: 7000,
    baseGroceries: 9600, baseDining: 10800, baseShopping: 15000, baseVacations: 12000,
    baseMisc: 8400, baseCharity: 6000, baseMedical: 3600, baseTransit: 3600,
    baseUtilsPhoneNet: 4800, baseEntertainment: 4200, baseAuto: 4800,
    postKidVacations: 9000, suburbAutoBoost: 4200,
  };
  // Money is anything over $3,000; below that the defaults are ages, rates, counts and years.
  const MONEY_FLOOR = 3000;

  // Two significant figures of a shifted value: recognisably a household, recognisably not this
  // one, and not a constant multiple of anything — so no ratio survives to be inverted.
  function demoScrub(v) {
    const n = Math.abs(v) * 0.63 + 1500;
    const mag = Math.pow(10, Math.max(0, String(Math.round(n)).length - 2));
    return Math.sign(v) * Math.round(n / mag) * mag;
  }

  function demoDefaults(D) {
    const out = {};
    for (const [k, v] of Object.entries(D || {})) {
      out[k] = Object.prototype.hasOwnProperty.call(DEMO_OVERRIDES, k) ? DEMO_OVERRIDES[k]
        : (typeof v === 'number' && Math.abs(v) > MONEY_FLOOR) ? demoScrub(v)
        : v;
    }
    return out;
  }

  // Everything that is not money but still has to be about THIS household rather than the real
  // one: dates relative to now, the family's shape, the equity already held.
  function demoShape(year) {
    return {
      planStartYear: year, observedOn: null,
      startingStripeEquity: 210000, otherDebt: 8400,
      homePurchaseYear: year + 3,
      numKids: 2, kid1Birth: year + 1, kid2Birth: year + 4,
    };
  }

  // ── A deterministic generator ────────────────────────────────────────────
  // Seeded, so a friend who refreshes sees the same household. Random numbers that changed on
  // every load would read as a broken app, not a demo.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Accounts ─────────────────────────────────────────────────────────────
  // They reconcile to the plan's own opening on purpose: cash + brokerage = starting liquid,
  // the equity line = starting Stripe, the 401(k) = the retirement start. A demo whose cockpit
  // opened on "the plan compounds $40K less than you hold" would be demoing a data problem.
  function demoAccounts(P, asOf) {
    const liquid = Number(P.startingLiquid) || 0;
    const checking = 42000, savings = 168000;
    const at = asOf || new Date().toISOString();
    const acct = (id, name, institution, category, subtype, balance) =>
      ({ id, name, displayName: name, institution, category, subtype, balance, asOf: at });
    return [
      acct('demo-chk', 'Everyday checking', 'Demo Bank', 'depository', 'checking', checking),
      acct('demo-sav', 'High-yield savings', 'Demo Bank', 'depository', 'savings', savings),
      acct('demo-brk', 'Brokerage account', 'Demo Investments', 'investment', 'brokerage', liquid - checking - savings),
      acct('demo-401', '401(k)', 'Demo Retirement', 'investment', '401k', Number(P.k401Start) || 0),
      acct('demo-eq', 'Stripe shares (vested)', 'Carta', 'other_asset', 'private equity', Number(P.startingStripeEquity) || 0),
      acct('demo-card', 'Sapphire card', 'Demo Bank', 'credit', 'credit_card', -Math.abs(Number(P.otherDebt) || 0)),
    ];
  }

  function demoHoldings(total, asOf) {
    const split = [
      ['VTI', 'US Total Market', 'etf', 0.55, 4.3],
      ['VXUS', 'International Index', 'etf', 0.20, 2.0],
      ['BND', 'Bond Index', 'etf', 0.17, 1.1],
      ['SPAXX', 'Money Market', 'cash', 0.08, 0],
    ];
    let left = total;
    const holdings = split.map(([ticker, name, securityType, share, pct], i) => {
      const value = i === split.length - 1 ? left : Math.round(total * share / 1000) * 1000;
      left -= value;
      return { ticker, name, securityType, value, periodChangePct: pct,
        periodChange: Math.round(value * pct / 100) };
    });
    const periodChange = holdings.reduce((s, h) => s + h.periodChange, 0);
    return { totalValue: total, periodMetric: 'growth', periodChange,
      periodChangePct: +(periodChange / Math.max(1, total - periodChange) * 100).toFixed(2),
      allTimeChange: Math.round(total * 0.19), allTimePct: 23.5, asOf: asOf || new Date().toISOString(),
      holdings, topGainers: [], topLosers: [] };
  }

  // ── A year of transactions, and the month in progress ────────────────────
  // Shaped like a real ledger, including what the spending engine has to see past: transfers to
  // the brokerage, card payments, paychecks. The month in progress carries one new, large
  // purchase so the pace card has something true to say about what is driving it.
  const CATEGORIES = [
    ['c-rent', 'Rent', 'expense'], ['c-groc', 'Groceries', 'expense'],
    ['c-rest', 'Restaurants & Bars', 'expense'], ['c-shop', 'Shopping', 'expense'],
    ['c-trav', 'Travel & Vacation', 'expense'], ['c-util', 'Utilities', 'expense'],
    ['c-ent', 'Entertainment', 'expense'], ['c-char', 'Charity', 'expense'],
    ['c-med', 'Medical', 'expense'], ['c-pay', 'Paychecks', 'income'],
    ['c-xfer', 'Transfer', 'transfer', 'transfer'],
    ['c-inv', 'Investment Contribution', 'transfer'],
    ['c-card', 'Credit Card Payment', 'transfer', 'credit_card_payment'],
  ].map(([id, name, type, systemCategory]) =>
    ({ id, name, systemCategory: systemCategory || null, group: { id: 'g-' + type, name: type, type } }));

  function demoLedger(today, P) {
    const end = new Date((today || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
    const rand = rng(20260923);
    const pick = a => a[Math.floor(rand() * a.length)];
    const between = (lo, hi) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;
    const rent = Number(P && P.nycRent) || 4800;
    const out = [];
    let n = 0;
    const tx = (date, amount, categoryId, merchant, accountId) =>
      out.push({ id: 'demo-t' + (++n), date, amount, categoryId, merchant, accountId: accountId || 'demo-card' });

    for (let back = 12; back >= 0; back--) {
      const first = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - back, 1));
      const ym = first.toISOString().slice(0, 7);
      const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      const last = back === 0 ? end.getUTCDate() : days;
      const d = day => `${ym}-${String(day).padStart(2, '0')}`;
      const on = (day, fn) => { if (day <= last) fn(d(day)); };
      const month = first.getUTCMonth();

      on(1, x => tx(x, -rent, 'c-rent', 'Hudson Park Residences', 'demo-chk'));
      for (const day of [3, 7, 11, 15, 19, 23, 27]) on(day, x => tx(x, -between(95, 165), 'c-groc', pick(['Whole Foods', "Trader Joe's", 'Fairway Market'])));
      for (const day of [2, 5, 8, 12, 14, 17, 20, 22, 26, 29]) on(day, x => tx(x, -between(38, 135), 'c-rest', pick(['Via Carota', 'Sweetgreen', "Joe's Pizza", 'Tatiana', 'Blue Bottle'])));
      for (const day of [4, 10, 16, 21, 25, 28]) on(day, x => tx(x, -between(45, 290), 'c-shop', pick(['Amazon', 'Uniqlo', 'Target', 'J.Crew'])));
      if (back % 4 === 1) { on(9, x => tx(x, -between(780, 1100), 'c-trav', 'Delta Air Lines')); on(18, x => tx(x, -between(1100, 1650), 'c-trav', 'Marriott')); }
      for (const day of [6, 13, 24]) on(day, x => tx(x, -between(18, 42), 'c-trav', 'Uber'));
      on(12, x => tx(x, -between(120, 175), 'c-util', 'Con Edison', 'demo-chk'));
      on(18, x => tx(x, -139.99, 'c-util', 'Verizon Fios', 'demo-chk'));
      on(5, x => tx(x, -22.99, 'c-ent', 'Netflix'));
      on(5, x => tx(x, -11.99, 'c-ent', 'Spotify'));
      if (rand() > 0.5) on(19, x => tx(x, -between(30, 80), 'c-ent', 'AMC Theatres'));
      on(20, x => tx(x, -150, 'c-char', 'City Harvest', 'demo-chk'));
      if (month === 11) on(22, x => tx(x, -2000, 'c-char', 'Year-end giving', 'demo-chk'));
      if (rand() > 0.6) on(15, x => tx(x, -between(20, 65), 'c-med', 'CVS Pharmacy'));

      on(10, x => tx(x, 8750, 'c-pay', 'Practice deposit', 'demo-chk'));
      on(15, x => tx(x, 10000, 'c-pay', 'Employer payroll', 'demo-chk'));
      on(Math.min(days, 30), x => tx(x, 10000, 'c-pay', 'Employer payroll', 'demo-chk'));
      on(16, x => tx(x, -4000, 'c-inv', 'Transfer to brokerage', 'demo-chk'));
      on(25, x => tx(x, -3200, 'c-card', 'Sapphire card payment', 'demo-chk'));
      on(25, x => tx(x, 3200, 'c-card', 'Payment received', 'demo-card'));
    }
    // The one thing the pace card should find: a sofa from a shop never used before.
    const oneOff = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), Math.min(6, end.getUTCDate())));
    tx(oneOff.toISOString().slice(0, 10), -1900, 'c-shop', 'Maple & Oak');
    // Date order, as a ledger read from the database arrives. Anything reading the first and last
    // rows as the ledger's range — the sync status, the snapshot explanation — depends on it.
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // ── Everything a screen reads, built by the app's own engines ────────────
  // `engines` carries the shared modules so this runs identically in the browser and in Node:
  // { Accounts, Spending, Pace, Monitors, TaxPlan, TaxRules, Liquidity, Snapshots, run }.
  function buildDemoState(P, engines, opts) {
    const E = engines || {};
    const o = opts || {};
    const now = o.now || new Date().toISOString();
    const today = now.slice(0, 10);

    const accounts = demoAccounts(P, now);
    const summary = { ...E.Accounts.summarize(accounts, {}), complete: true };
    const caps = E.Accounts.capabilities({
      balances: true, balancesAsOf: now,
      holdings: true, holdingsDetail: '4 positions', holdingsAsOf: now,
      transactions: true, transactionsAsOf: now,
    });
    const ovw = { asOf: now, warning: null, partial: false, summary, overrides: {},
      capabilities: caps, blocked: E.Accounts.blockedBy(caps),
      doubleCounting: E.Accounts.detectDoubleCounting(accounts, []), syncStatus: {} };

    const brokerage = accounts.find(a => a.id === 'demo-brk').balance;
    const investments = demoHoldings(brokerage, now);

    // Spending: summarised, covered and averaged the way the server's spendingReport does it.
    const ledger = demoLedger(today, P);
    const catIndex = E.Spending.indexCategories(CATEGORIES);
    const accountClasses = Object.fromEntries(summary.byClass
      ? Object.entries(summary.byClass).flatMap(([cls, g]) => (g.accounts || []).map(a => [a.id, cls]))
      : []);
    const classify = t => E.Spending.classify(t, catIndex, { accountClasses });
    const sum = E.Spending.summarize(ledger, CATEGORIES, { accountClasses });
    const windows = {};
    const thisMonth = today.slice(0, 7);
    for (const m of sum.months) if (m.month < thisMonth) {
      const [y, mo] = m.month.split('-').map(Number);
      windows[m.month] = { startDate: m.month + '-01',
        endDate: new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10), syncedAt: now, count: null };
    }
    const coverage = E.Spending.coverage(sum.months, today, windows);
    const pace = E.Pace.pace(ledger, catIndex, { asOf: today, classify });
    const status = { windows, transactions: ledger.length, firstDate: ledger[0].date,
      lastDate: ledger[ledger.length - 1].date, lastSyncAt: now, pending: 0 };
    const spend = {
      startDate: ledger[0].date, endDate: today, status, coverage, pace,
      months: sum.months.map(m => ({ ...m, byCategory: undefined })),
      totals: sum.totals, counts: sum.counts,
      rolling: {
        m3: E.Spending.rollingAverage(sum.months, 3, null, today, windows),
        m6: E.Spending.rollingAverage(sum.months, 6, null, today, windows),
        m12: E.Spending.rollingAverage(sum.months, 12, null, today, windows),
      },
    };
    const syncStatus = { ...status, running: false };

    // The watchlist: the monitor engine against this household, exactly as /api/inbox runs it.
    let inbox = null;
    if (E.Monitors && E.run) {
      const R = E.run(P).R;
      const avg = E.Spending.rollingAverage(sum.months, Math.min(6, coverage.completeMonths.length) || 1,
        m => m.expense, today, windows);
      const ctx = { today, liquidity: E.Liquidity, taxRules: E.TaxRules,
        sources: { plan: 'ok', accounts: 'ok', spending: 'ok',
          pace: pace.status === 'ok' ? 'ok' : 'insufficient history',
          taxFacts: 'missing withholding to date — a demo has no pay stubs' },
        P, R, marginalRate: R[0] && R[0].sVestRate ? R[0].sVestRate : null,
        accounts: { ...summary, asOf: now, complete: true },
        spending: { completeMonths: coverage.completeMonths.slice(-6), monthlyExpense: avg },
        pace, pendingStripeSale: R[0] ? (R[0].sSold || 0) + (R[0].sHold || 0) : 0 };
      const detection = E.Monitors.detect(ctx);
      const prioritized = E.Monitors.prioritize(detection.alerts, {}, { today, limit: 3 });
      const opportunities = E.TaxPlan ? E.TaxPlan.screenOpportunities({ P, R, marginalRate: ctx.marginalRate }) : [];
      inbox = { generatedAt: detection.generatedAt, ...prioritized,
        notChecked: detection.skipped, checksThatFailed: detection.failed,
        checksRun: detection.checksRun, checksTotal: detection.checksTotal,
        sources: ctx.sources, taxPlan: null, opportunities,
        documentRequests: E.TaxPlan ? E.TaxPlan.documentRequests(opportunities.flatMap(x => x.needs || [])) : [] };
    }

    // Two saved cases for the comparison view. Params only; the caller runs them.
    const scenarios = [
      { name: 'Buy two years later', params: { ...P, homePurchaseYear: P.homePurchaseYear + 2 } },
      { name: 'A $300K smaller home', params: { ...P, homePrice: P.homePrice - 300000 } },
    ];

    // Two dated snapshots a month apart, and the change between them explained by the snapshot
    // engine against the ledger for the same window — as /api/wealth/history does.
    let hist = null;
    if (E.Snapshots) {
      const earlierAt = new Date(Date.parse(now) - 30 * 864e5).toISOString();
      const snap = (asOf, byClass) => {
        const netWorth = Object.values(byClass).reduce((t, g) => t + g.total, 0);
        return { id: 'demo-snap-' + asOf.slice(0, 10), asOf, netWorth,
          accessible: byClass.cash.total + byClass.taxable.total, byClass, complete: true, note: null };
      };
      const cls = k => (summary.byClass[k] || { total: 0 }).total;
      const latest = snap(now, Object.fromEntries(Object.keys(summary.byClass).map(k => [k, { total: cls(k) }])));
      const earlier = snap(earlierAt, { ...Object.fromEntries(Object.keys(summary.byClass).map(k => [k, { total: cls(k) }])),
        cash: { total: cls('cash') - 6200 }, taxable: { total: cls('taxable') - 11800 },
        retirement: { total: cls('retirement') - 4100 } });
      const between = ledger.filter(t => t.date >= earlierAt.slice(0, 10) && t.date <= today);
      const sm = E.Spending.summarize(between, CATEGORIES, { accountClasses });
      const change = E.Snapshots.explainChange(earlier, latest,
        { income: sm.totals.income, spending: sm.totals.expense },
        { firstDate: ledger[0].date, lastDate: ledger[ledger.length - 1].date });
      change.classDeltas = E.Snapshots.classDeltas(earlier, latest);
      hist = { snapshots: [latest, earlier], change };
    }

    const netWorth = summary.netWorth;
    const snapshot = { netWorth, liquid: summary.accessible,
      retirement: (summary.byClass.retirement || {}).total || 0,
      assets: summary.assets, liabilities: summary.debt, syncedAt: now, partial: false,
      accountCount: accounts.length };

    return { accounts, ovw, investments, spend, syncStatus, inbox, scenarios, snapshot, ledger, hist };
  }

  // ── A sample exchange for the advisor ────────────────────────────────────
  // The advisor never runs in a demo — nothing is sent anywhere — but an empty "paused" page
  // demos nothing. This is one exchange, labelled as an example, whose every figure is read
  // off the demo projection rather than written in.
  function advisorSample(P, R, money) {
    const m = money || (v => '$' + Math.round(v).toLocaleString('en-US'));
    const y = P.kid1Birth;
    const r = R.find(x => x.yr === y) || R[1] || R[0];
    const floor = R.reduce((a, b) => (b.liq < a.liq ? b : a));
    const q = `What does ${r.yr} cost, and can we afford it with the baby arriving?`;
    const a = [
      `**${r.yr} costs ${m(r.totEFull)}** across the whole year:`,
      '',
      `- Housing ${m(r.hFull)}`,
      `- Living ${m(r.totEFull - r.hFull - r.ccFull - r.tuFull - (r.eAdj || 0))}`,
      `- Childcare ${m(r.ccFull)}${P.childcareStartMonths ? ` — starting at ${P.childcareStartMonths} months, after leave` : ''}`,
      r.tuFull ? `- Tuition ${m(r.tuFull)}` : null,
      '',
      `After tax you bring in ${m(r.incFull)} of cash that year, and net flow across all income is **${r.flowFull >= 0 ? '+' : '−'}${m(Math.abs(r.flowFull))}**${r.flowFull >= 0 ? ', so the year funds itself' : ', so the year draws on savings'}.`,
      '',
      `The tightest point in the plan is ${floor.yr}, when liquid assets bottom out at ${m(floor.liq)} — that is the year to watch, not ${r.yr}.`,
    ].filter(x => x !== null).join('\n');
    return [{ role: 'user', content: q }, { role: 'assistant', content: a }];
  }

  const api = { DEMO_OVERRIDES, MONEY_FLOOR, CATEGORIES, demoScrub, demoDefaults, demoShape, rng,
    demoAccounts, demoHoldings, demoLedger, buildDemoState, advisorSample };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlannerDemo = api;
})(typeof window !== 'undefined' ? window : this);
