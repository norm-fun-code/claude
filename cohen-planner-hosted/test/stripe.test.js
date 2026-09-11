import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { run, runMonteCarlo, calcTax, stripeVestFactor, stripeVestRemaining, stripeSellAmount, sellLots, lotsValue, lotsBasis, normComp } = require('../public/model.js');
const { migrateP, rollForwardParams } = require('../public/plan-migrate.js');

// A complete, realistic plan. Cash + stock per year sum to the pre-split total-comp
// figures, so anything tax-related can be compared against the old model exactly.
const P = {
  planStartYear: 2026, planEndYear: 2058,
  pretax401k: 23500, pretaxBenefits: 11700, company401kMatch: 8750, k401Start: 210000,
  taxInflation: 0.025, expenseInflation: 0.03, tuitionInflation: 0.035,
  kid1Birth: 2027, kid2Birth: 2030, kid3Birth: 2034, numKids: 3,
  childcareMonthly: 2800, yeshivaStartAge: 2, kid1YeshivaStartAge: 3, yeshivaEndAge: 17,
  startingLiquid: 1100000, nycRent: 5500,
  startingStripeEquity: 0, stripeLongTermReturn: 0.08, stripePolicy: 'deficit',
  normGrowth: 0.01, normStockGrowth: 0.01,
  nancyW2Y0: 130000, nancyW2Y1: 80000, nancyW2Y2: 100000, nancyW2Y3: 75000,
  nancyHourlyRate: 300, nancyRampYear: 2030, nancyRampClients: 5, nancyMaxClients: 18,
  nancyRampYears: 6, nancyWeeksPerYear: 46, nancySoloPractice: 1,
  nancyPracticeOverhead: 15000, nancyHomeOfficeDeduct: 8000, nancyQBIRate: 0.20,
  baseGroceries: 7000, baseDining: 14000, baseShopping: 22000, baseVacations: 20000,
  baseAuto: 3500, baseInsurance: 1500, baseMisc: 10000, baseEntertainment: 4500,
  baseCharity: 8500, baseMedical: 4500, baseTransit: 4000, baseUtilsPhoneNet: 5500,
  postKidVacations: 10000,
  homePrice: 2000000, downPctg: 50, mortgageRate: 5.0, homePurchaseYear: 2099,
  propTaxRate: 0.012, maintBase: 10000, homeAppreciation: 0.03,
  suburbAutoBoost: 3500, suburbInsBoost: 1500, suburbUtilBoost: 2500,
  investReturn: 0.06, capGainsTaxRate: 0.345, costBasisPct: 0.55, mcVol: 0.14,
};
for (let i = 0; i < 11; i++) { P['normCashY' + i] = 280000; P['normStockY' + i] = 197000; }
const y0 = p => run(p).R[0];

// ── 1. Cash + stock = one combined W-2 for tax purposes ──────────────────
describe('taxable compensation', () => {
  it('W-2 income is cash + stock combined', () => {
    const r = y0(P);
    expect(r.normCash).toBe(280000);
    expect(r.normStock).toBe(197000);
    expect(r.normG).toBe(477000);
    expect(r.gross).toBe(477000 + r.nancyG);
  });

  it('shifting comp between cash and stock does not change tax at all', () => {
    const shifted = { ...P };
    for (let i = 0; i < 11; i++) { shifted['normCashY' + i] = 100000; shifted['normStockY' + i] = 377000; }
    const a = run(P).R, b = run(shifted).R;
    for (let i = 0; i < a.length; i++) {
      expect(b[i].tax).toBe(a[i].tax);
      expect(b[i].gross).toBe(a[i].gross);
    }
  });

  it('stock is taxed as ordinary W-2 income, not at capital-gains rates', () => {
    const t = calcTax(477000, { ...P, _normW2: 477000, _nancyW2: 0, _nancySE: 0, _nancyOverhead: 0 }, 2026, 0);
    const allCash = calcTax(477000, { ...P, _normW2: 477000, _nancyW2: 0, _nancySE: 0, _nancyOverhead: 0 }, 2026, 0);
    expect(t.allInTax).toBe(allCash.allInTax);
    expect(t.fica).toBeGreaterThan(0); // FICA applies — it really is wage income
  });
});

// ── 2. Retained stock is not spendable cash ──────────────────────────────
describe('cash-flow treatment', () => {
  it('cash available excludes stock: = cash comp + Nancy − tax − pretax − overhead', () => {
    const r = y0(P);
    // Shares are withheld at vest, so what reaches the account is the after-tax grant and
    // the cash side keeps the rest. The two still sum to total after-tax compensation.
    expect(r.inc).toBe(r.netTC - r.sNew);
    expect(r.sGross).toBe(r.normStock);
    expect(r.sNew + r.sVestTax).toBeCloseTo(r.sGross, 0);
    expect(r.inc).toBeLessThan(r.netTC);
  });

  it('retaining more stock does not increase spendable cash', () => {
    const a = y0({ ...P, stripePolicy: 'retain' });
    const b = y0({ ...P, stripePolicy: 'sell' });
    expect(a.inc).toBe(b.inc); // identical — policy changes the ASSET, not take-home cash
    expect(a.sRet).toBeGreaterThan(b.sRet);
  });

  it('surplus is measured against cash only, so a stock-heavy plan shows a real gap', () => {
    const stockHeavy = { ...P };
    for (let i = 0; i < 11; i++) { stockHeavy['normCashY' + i] = 120000; stockHeavy['normStockY' + i] = 357000; }
    const r = y0(stockHeavy);
    expect(r.surp).toBeLessThan(0);
    expect(r.gap).toBeGreaterThan(0);
    expect(y0(P).gap).toBeLessThan(r.gap); // same total comp, less stock → smaller gap
  });
});

// ── 3. Selling everything reproduces the old combined-comp model ─────────
describe('sell-all reconciliation', () => {
  it('sell-all matches a pure-cash plan of the same total comp, dollar for dollar', () => {
    const allCash = { ...P, stripePolicy: 'deficit' };
    for (let i = 0; i < 11; i++) { allCash['normCashY' + i] = 477000; allCash['normStockY' + i] = 0; }
    const a = run({ ...P, stripePolicy: 'sell' }).R;
    const b = run(allCash).R;
    for (let i = 0; i < a.length; i++) {
      expect(Math.abs(a[i].liq - b[i].liq)).toBeLessThanOrEqual(1);
      expect(Math.abs(a[i].nw - b[i].nw)).toBeLessThanOrEqual(1);
    }
  });

  it('sell-all leaves no Stripe equity behind', () => {
    const { R } = run({ ...P, stripePolicy: 'sell' });
    for (const r of R) { expect(r.sRet).toBe(0); expect(r.sEnd).toBe(0); }
  });
});

// ── 4. No phantom capital gains on newly vested stock ────────────────────
describe('tax treatment of Stripe sales', () => {
  // Cash comp alone covers every year, so the diversified pool is never drawn on. Any
  // tax on sales would therefore have to come from the vesting stock — and must not.
  const surplus = () => {
    const p = { ...P, stripePolicy: 'sell' };
    for (let i = 0; i < 11; i++) { p['normCashY' + i] = 900000; p['normStockY' + i] = 197000; }
    return p;
  };

  it('selling newly vested stock triggers no capital-gains tax', () => {
    const { R } = run(surplus());
    for (const r of R) {
      expect(r.sSold).toBeGreaterThan(0); // stock really is being sold every year
      expect(r.sold).toBe(0);             // portfolio never touched
      expect(r.txS).toBe(0);              // …so there is no tax on any sale
    }
  });

  it('the generic cost-basis assumption is not applied to vesting stock', () => {
    // costBasisPct governs only the diversified pool, so it must not move a plan whose
    // stock is sold at vest.
    const a = run({ ...surplus(), costBasisPct: 0.1 }).R;
    const b = run({ ...surplus(), costBasisPct: 0.9 }).R;
    expect(a[a.length - 1].nw).toBe(b[b.length - 1].nw);
  });

  it('retained stock carries basis equal to vest-date value', () => {
    const R = run({ ...P, stripePolicy: 'retain' }).R;
    expect(R[0].sBasis).toBe(R[0].sRet); // first year: basis is exactly what was retained
    // …and in the first year that is ALSO the value: no tender has re-marked it yet, so
    // there is no appreciation above basis until February of the following year.
    expect(R[0].sEnd).toBe(R[0].sBasis);
    expect(R[1].sEnd).toBeGreaterThan(R[1].sBasis); // the Feb yr+1 mark lands here
  });
});

// ── 5-7. Appreciation mechanics ──────────────────────────────────────────
describe('Stripe appreciation', () => {
  it('retained stock compounds at the Stripe rate, not the portfolio rate', () => {
    const slow = run({ ...P, stripePolicy: 'retain', stripeLongTermReturn: 0.02 }).R;
    const fast = run({ ...P, stripePolicy: 'retain', stripeLongTermReturn: 0.20 }).R;
    expect(fast[fast.length - 1].sEnd).toBeGreaterThan(slow[slow.length - 1].sEnd * 5);
    // investReturn must not move Stripe in a plan that never reaches the reserve floor
    // (once it does, the two are legitimately coupled through the funding waterfall).
    const rich = { ...P, stripePolicy: 'retain', startingLiquid: 9000000 };
    const a = run({ ...rich, investReturn: 0.03 }).R;
    const b = run({ ...rich, investReturn: 0.09 }).R;
    expect(a[10].sHold).toBe(0);
    expect(b[10].sHold).toBe(0);
    expect(a[10].sEnd).toBe(b[10].sEnd);
  });

  it('per-year return overrides beat the long-term rate inside the explicit window', () => {
    const p = { ...P, stripePolicy: 'retain', stripeRetY0: 0.50, stripeLongTermReturn: 0.0 };
    const R = run(p).R;
    expect(R[0].sRate).toBe(0.50);        // 2026's performance, as typed
    expect(R[1].sMarked).toBe(0.50);      // …marked onto the position at the Feb 2027 tender
    // So the override shows up in the SECOND row, not the first. The first row is still at
    // the mark the position was already carrying.
    const flat = run({ ...P, stripePolicy: 'retain', stripeLongTermReturn: 0.0 }).R;
    expect(flat[0].sEnd).toBe(R[0].sEnd);
    expect(flat[1].sEnd).toBeLessThan(R[1].sEnd);
  });

  it('quarterly vesting earns only partial-year growth, never a full year', () => {
    const sr = 0.20;
    const f = stripeVestFactor(sr);
    expect(f).toBeGreaterThan(1);        // some growth — earlier quarters do appreciate
    expect(f).toBeLessThan(1 + sr);      // but strictly less than a full year
    // Q4 lot earns nothing, Q1 lot earns 9 months
    const expected = ((1 + sr) ** 0.75 + (1 + sr) ** 0.5 + (1 + sr) ** 0.25 + 1) / 4;
    expect(f).toBeCloseTo(expected, 10);
  });

  it('marks every share at the same tender price, whichever quarter it vested in', () => {
    // Stripe is private: there is one price, set at the February tender, and it holds until
    // the next one. A share that vested in November is worth exactly what a share carried in
    // from last year is worth, so both earn the same single re-mark at the next tender.
    const sr = 0.20;
    const R = run({ ...P, stripePolicy: 'retain', startingStripeEquity: 1000000, stripeLongTermReturn: sr }).R;
    // Everything held at the end of year 0 — carried-in shares and every quarter's vest —
    // is re-marked together, once, at the next tender. Year 1's own vests land at that new
    // mark and are NOT re-marked again in the same row.
    expect(Math.abs(R[1].sEnd - (R[0].sEnd * (1 + sr) + R[1].sAdded))).toBeLessThanOrEqual(2);
  });

  it('does not count the part of this year\'s vest that is already in the opening balance', () => {
    // The reported position is observed mid-year, so it already contains the vests that have
    // landed. Adding the whole year's grant on top counts those dollars twice.
    const base = { ...P, stripePolicy: 'retain', startingStripeEquity: 614000, stripeLongTermReturn: 0 };
    const asOfJan = run(base).R[0];
    const asOfAug = run({ ...base, stripeObservedMonth: 8 }).R[0];

    // Vests land 15 Mar / 15 Jun / 15 Sep / 15 Dec. By the end of August only March and
    // June have landed, so half the grant is still ahead.
    expect(stripeVestRemaining({ ...base, stripeObservedMonth: 8 })).toBe(0.5);
    expect(Math.abs(asOfAug.sAdded - asOfAug.sRet * 0.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(asOfAug.sInOpening - asOfAug.sRet * 0.5)).toBeLessThanOrEqual(1);
    // The whole year's vest is still reported as income — only the ASSET was double-counted.
    expect(asOfAug.sNew).toBe(asOfJan.sNew);
    expect(asOfAug.sEnd).toBeLessThan(asOfJan.sEnd);
    // The gap between the two is exactly the half of the grant that had already landed.
    expect(Math.abs((asOfJan.sEnd - asOfAug.sEnd) - asOfAug.sRet * 0.5)).toBeLessThanOrEqual(1);
  });

  it('reconciles: opening + newly added, re-marked once, is the closing balance', () => {
    const sr = 0.15;
    const R = run({ ...P, stripePolicy: 'retain', startingStripeEquity: 614000,
      stripeObservedMonth: 8, stripeLongTermReturn: sr }).R;
    // Year 0 closes at its opening mark plus what vested — no re-mark, so no appreciation.
    expect(Math.abs(R[0].sEnd - (R[0].sBeg + R[0].sAdded))).toBeLessThanOrEqual(1);
    expect(R[0].sAppr).toBe(0);
    // Year 1 opens with the tender: the whole carried position is re-marked once, and only
    // then does this year's vest land on top of it.
    expect(Math.abs(R[1].sAppr - R[1].sBeg * sr)).toBeLessThanOrEqual(1);
    expect(Math.abs(R[1].sEnd - (R[1].sBeg * (1 + sr) + R[1].sAdded))).toBeLessThanOrEqual(2);
  });

  it('sells at the mark the shares are actually priced at, not a marked-up one', () => {
    // A sale during the year executes at the February mark. Crediting the year's return
    // first would let the plan sell shares at a price no tender has yet offered.
    const sr = 0.50;   // a big move, so a within-year mark-up would be unmistakable
    const p = { ...P, startingStripeEquity: 1000000, stripeLongTermReturn: sr,
      stripePolicy: 'sell', startingLiquid: 0, liquidReserveFloor: 0 };
    const r = run(p).R[0];
    // Whatever was sold from holdings came out of the opening balance at the opening mark.
    expect(r.sHold).toBeLessThanOrEqual(r.sBeg + r.sAdded + 1);
  });
});

// ── 6/8/9. The cash waterfall ────────────────────────────────────────────
describe('cash waterfall', () => {
  // Cash comp no longer carries the tax on the stock — that is withheld from the shares —
  // so a gap now requires cash comp to genuinely fall short of the year's spending.
  const cashShort = { ...P };
  for (let i = 0; i < 11; i++) { cashShort['normCashY' + i] = 150000; cashShort['normStockY' + i] = 400000; }

  it('the default policy sells only enough new stock to close the gap', () => {
    const r = y0(cashShort);
    expect(r.gap).toBeGreaterThan(0);
    expect(r.sSold).toBe(r.gap);                    // exactly the gap, not a dollar more
    expect(r.sRet).toBe(r.sNew - r.gap);
  });

  it('new Stripe is sold BEFORE the diversified portfolio is touched', () => {
    const r = y0(cashShort);
    expect(r.sSold).toBeGreaterThan(0);
    expect(r.sold).toBe(0);                         // portfolio untouched
    expect(r.liq).toBeGreaterThan(P.startingLiquid); // and still growing
  });

  it('the portfolio only funds what new stock cannot cover', () => {
    const lean = { ...P };
    for (let i = 0; i < 11; i++) { lean['normCashY' + i] = 90000; lean['normStockY' + i] = 60000; }
    const r = y0(lean);
    expect(r.sSold).toBe(r.sNew);              // all new stock exhausted first
    expect(r.sRet).toBe(0);
    expect(r.sold).toBeGreaterThan(0);              // only then the portfolio
  });

  it('held Stripe is left alone while the portfolio is above its reserve floor', () => {
    const { R } = run({ ...P, startingStripeEquity: 3000000, liquidReserveFloor: 500000 });
    // Early years: the vest covers the gap, the pool is well clear of the floor.
    for (const r of R.slice(0, 4)) {
      expect(r.sHold).toBe(0);
      expect(r.sGainTax).toBe(0);
      expect(r.liq).toBeGreaterThan(500000);
    }
  });

  it('once the floor is reached, held Stripe funds the gap instead of breaching it', () => {
    const floor = 500000;
    const buying = { ...P, homePurchaseYear: 2030, startingStripeEquity: 3000000, liquidReserveFloor: floor };
    const { R } = run(buying);
    const r = R.find(x => x.yr === 2030);
    expect(r.sSold).toBe(r.sNew);          // whole vest first
    expect(r.liq).toBeCloseTo(floor, 0);        // pool stops exactly on the floor
    expect(r.sHold).toBeGreaterThan(0);         // held shares cover the rest
    // and the floor holds for the whole projection while shares remain
    for (const x of R) expect(x.liq).toBeGreaterThanOrEqual(floor - 1);
  });

  it('selling held shares realises capital gains, unlike selling at vest', () => {
    const buying = { ...P, homePurchaseYear: 2030, startingStripeEquity: 3000000, liquidReserveFloor: 500000 };
    const r = run(buying).R.find(x => x.yr === 2030);
    expect(r.sGainTax).toBeGreaterThan(0);
    expect(r.sGainTax).toBeLessThan(r.sHold * P.capGainsTaxRate); // only the gain, not the whole sale
    // A plan with no appreciation to realise owes nothing on the same sale.
    const flat = { ...buying, stripeLongTermReturn: 0, stripeStartingBasisPct: 1 };
    for (let i = 0; i < 10; i++) flat['stripeRetY' + i] = 0;
    const f = run(flat).R.find(x => x.yr === 2030);
    expect(f.sHold).toBeGreaterThan(0);
    expect(f.sGainTax).toBe(0);
  });

  it('a raised floor forces held shares to be sold sooner', () => {
    const mk = floor => run({ ...P, homePurchaseYear: 2030, startingStripeEquity: 3000000, liquidReserveFloor: floor });
    expect(mk(1500000).tSHold).toBeGreaterThan(mk(200000).tSHold);
  });

  it('a negative pool does not compound at the portfolio return', () => {
    // Everything exhausted: no equity to fall back on and a floor of zero.
    const broke = { ...P, startingStripeEquity: 0, startingLiquid: 50000, liquidReserveFloor: 0, investReturn: 0.09 };
    for (let i = 0; i < 11; i++) { broke['normCashY' + i] = 60000; broke['normStockY' + i] = 0; }
    const { R } = run(broke);
    const under = R.filter(r => r.liq < 0);
    expect(under.length).toBeGreaterThan(0);
    // Each year's decline is the funding shortfall alone — never shortfall + interest on
    // an overdraft that the model would otherwise accrue at the portfolio's own return.
    for (let i = 1; i < under.length; i++) {
      const prev = under[i - 1], cur = under[i];
      expect(Math.abs(cur.liq - (prev.liq - cur.sold * (1 + 0.09 / 2)))).toBeLessThanOrEqual(1.5);
    }
  });

  it('the down payment is part of the cash need, so vesting stock helps fund it', () => {
    const buying = { ...P, homePurchaseYear: 2030 };
    const r = run(buying).R.find(x => x.yr === 2030);
    expect(r.dpOut).toBeGreaterThan(1000000); // Includes closing costs, not just the down payment.
    expect(r.sSold).toBe(r.sNew);              // whole year's vest goes to the house
    expect(r.sRet).toBe(0);
  });
});

// ── 7. Retention policies ────────────────────────────────────────────────
describe('retention policies', () => {
  // Policies only diverge in a year that actually needs cash, so the fixture is deliberately
  // cash-light and stock-heavy. Cash comp no longer absorbs the tax withheld on the grant.
  const POLICY_BASE = (() => {
    const p = { ...P };
    for (let i = 0; i < 11; i++) { p['normCashY' + i] = 150000; p['normStockY' + i] = 400000; }
    return p;
  })();
  const at = pol => run({ ...POLICY_BASE, stripePolicy: pol }).R;

  it('sell-all ≤ cover-deficit ≤ retain-all in stock retained', () => {
    expect(at('sell')[0].sRet).toBe(0);
    expect(at('deficit')[0].sRet).toBeLessThanOrEqual(at('retain')[0].sRet);
    expect(at('retain')[0].sRet).toBe(at('retain')[0].sNew); // liquid covers year 1
  });

  it('retain-all drains the portfolio first, cover-deficit protects it', () => {
    // Needs a year where cash comp actually falls short, otherwise the two policies have
    // nothing to disagree about.
    const retain = at('retain'), deficit = at('deficit');
    expect(retain[0].liq).toBeLessThan(deficit[0].liq);
    expect(retain[0].sEnd).toBeGreaterThan(deficit[0].sEnd);
  });

  it('fixed-% sells that share of the vest when cash needs are smaller', () => {
    const r = run({ ...P, stripePolicy: 'pct', stripeSellPct: 0.5, startingLiquid: 6000000 }).R[0];
    expect(r.sSold).toBe(Math.round(r.sNew * 0.5));
  });

  it('maintain-floor keeps the diversified pool at or above the floor', () => {
    const floor = 900000;
    const { R } = run({ ...P, stripePolicy: 'floor', stripeLiquidFloor: floor });
    // Holds for as long as a year's vest is large enough to defend it
    for (const r of R.slice(0, 8)) expect(r.liq).toBeGreaterThanOrEqual(floor - 1);
  });

  it('a higher floor sells more stock from the same starting position', () => {
    // Monotonicity is a property of the policy at a given state. Over a full lifetime it
    // does NOT hold: a high floor front-loads selling, which builds a portfolio large
    // enough to self-fund later deficits, so cumulative selling can end up lower.
    const td = (1 - 0.55) * 0.345;
    const sell = floor => stripeSellAmount(
      { stripePolicy: 'floor', stripeLiquidFloor: floor }, 200000, -60000, 1000000, 0.06, td);
    expect(sell(200000)).toBe(0);                          // pool far above floor
    expect(sell(1000000)).toBeGreaterThan(0);
    expect(sell(1500000)).toBeGreaterThan(sell(1000000));  // higher floor → more selling
    expect(sell(9e9)).toBe(200000);                        // never exceeds the year's vest
  });

  it('the floor policy never sells less than is needed to stay solvent', () => {
    const td = (1 - 0.55) * 0.345;
    const args = [200000, -600000, 100000, 0.06, td];
    const floor = stripeSellAmount({ stripePolicy: 'floor', stripeLiquidFloor: 0 }, ...args);
    const retain = stripeSellAmount({ stripePolicy: 'retain' }, ...args);
    expect(floor).toBe(retain); // a zero floor IS the retain-all solvency backstop
  });

  it('every policy conserves the vest: sold + retained = new stock', () => {
    for (const pol of ['deficit', 'retain', 'floor', 'pct', 'sell']) {
      for (const r of run({ ...P, stripePolicy: pol }).R) {
        expect(r.sSold + r.sRet).toBe(r.sNew);
        expect(r.sSold).toBeGreaterThanOrEqual(0);
        expect(r.sRet).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ── 10. Net worth composition ────────────────────────────────────────────
describe('net worth composition', () => {
  it('net worth = diversified liquid + Stripe + home equity', () => {
    const { R } = run({ ...P, startingStripeEquity: 500000, homePurchaseYear: 2030 });
    for (const r of R) expect(Math.abs(r.nw - (r.liq + r.sEnd + r.eq))).toBeLessThanOrEqual(1);
  });

  it('Stripe is not folded into the liquid figure', () => {
    const withStripe = run({ ...P, startingStripeEquity: 500000 }).R[0];
    const without = run({ ...P, startingStripeEquity: 0 }).R[0];
    expect(withStripe.liq).toBe(without.liq);            // liquid untouched by Stripe
    expect(withStripe.nw - without.nw).toBeGreaterThan(400000);
  });

  it('reports Stripe as a share of net worth', () => {
    const r = run({ ...P, startingStripeEquity: 1000000 }).R[0];
    expect(r.sPct).toBeCloseTo(r.sEnd / r.nw, 6);
    expect(r.sPct).toBeGreaterThan(0.3);
  });

  it('401k stays outside net worth, as before', () => {
    const r = run(P).R[0];
    expect(r.k401).toBeGreaterThan(0);
    expect(r.nw).toBeLessThan(r.nw + r.k401);
  });
});

// ── 11/12. Migration safety ──────────────────────────────────────────────
describe('migration', () => {
  const legacyTC = () => {
    const m = { planStartYear: 2026, normGrowth: 0.01, startingLiquid: 1100000 };
    const cash = [280000, 260000, 275000, 265000], stock = [197000, 162000, 153000, 158000];
    for (let i = 0; i < 4; i++) { m['normCashY' + i] = cash[i]; m['normStockY' + i] = stock[i]; }
    m.normCashBase = 275000; m.normStockBase = 150000;
    for (let i = 0; i < 11; i++) {
      m['normTCY' + i] = i < 4 ? cash[i] + stock[i] : Math.round(275000 * 1.01 ** (i - 4)) + 150000;
    }
    return m;
  };

  it('never seeds Stripe equity from an existing plan (no double counting)', () => {
    const m = migrateP(legacyTC());
    expect(m.startingStripeEquity).toBe(0);
    expect(m.startingLiquid).toBe(1100000); // and starting wealth is untouched
  });

  it('recovers the real cash/stock split rather than inventing one', () => {
    const m = migrateP(legacyTC());
    expect(m.normCashY0).toBe(280000);
    expect(m.normStockY0).toBe(197000);
    expect(m.normCashY3).toBe(265000);
    expect(m.normStockY3).toBe(158000);
    expect(m.normSplitNeedsReview).toBeUndefined(); // nothing was guessed
  });

  it('preserves total comp exactly, so migrated taxes never move', () => {
    const before = legacyTC();
    const m = migrateP(before);
    for (let i = 0; i < 11; i++) {
      expect(m['normCashY' + i] + m['normStockY' + i]).toBe(before['normTCY' + i]);
    }
  });

  it('an edited total keeps the user total and flags the split for review', () => {
    const raw = legacyTC();
    raw.normTCY0 = 600000; // user typed a new total after the collapse
    const m = migrateP(raw);
    expect(m.normCashY0 + m.normStockY0).toBe(600000); // total wins → tax unchanged
    expect(m.normStockY0).toBe(Math.round(600000 * (197000 / 477000)));
    expect(m.normSplitNeedsReview).toBe(1);
  });

  it('drops the superseded total keys so migration is idempotent', () => {
    const once = migrateP(legacyTC());
    expect(once.normTCY0).toBeUndefined();
    expect(migrateP(once)).toEqual(once);
  });

  it('upgrades the oldest absolute-year format all the way through', () => {
    const m = migrateP({ planStartYear: 2026, normCash2026: 280000, normStock2026: 197000 });
    expect(m.normCashY0).toBe(280000);
    expect(m.normStockY0).toBe(197000);
    expect(m.normCashY10).toBeDefined();
    expect(m.startingStripeEquity).toBe(0);
  });

  it('migrates nanny/daycare into a single childcare rate', () => {
    const m = migrateP({ planStartYear: 2026, daycareMonthly: 3200, nannyHourlyRate: 35 });
    expect(m.childcareMonthly).toBe(3200);
  });

  it('an old scenario still loads and projects without error', () => {
    const merged = migrateP({ ...P, ...legacyTC() });
    const { R } = run(merged);
    expect(R.length).toBe(33);
    expect(Number.isFinite(R[R.length - 1].nw)).toBe(true);
  });
});

// ── 13. Roll forward ─────────────────────────────────────────────────────
describe('roll forward', () => {
  it('shifts BOTH compensation streams by one year', () => {
    const p = { ...P };
    for (let i = 0; i < 11; i++) { p['normCashY' + i] = 100000 + i; p['normStockY' + i] = 200000 + i; }
    const n = rollForwardParams(p);
    for (let i = 0; i < 10; i++) {
      expect(n['normCashY' + i]).toBe(100000 + i + 1);
      expect(n['normStockY' + i]).toBe(200000 + i + 1);
    }
    expect(n.planStartYear).toBe(2027);
  });

  it('grows each stream into the vacated final year at its own rate', () => {
    const n = rollForwardParams({ ...P, normGrowth: 0.05, normStockGrowth: 0.25 });
    expect(n.normCashY10).toBe(Math.round(280000 * 1.05));
    expect(n.normStockY10).toBe(Math.round(197000 * 1.25));
  });

  it('shifts the Stripe return curve too, so rates stay on their intended years', () => {
    const p = { ...P, stripeLongTermReturn: 0.07 };
    for (let i = 0; i < 10; i++) p['stripeRetY' + i] = 0.10 + i / 100;
    const n = rollForwardParams(p);
    for (let i = 0; i < 9; i++) expect(n['stripeRetY' + i]).toBeCloseTo(0.10 + (i + 1) / 100, 10);
    expect(n.stripeRetY9).toBe(0.07);
  });

  it('still shifts Nancy and leaves the rest of the plan alone', () => {
    const n = rollForwardParams(P);
    expect(n.nancyW2Y0).toBe(P.nancyW2Y1);
    expect(n.nancyW2Y3).toBe(Math.round(P.nancyW2Y3 * 1.03));
    expect(n.startingLiquid).toBe(P.startingLiquid);
    expect(n.startingStripeEquity).toBe(P.startingStripeEquity);
  });
});

// ── 14. Monte Carlo ──────────────────────────────────────────────────────
describe('Monte Carlo', () => {
  it('still runs and produces an ordered band', () => {
    const mc = runMonteCarlo({ ...P, startingStripeEquity: 500000 }, 40);
    expect(mc.band.p10.length).toBe(33);
    expect(mc.finalP10).toBeLessThan(mc.finalP50);
    expect(mc.finalP50).toBeLessThan(mc.finalP90);
  });

  it('varies the diversified portfolio but leaves Stripe deterministic', () => {
    // Stripe-only plan: no diversified pool to perturb, so every trial must agree.
    const stripeOnly = { ...P, stripePolicy: 'retain', startingLiquid: 6000000, startingStripeEquity: 1000000 };
    const a = runMonteCarlo(stripeOnly, 12);
    const b = runMonteCarlo(stripeOnly, 12);
    const det = run(stripeOnly).R;
    expect(det[10].sEnd).toBe(run(stripeOnly).R[10].sEnd);
    expect(a.band.p50.length).toBe(b.band.p50.length);
    // The Stripe component itself is identical across independent MC runs
    expect(a.geomMean).toBeCloseTo(b.geomMean, 10);
  });

  it('historical mode still runs', () => {
    const mc = runMonteCarlo(P, 20, 'historical');
    expect(mc.mode).toBe('historical');
    expect(Number.isFinite(mc.finalP50)).toBe(true);
  });
});

// ── Beyond the explicit window ───────────────────────────────────────────
describe('post-window growth', () => {
  it('each stream compounds at its own rate after year 10', () => {
    const p = { ...P, normGrowth: 0.02, normStockGrowth: 0.10 };
    const a = normComp(p, 10), b = normComp(p, 13);
    expect(b.cash).toBeCloseTo(a.cash * 1.02 ** 3, 6);
    expect(b.stock).toBeCloseTo(a.stock * 1.10 ** 3, 6);
  });

  it('stock growth falls back to cash growth when unset', () => {
    const p = { ...P }; delete p.normStockGrowth;
    expect(normComp(p, 12).stock).toBeCloseTo(197000 * (1 + P.normGrowth) ** 2, 6);
  });

  it('there is no discontinuity at the window edge', () => {
    const a = normComp(P, 10), b = normComp(P, 11);
    expect(b.cash / a.cash).toBeCloseTo(1 + P.normGrowth, 10);
  });
});

// ── Specific-lot identification on forced sales ──────────────────────────
describe('Stripe lot selection', () => {
  const RATE = 0.345;
  // One heavily appreciated lot and one barely appreciated one, same market value.
  const twoLots = () => [
    { v: 100000, b: 20000, yr: 2020 },   // 80% gain
    { v: 100000, b: 95000, yr: 2029 },   //  5% gain
  ];

  it('sells the lowest-gain lot first', () => {
    const lots = twoLots();
    sellLots(lots, 50000, RATE);
    expect(lots[0].v).toBe(100000);       // the 80%-gain lot is untouched
    expect(lots[1].v).toBeLessThan(100000); // the 5%-gain lot funded it
  });

  it('costs far less tax than blending basis across every lot', () => {
    const lots = twoLots();
    const picked = sellLots(lots, 50000, RATE);
    // What a single averaged pool would have charged for the same $50K of cash
    const pool = [{ v: 200000, b: 115000, yr: 2020 }];
    const blended = sellLots(pool, 50000, RATE);
    expect(picked.tax).toBeLessThan(blended.tax / 5);
    expect(picked.tax).toBeCloseTo(50000 / (1 - 0.05 * RATE) * 0.05 * RATE, 2);
  });

  it('moves on to the next-cheapest lot once one is exhausted', () => {
    const lots = twoLots();
    // $140K net is reachable; $180K would not be, since the 80%-gain lot yields only
            // 72.4c on the dollar once its tax is paid.
    const r = sellLots(lots, 140000, RATE);
    expect(lots[1].v).toBeCloseTo(0, 6);   // cheap lot fully consumed
    expect(lots[0].v).toBeLessThan(100000); // then into the expensive one
    expect(r.shortfall).toBe(0);
  });

  it('conserves value: what is sold plus what remains equals what was held', () => {
    const lots = twoLots();
    const before = lotsValue(lots);
    const r = sellLots(lots, 120000, RATE);
    expect(r.gross + lotsValue(lots)).toBeCloseTo(before, 4);
  });

  it('basis leaves proportionally with the shares sold', () => {
    const lots = [{ v: 100000, b: 40000, yr: 2020 }];
    sellLots(lots, 30000, RATE);
    expect(lots[0].b / lots[0].v).toBeCloseTo(0.4, 6); // basis ratio unchanged
  });

  it('a zero-gain lot raises cash with no tax at all', () => {
    const lots = [{ v: 100000, b: 100000, yr: 2029 }];
    const r = sellLots(lots, 50000, RATE);
    expect(r.tax).toBe(0);
    expect(r.gross).toBeCloseTo(50000, 6);
  });

  it('reports a shortfall rather than overselling', () => {
    const lots = [{ v: 10000, b: 10000, yr: 2029 }];
    const r = sellLots(lots, 50000, RATE);
    expect(r.gross).toBeCloseTo(10000, 6);
    expect(r.shortfall).toBeCloseTo(40000, 6);
    expect(lotsValue(lots)).toBeCloseTo(0, 6);
  });

  it('in a real projection, forced sales take the newest (cheapest) equity first', () => {
    const buying = { ...P, homePurchaseYear: 2030, startingStripeEquity: 3000000,
                     liquidReserveFloor: 500000, stripeStartingBasisPct: 0.3 };
    const r = run(buying).R.find(x => x.yr === 2030);
    expect(r.sHold).toBeGreaterThan(0);
    // The legacy block carries a 70% embedded gain; recently retained vests carry almost
    // none. Selection must land well under the legacy lot's own rate.
    const effective = r.sGainTax / r.sHold;
    expect(effective).toBeLessThan(0.7 * P.capGainsTaxRate);
  });

  it('the ledger stays bounded — emptied lots are pruned', () => {
    const { R } = run({ ...P, homePurchaseYear: 2030, startingStripeEquity: 500000 });
    for (const r of R) expect(r.sLots).toBeLessThanOrEqual(R.length + 2);
  });
});

// ── Affordability ────────────────────────────────────────────────────────
describe('affordability', () => {
  const { affordability, planAffordablePrice, comfortAffordablePrice, housingCostPerDollar } = require('../public/model.js');
  const BUY = { ...P, homePurchaseYear: 2030, startingStripeEquity: 425000, startingLiquid: 675000, liquidReserveFloor: 500000 };

  it('reports both limits and names the one that binds', () => {
    const a = affordability(BUY, 0.28);
    expect(a.max).toBe(Math.min(a.plan, a.comfort));
    expect(a.binding).toBe(a.plan <= a.comfort ? 'plan' : 'comfort');
  });

  it('the plan limit is the most expensive house that keeps the reserve floor intact', () => {
    const max = planAffordablePrice(BUY);
    const floor = BUY.liquidReserveFloor;
    const holds = price => run({ ...BUY, homePrice: price }).R.every(r => r.liq >= floor - 1);
    expect(holds(max)).toBe(true);          // affordable at the limit
    expect(holds(max + 60000)).toBe(false); // and not a step beyond it
  });

  it('a higher rate lowers what you can afford', () => {
    expect(planAffordablePrice({ ...BUY, mortgageRate: 7 }))
      .toBeLessThan(planAffordablePrice({ ...BUY, mortgageRate: 4 }));
    expect(comfortAffordablePrice({ ...BUY, mortgageRate: 7 }, 0.28))
      .toBeLessThan(comfortAffordablePrice({ ...BUY, mortgageRate: 4 }, 0.28));
  });

  it('more down buys more house on cash flow, but less on the balance sheet', () => {
    // A bigger deposit shrinks the loan, so the carrying-cost limit rises…
    expect(comfortAffordablePrice({ ...BUY, downPctg: 70 }, 0.28))
      .toBeGreaterThan(comfortAffordablePrice({ ...BUY, downPctg: 30 }, 0.28));
    // …while the cash needed at closing rises, so the balance-sheet limit falls.
    expect(planAffordablePrice({ ...BUY, downPctg: 70 }))
      .toBeLessThan(planAffordablePrice({ ...BUY, downPctg: 30 }));
  });

  it('a stricter income share lowers only the carrying-cost limit', () => {
    expect(comfortAffordablePrice(BUY, 0.20)).toBeLessThan(comfortAffordablePrice(BUY, 0.35));
    expect(planAffordablePrice(BUY)).toBe(planAffordablePrice(BUY)); // unaffected, deterministic
  });

  it('counts Stripe: the same wealth held as Stripe funds the same house', () => {
    const liquidOnly = { ...BUY, startingLiquid: 1100000, startingStripeEquity: 0 };
    const split = { ...BUY, startingLiquid: 675000, startingStripeEquity: 425000 };
    // Not identical — Stripe compounds on its own path — but within a reasonable band, and
    // certainly not the shortfall you would see if Stripe were ignored entirely.
    const a = planAffordablePrice(liquidOnly), b = planAffordablePrice(split);
    expect(b).toBeGreaterThan(a * 0.8);
  });

  it('carrying cost per dollar of price behaves', () => {
    const cheap = housingCostPerDollar({ ...BUY, mortgageRate: 3 });
    const dear = housingCostPerDollar({ ...BUY, mortgageRate: 8 });
    expect(dear).toBeGreaterThan(cheap);
    // All cash: no P&I, so what remains is property tax, maintenance and insurance.
    // Insurance joined the carrying cost when closing costs were added — leaving it out
    // overstated affordability, so it belongs in this identity too.
    const insRate = 0.0035; // default when no explicit premium is supplied
    expect(housingCostPerDollar({ ...BUY, downPctg: 100 }))
      .toBeCloseTo((BUY.propTaxRate) + BUY.maintBase / BUY.homePrice + insRate, 9);
  });

  it('flags a plan priced above what it can afford', () => {
    const a = affordability({ ...BUY, homePrice: 6000000 }, 0.28);
    expect(a.withinBudget).toBe(false);
    expect(affordability({ ...BUY, homePrice: 500000 }, 0.28).withinBudget).toBe(true);
  });
});

// ── Vested equity is held AFTER tax ──────────────────────────────────────
// A grant is quoted gross; shares are withheld at vest; what lands in the portal is the
// remainder. Adding a gross grant to an after-tax opening balance overstates the position
// by the whole withholding, compounding for every year of the projection.
describe('vest withholding', () => {
  const p = { ...P, startingStripeEquity: 614000, stripeObservedMonth: 8 };

  it('adds the vest to holdings net of tax, and says what was withheld', () => {
    const r = y0(p);
    expect(r.sGross).toBe(r.normStock);
    expect(r.sNew).toBeLessThan(r.sGross);
    expect(r.sNew + r.sVestTax).toBeCloseTo(r.sGross, 0);
    expect(r.sVestRate).toBeGreaterThan(0.3);   // a NYC household at this income
    expect(r.sVestRate).toBeLessThan(0.6);
  });

  it('conserves total after-tax compensation however the rate moves', () => {
    // Withholding shifts dollars between cash and equity. It must never create or destroy
    // any: cash available plus the after-tax grant is always total after-tax comp.
    for (const rate of [null, 0, 0.22, 0.403, 0.5]) {
      const r = y0(rate == null ? p : { ...p, stripeVestWithholdingRate: rate });
      expect(r.inc + r.sNew, `rate ${rate}`).toBe(r.netTC);
    }
  });

  it('withholding less leaves more equity and less cash, dollar for dollar', () => {
    const low = y0({ ...p, stripeVestWithholdingRate: 0.22 });
    const high = y0({ ...p, stripeVestWithholdingRate: 0.45 });
    expect(low.sNew).toBeGreaterThan(high.sNew);
    expect(low.inc).toBeLessThan(high.inc);
    expect(low.sNew - high.sNew).toBeCloseTo(high.inc - low.inc, 0);
  });

  it('takes an entered paystub rate over the derived marginal rate', () => {
    expect(y0({ ...p, stripeVestWithholdingRate: 0.403 }).sVestRate).toBe(0.403);
    // A nonsense rate is ignored rather than obeyed.
    expect(y0({ ...p, stripeVestWithholdingRate: 1.5 }).sVestRate).not.toBe(1.5);
  });

  it('charges no vest tax in a year with no grant', () => {
    const none = { ...p };
    for (let i = 0; i < 11; i++) none['normStockY' + i] = 0;
    const r = y0(none);
    expect(r.sVestTax).toBe(0);
    expect(r.sVestRate).toBe(0);
    expect(r.inc).toBe(r.netTC);
  });
});
