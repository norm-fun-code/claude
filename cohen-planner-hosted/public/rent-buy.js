'use strict';
// ═══ RENT OR BUY ═══
// The same plan run twice — once buying the home it describes, once renting for good — with
// every other assumption identical. Pure: the projection engine is passed in, so the browser
// and the tests run exactly the same comparison.
//
// Three things make the comparison fair rather than flattering to either side.
//
// 1. RENT RISES IN BOTH. A saved buy plan charges flat rent before the purchase, deliberately,
//    to keep its legacy projection. Compared against a rent plan whose rent inflates, that gift
//    of flat rent would count as a reason to buy. Both runs here inflate it.
//
// 2. A HOUSE IS NOT CASH. On paper, equity counts in full. To spend it you sell, and selling
//    costs money — broker, transfer taxes, legal. Buying is judged after that cost, which is an
//    explicit, adjustable assumption rather than a hidden one.
//
// 3. IT SAYS WHAT WOULD CHANGE THE ANSWER. A single verdict on a 30-year projection is a
//    point estimate wearing a conclusion's clothes. The assumptions that decide it — how fast
//    the home appreciates, how fast rent rises, what the money earns if it is not in a house —
//    are each solved for the value at which the two come out level.

(function (root) {

  const DEFAULT_SELL_COST = 0.07;
  const LENSES = ['networth', 'cashflow'];

  // Stripe's return is a ten-year path plus a long-run rate, so "Stripe grows faster" is a
  // shift applied to every year of it, not a change to one field.
  function withStripeShift(P, shift) {
    const d = Number(shift) || 0;
    if (!d) return P;
    const q = { ...P, stripeLongTermReturn: (P.stripeLongTermReturn ?? 0.08) + d };
    for (let i = 0; i < 10; i++) if (P['stripeRetY' + i] != null) q['stripeRetY' + i] = P['stripeRetY' + i] + d;
    return q;
  }

  function scenarios(P) {
    const base = { ...P, rentInflatesBeforePurchase: true };
    return { buy: { ...base, housingMode: 'buy' }, rent: { ...base, housingMode: 'rent' } };
  }

  const yearRow = (R, y) => R.find(r => r.yr === y) || null;
  const housingOf = r => (r ? (r.hFull != null ? r.hFull : r.h) : 0);
  const spendOf = r => (r ? (r.totEFull != null ? r.totEFull : r.totE) || 0 : 0);

  // Net worth at each year, buying judged after the cost of selling the home that year.
  function series(P, run, sellCost) {
    const s = scenarios(P);
    const B = run(s.buy), Rr = run(s.rent);
    const py = Number(P.homePurchaseYear);
    const rows = B.R.map((b, i) => {
      const r = Rr.R[i];
      const owned = b.yr >= py && (b.hv || 0) > 0;
      const sale = owned ? Math.round((b.hv || 0) * sellCost) : 0;
      const buy = b.netWorth - sale;
      // Cash out the door: everything the household spends in the year, plus the cash to close
      // in the purchase year. A down payment is not lost — it becomes equity — but it is cash
      // that left, and that is what a cash-flow reading asks about.
      const rentOut = spendOf(r), buyOut = spendOf(b) + (b.dpOut || 0);
      return { yr: b.yr, rent: r.netWorth, buyPaper: b.netWorth, buy, saleCost: sale,
        edge: buy - r.netWorth, rentHousing: housingOf(r), buyHousing: housingOf(b),
        rentLiq: r.liq, buyLiq: b.liq, owned, rentOut, buyOut };
    });
    let cr = 0, cb = 0;
    for (const x of rows) { cr += x.rentOut; cb += x.buyOut; x.rentCum = cr; x.buyCum = cb; x.cashEdge = cr - cb; }
    return { rows, buyRun: B, rentRun: Rr };
  }

  function lowest(R) {
    return R.reduce((a, b) => (b.liq < a.liq ? b : a));
  }

  // The first owned year from which buying stays ahead to the horizon. A crossing that is later
  // undone is not a break-even, it is a coincidence.
  function breakevenYear(rows, py, horizon) {
    const span = rows.filter(r => r.yr >= py && r.yr <= horizon);
    for (let i = 0; i < span.length; i++)
      if (span.slice(i).every(r => r.edge >= 0)) return span[i].yr;
    return null;
  }

  function compare(P, run, opts) {
    const o = opts || {};
    const sellCost = o.sellCostPct != null && Number.isFinite(Number(o.sellCostPct)) ? Number(o.sellCostPct) : DEFAULT_SELL_COST;
    const lens = LENSES.includes(o.lens) ? o.lens : 'networth';
    const { rows, buyRun, rentRun } = series(P, run, sellCost);
    const first = rows[0].yr, last = rows[rows.length - 1].yr;
    const py = Number(P.homePurchaseYear);
    const inPlan = py >= first && py <= last;
    const horizon = Math.max(first, Math.min(last, Number(o.horizonYear) || last));
    const at = rows.find(r => r.yr === horizon);

    // The first full year of owning, for the like-for-like annual figures. A purchase in the
    // plan's first year can be a part-year, so the year after stands in.
    const ownedYear = Math.min(last, py === first ? py + 1 : py);
    const bOwned = yearRow(buyRun.R, ownedYear), rOwned = yearRow(rentRun.R, ownedYear);
    const tenOn = Math.min(last, ownedYear + 10);
    const sumHousing = (R) => R.filter(r => r.yr <= horizon).reduce((t, r) => t + housingOf(r), 0);
    const bLow = lowest(buyRun.R), rLow = lowest(rentRun.R);
    const purchase = yearRow(buyRun.R, py);

    // What buying costs in the year it happens, beyond turning cash into equity. The down
    // payment itself is not lost — it moves into the home — so it is reported but not counted.
    const rPurchase = yearRow(rentRun.R, py);
    const down = Math.round(Number(P.homePrice || 0) * Number(P.downPctg || 0) / 100);
    const upfront = purchase && rPurchase ? {
      down, cashToClose: purchase.dpOut || 0,
      closing: Math.max(0, (purchase.dpOut || 0) - down),
      // Selling investments to fund the purchase realises their gains; the renter's stay deferred.
      investmentTax: Math.max(0, (purchase.txS || 0) - (rPurchase.txS || 0)),
      stripeTax: Math.max(0, (purchase.sGainTax || 0) - (rPurchase.sGainTax || 0)),
      stripeSold: Math.max(0, (purchase.sHold || 0) - (rPurchase.sHold || 0)),
      extraHousing: Math.max(0, housingOf(purchase) - housingOf(rPurchase)),
    } : null;

    // Where the gap at the horizon comes from, component by component. It sums to the gap
    // exactly — the remainder line takes anything not itemised — so the reader can check it.
    const bH = yearRow(buyRun.R, horizon), rH = yearRow(rentRun.R, horizon);
    let attribution = null;
    if (bH && rH && at) {
      const parts = [
        { key: 'equity', label: 'Home equity', value: (bH.eq || 0) - (rH.eq || 0) },
        { key: 'sale', label: 'Cost to sell the home', value: -at.saleCost },
        { key: 'liquid', label: 'Investments', value: bH.liq - rH.liq },
        { key: 'stripe', label: 'Stripe shares', value: (bH.sEnd || 0) - (rH.sEnd || 0) },
        { key: 'retirement', label: 'Retirement', value: (bH.k401 || 0) - (rH.k401 || 0) },
      ];
      const itemised = parts.reduce((t, x) => t + x.value, 0);
      const rest = at.edge - itemised;
      if (Math.abs(rest) >= 1) parts.push({ key: 'other', label: 'Everything else', value: rest });
      attribution = parts.map(x => ({ ...x, value: Math.round(x.value) }));
    }

    // The first owned year from which owning costs less each year than renting, and stays so.
    // Rent rises; a fixed-rate mortgage does not — this is the year that difference pays off.
    const owned = rows.filter(r => r.owned && r.yr <= horizon);
    let cheaperFrom = null;
    for (let i = 0; i < owned.length; i++)
      if (owned.slice(i).every(r => r.buyOut <= r.rentOut)) { cheaperFrom = owned[i].yr; break; }

    const edge = at ? (lens === 'cashflow' ? at.cashEdge : at.edge) : 0;
    return {
      lens, sellCost, horizon, purchaseYear: py, inPlan, rows, upfront, attribution, cheaperFrom,
      verdict: !at ? null : {
        lens, edge, winner: edge >= 0 ? 'buy' : 'rent', margin: Math.abs(edge),
        rent: at.rent, buy: at.buy, buyPaper: at.buyPaper, saleCost: at.saleCost,
        rentCum: at.rentCum, buyCum: at.buyCum,
      },
      breakeven: inPlan ? breakevenYear(rows.map(r => lens === 'cashflow' ? { ...r, edge: r.cashEdge } : r), py, horizon) : null,
      facts: {
        cashAtPurchase: purchase ? purchase.dpOut || 0 : 0,
        ownedYear, tenOn,
        housingFirst: { rent: housingOf(rOwned), buy: housingOf(bOwned) },
        housingTen: { rent: housingOf(yearRow(rentRun.R, tenOn)), buy: housingOf(yearRow(buyRun.R, tenOn)) },
        housingTotal: { rent: sumHousing(rentRun.R), buy: sumHousing(buyRun.R) },
        lowestLiquid: { rent: { liq: rLow.liq, yr: rLow.yr }, buy: { liq: bLow.liq, yr: bLow.yr } },
        drawYears: { rent: rentRun.drawYears, buy: buyRun.drawYears },
        // The model attaches a suburban move to buying — a car, more insurance and utilities,
        // less transit. Real, and not a housing cost, so it is shown on its own line rather
        // than left inside "living" where nobody would think to look for it.
        suburbanLiving: bOwned && rOwned ? Math.round(bOwned.liv - rOwned.liv) : 0,
        homeValueAtHorizon: (yearRow(buyRun.R, horizon) || {}).hv || 0,
      },
    };
  }

  // The value of one assumption at which renting and buying come out level at the horizon,
  // found by bisection. Returns null when the answer does not flip anywhere in the range —
  // which is itself worth saying: "buying wins even at 0% appreciation".
  function flipPoint(P, run, key, lo, hi, opts) {
    const o = opts || {};
    const edgeAt = v => {
      const c = compare(key === 'stripeShift' ? withStripeShift(P, v) : { ...P, [key]: v }, run, o);
      return c.verdict ? c.verdict.edge : 0;
    };
    let a = lo, b = hi, ea = edgeAt(a), eb = edgeAt(b);
    if (Math.sign(ea) === Math.sign(eb)) return { key, value: null, alwaysBuy: ea >= 0, lo, hi };
    for (let i = 0; i < 28; i++) {
      const m = (a + b) / 2, em = edgeAt(m);
      if (Math.sign(em) === Math.sign(ea)) { a = m; ea = em; } else { b = m; eb = em; }
    }
    // Which side of the flip favours buying, so the sentence can say "above" or "below".
    return { key, value: (a + b) / 2, buyAbove: eb >= ea, lo, hi };
  }

  const FLIPS = [
    { key: 'homeAppreciation', label: 'Home appreciation', lo: -0.03, hi: 0.10 },
    { key: 'rentInflation', label: 'Rent inflation', lo: 0, hi: 0.10 },
    { key: 'investReturn', label: 'Portfolio return', lo: 0, hi: 0.12 },
    { key: 'mortgageRate', label: 'Mortgage rate', lo: 2, hi: 10 },
  ];

  function flips(P, run, opts) {
    return FLIPS.map(f => ({ ...f, current: Number(P[f.key] ?? (f.key === 'rentInflation' ? 0.03 : 0)),
      ...flipPoint(P, run, f.key, f.lo, f.hi, opts) }));
  }

  const api = { DEFAULT_SELL_COST, LENSES, FLIPS, scenarios, compare, flipPoint, flips, breakevenYear, withStripeShift };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlannerRentBuy = api;
})(typeof window !== 'undefined' ? window : this);
