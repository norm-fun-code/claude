import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const L = require('../public/liquidity.js');
const M = require('../public/model.js');

// The household's confirmed arrangement: tenders in Q1 and Q4, plus a standing $20K/quarter
// cash election capped around $80K a year.
const P = {};
const ctx = { heldValue: 1000000, vestPerQuarter: 50000 };

describe('sale windows', () => {
  it('opens tenders only in Q1 and Q4', () => {
    const tenders = L.saleWindows(2030, ctx, P).filter(w => w.kind === 'tender');
    expect(tenders.map(w => w.quarter)).toEqual([1, 4]);
  });

  it('offers the elective cash-out in every quarter', () => {
    const elective = L.saleWindows(2030, ctx, P).filter(w => w.kind === 'elective');
    expect(elective.map(w => w.quarter)).toEqual([1, 2, 3, 4]);
    expect(elective.every(w => w.cap === 20000)).toBe(true);
  });

  it('caps the elective route at the annual allowance across all four quarters', () => {
    const total = L.saleWindows(2030, ctx, P)
      .filter(w => w.kind === 'elective').reduce((s, w) => s + w.cap, 0);
    expect(total).toBe(80000);
  });

  it('models no tender cap when none has been confirmed, and says so', () => {
    const t = L.saleWindows(2030, ctx, P).find(w => w.kind === 'tender');
    expect(t.cap).toBeGreaterThan(1000000);          // limited only by eligible stock
    expect(t.note).toMatch(/no participation cap has been confirmed/i);
  });

  it('honours a cap once one is supplied', () => {
    const t = L.saleWindows(2030, ctx, { stripeTenderCapPerEvent: 250000 }).find(w => w.kind === 'tender');
    expect(t.cap).toBe(250000);
  });

  it('opens everything once a liquidity event is modelled', () => {
    const w = L.saleWindows(2032, ctx, { stripeLiquidityFromYear: 2031 });
    expect(w.every(x => x.kind === 'open')).toBe(true);
    expect(L.freelyLiquid(2030, { stripeLiquidityFromYear: 2031 })).toBe(false);
  });
});

// ── The gap an annual total hides ────────────────────────────────────────
describe('timing, not just totals', () => {
  it('reaches far less by Q2 than the year as a whole', () => {
    const byQ2 = L.raisableBy(2030, 2, ctx, P);
    const full = L.raisableInYear(2030, ctx, P);
    expect(byQ2).toBeLessThan(full);
    // Q3 adds only the elective slice, because no tender runs until Q4
    expect(L.raisableBy(2030, 3, ctx, P) - byQ2).toBe(20000);
  });

  it('never lets cumulative sales exceed the stock actually eligible by then', () => {
    const thin = { heldValue: 30000, vestPerQuarter: 0 };
    for (let q = 1; q <= 4; q++) {
      expect(L.raisableBy(2030, q, thin, P)).toBeLessThanOrEqual(30000);
    }
  });

  it('counts a vest only from the quarter it lands', () => {
    const noHold = { heldValue: 0, vestPerQuarter: 25000 };
    expect(L.raisableBy(2030, 1, noHold, P)).toBeLessThanOrEqual(25000);
    expect(L.raisableBy(2030, 2, noHold, P)).toBeLessThanOrEqual(50000);
  });
});

// ── Funding boundaries ───────────────────────────────────────────────────
describe('funding a purchase', () => {
  const need = 1078750; // down payment plus closing and moving

  it('is fundable from a Q1 close when the tender is available', () => {
    const r = L.fundingCheck({ year: 2030, quarter: 1, need, ...ctx, otherCash: 100000 }, P);
    expect(r.fundable).toBe(true);
  });

  it('is NOT fundable from a Q2 close on the elective route alone', () => {
    // The classic trap: a spring closing with no tender until Q4.
    const r = L.fundingCheck({ year: 2030, quarter: 2, need, heldValue: 0, vestPerQuarter: 50000, otherCash: 100000 }, P);
    expect(r.fundable).toBe(false);
    expect(r.shortfall).toBeGreaterThan(0);
    expect(r.remedy).toMatch(/Q4 tender|portfolio/i);
  });

  it('names the next window rather than leaving the fix to be inferred', () => {
    const r = L.fundingCheck({ year: 2030, quarter: 2, need, heldValue: 0, vestPerQuarter: 10000 }, P);
    expect(r.nextWindow).toMatchObject({ quarter: 4, kind: 'tender' });
  });

  it('reports no further window when the year is out', () => {
    const r = L.fundingCheck({ year: 2030, quarter: 4, need: 5e6, ...ctx }, P);
    expect(r.fundable).toBe(false);
    expect(r.nextWindow).toBeNull();
    expect(r.remedy).toMatch(/no further Stripe window/i);
  });

  it('counts other cash toward the need without double counting Stripe', () => {
    const a = L.fundingCheck({ year: 2030, quarter: 2, need: 100000, heldValue: 0, vestPerQuarter: 0, otherCash: 100000 }, P);
    expect(a.fromStripe).toBe(0);
    expect(a.available).toBe(100000);
    expect(a.fundable).toBe(true);
  });

  it('defaults the closing quarter openly rather than inferring one', () => {
    expect(L.purchaseQuarter({})).toBe(2);
    expect(L.purchaseQuarter({ homePurchaseQuarter: 4 })).toBe(4);
  });
});

// ── Costs of buying ──────────────────────────────────────────────────────
describe('closing costs', () => {
  const p = { homePrice: 2000000, downPctg: 50, mortgageRate: 5, propTaxRate: 0.012, maintBase: 10000 };

  it('applies the NYC mansion tax band, not a flat rate', () => {
    expect(M.mansionTax(999000, {})).toBe(0);                 // below the threshold
    expect(M.mansionTax(1500000, {})).toBeCloseTo(15000, 6);  // 1.0% band
    expect(M.mansionTax(2000000, {})).toBeCloseTo(25000, 6);  // 1.25% band
  });

  it('charges mortgage recording tax on the loan, not the price', () => {
    const big = M.closingCosts(2000000, p);                       // $1M loan
    const allCash = M.closingCosts(2000000, { ...p, downPctg: 100 });
    expect(big.recording).toBeGreaterThan(0);
    expect(allCash.recording).toBe(0);                            // no loan, no tax
  });

  it('adds real money to the cash needed at closing', () => {
    const c = M.cashToClose(2000000, p);
    expect(c.down).toBe(1000000);
    expect(c.total).toBeGreaterThan(1050000);
    expect(c.total - c.down).toBeGreaterThan(70000); // what the old model ignored
  });

  it('lets every component be overridden', () => {
    const c = M.closingCosts(2000000, { ...p, mansionTaxRate: 0, titleInsuranceRate: 0, closingLegalFees: 0, closingOtherFees: 0 });
    expect(c.mansion).toBe(0);
    expect(c.total).toBeCloseTo(c.recording, 6);
  });

  it('includes insurance in the carrying cost', () => {
    const withIns = M.housingCostPerDollar(p);
    const without = M.housingCostPerDollar({ ...p, homeInsuranceRate: 0 });
    expect(withIns).toBeGreaterThan(without);
    expect(withIns - without).toBeCloseTo(0.0035, 6);
  });

  it('lowers what you can afford once insurance is counted', () => {
    // Supply the projection rows directly: this asserts the ratio maths, not a full run.
    const R = [{ yr: 2030, netTC: 309000 }];
    const withIns = M.comfortAffordablePrice({ ...p, homePurchaseYear: 2030 }, 0.28, R);
    const without = M.comfortAffordablePrice({ ...p, homePurchaseYear: 2030, homeInsuranceRate: 0 }, 0.28, R);
    expect(withIns).toBeLessThan(without);
    expect(withIns).toBeGreaterThan(0);
  });
});
