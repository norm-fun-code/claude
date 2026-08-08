import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { calcTax, run, runMonteCarlo, bracketTax } = require('../public/model.js');

// Minimal base params shared by most tests
const BASE = {
  planStartYear: 2026,
  pretax401k: 23500, pretaxBenefits: 11700,
  nancyQBIRate: 0.20, expenseInflation: 0.03, baseCharity: 0,
  homePurchaseYear: 2099, homePrice: 2000000, downPctg: 50, mortgageRate: 5.0,
  taxInflation: 0, // freeze brackets at 2026 for deterministic tests
};

// ── bracketTax sanity ──────────────────────────────────────────────────────
describe('bracketTax', () => {
  const FED = [[24800,.10],[100800,.12],[211400,.22],[403550,.24],[512450,.32],[731200,.35],[1e15,.37]];
  it('zero income → zero tax', () => expect(bracketTax(0, FED)).toBe(0));
  it('first bracket only', () => expect(bracketTax(20000, FED)).toBeCloseTo(2000, 0));
  it('crosses brackets', () => {
    const t = bracketTax(200000, FED);
    expect(t).toBeGreaterThan(24000);
    expect(t).toBeLessThan(50000);
  });
});

// ── calcTax: pure W2 household ────────────────────────────────────────────
describe('calcTax — W2 only', () => {
  const yr = 2026;
  it('itemizes when SALT alone ($40400) exceeds standard deduction ($32200)', () => {
    const p = { ...BASE, _normW2: 80000, _nancyW2: 0, _nancySE: 0, _nancyOverhead: 0 };
    const t = calcTax(80000, p, yr, 0);
    expect(t.deduction).toBe(40400); // SALT > std deduct → itemize
    expect(t.itemizing).toBe(true);
  });

  it('AGI = normW2 - pretax', () => {
    const p = { ...BASE, _normW2: 400000, _nancyW2: 0, _nancySE: 0, _nancyOverhead: 0 };
    const t = calcTax(400000, p, yr, 0);
    expect(t.agi).toBe(400000 - 23500 - 11700);
  });

  it('additional medicare on wages above $250K', () => {
    const p = { ...BASE, _normW2: 300000, _nancyW2: 0, _nancySE: 0, _nancyOverhead: 0 };
    const t = calcTax(300000, p, yr, 0);
    expect(t.fica).toBeGreaterThan(450);
  });

  it('net = gross - allInTax - pretax', () => {
    const p = { ...BASE, _normW2: 350000, _nancyW2: 0, _nancySE: 0, _nancyOverhead: 0 };
    const t = calcTax(350000, p, yr, 0);
    expect(t.net).toBe(Math.round(350000 - t.allInTax - (23500 + 11700)));
  });
});

// ── calcTax: solo practice (SE income) ───────────────────────────────────
describe('calcTax — SE income', () => {
  const yr = 2026;

  it('half SE tax deducted from AGI', () => {
    const nancySE = 200000;
    const p = { ...BASE, _normW2: 0, _nancyW2: 0, _nancySE: nancySE, _nancyOverhead: 0 };
    const t = calcTax(nancySE, p, yr, 0);
    const seBase = nancySE * 0.9235;
    const nancySS = Math.min(seBase, 184500) * 0.124;
    const nancyMed = seBase * 0.029;
    const expectedSeTaxHalf = 0.5 * (nancySS + nancyMed);
    const expectedAGI = Math.round(Math.max(0, nancySE - (23500 + 11700) - expectedSeTaxHalf));
    expect(t.agi).toBe(expectedAGI);
  });

  it('QBI reduces federal tax at low AGI', () => {
    const nancySE = 150000;
    const p = { ...BASE, _normW2: 0, _nancyW2: 0, _nancySE: nancySE, _nancyOverhead: 0 };
    const tWith = calcTax(nancySE, p, yr, 0);
    const tWithout = calcTax(nancySE, { ...p, nancyQBIRate: 0 }, yr, 0);
    expect(tWith.federal).toBeLessThan(tWithout.federal);
    expect(tWith.qbi).toBeGreaterThan(0);
  });

  it('QBI fully phases out above ~$484K AGI', () => {
    const nancySE = 700000;
    const p = { ...BASE, _normW2: 0, _nancyW2: 0, _nancySE: nancySE, _nancyOverhead: 0 };
    const t = calcTax(nancySE, p, yr, 0);
    expect(t.qbi).toBe(0);
  });

  it('schedule C overhead reduces net cash take-home', () => {
    const nancySEGross = 300000;
    const overhead = 25000;
    const p = { ...BASE, _normW2: 0, _nancyW2: 0, _nancySE: nancySEGross - overhead, _nancyOverhead: overhead };
    const t = calcTax(nancySEGross, p, yr, 0);
    expect(t.net).toBe(Math.round(nancySEGross - t.allInTax - (23500 + 11700) - overhead));
  });
});

// ── calcTax: SALT cap and phaseout ────────────────────────────────────────
describe('calcTax — SALT', () => {
  const yr = 2026;

  it('SALT floor = $10K at very high AGI', () => {
    const p = { ...BASE, _normW2: 2000000, _nancyW2: 0, _nancySE: 0, _nancyOverhead: 0 };
    const t = calcTax(2000000, p, yr, 0);
    expect(t.saltCap).toBe(10000);
  });

  it('SALT = $40400 at low-moderate AGI (no phaseout)', () => {
    const p = { ...BASE, _normW2: 300000, _nancyW2: 0, _nancySE: 0, _nancyOverhead: 0 };
    const t = calcTax(300000, p, yr, 0);
    expect(t.saltCap).toBe(40400);
  });
});

// ── calcTax: Child Tax Credit ─────────────────────────────────────────────
describe('calcTax — CTC', () => {
  const yr = 2026;
  const p = { ...BASE, _normW2: 300000, _nancyW2: 0, _nancySE: 0, _nancyOverhead: 0 };

  it('3 kids at moderate income → $6600 CTC reduction', () => {
    const tWith = calcTax(300000, p, yr, 3);
    const tNone = calcTax(300000, p, yr, 0);
    expect(tNone.federal - tWith.federal).toBeCloseTo(6600, -1);
  });

  it('CTC reduced above $400K AGI', () => {
    const highP = { ...BASE, _normW2: 700000, _nancyW2: 0, _nancySE: 0, _nancyOverhead: 0 };
    const tWith = calcTax(700000, highP, yr, 3);
    const tNone = calcTax(700000, highP, yr, 0);
    expect(tNone.federal - tWith.federal).toBeLessThan(6600);
  });
});

// ── calcTax: bracket inflation ────────────────────────────────────────────
describe('calcTax — bracket inflation', () => {
  it('inflated brackets → lower federal tax on same nominal income', () => {
    const income = 400000;
    const p = { ...BASE, _normW2: income, _nancyW2: 0, _nancySE: 0, _nancyOverhead: 0, taxInflation: 0.025 };
    const t2026 = calcTax(income, p, 2026, 0);
    const t2036 = calcTax(income, p, 2036, 0);
    expect(t2036.federal).toBeLessThan(t2026.federal);
  });

  it('taxInflation=0 → identical brackets across years', () => {
    const income = 400000;
    const p = { ...BASE, _normW2: income, _nancyW2: 0, _nancySE: 0, _nancyOverhead: 0 };
    const t2026 = calcTax(income, p, 2026, 0);
    const t2030 = calcTax(income, p, 2030, 0);
    expect(t2026.deduction).toBe(t2030.deduction);
  });
});

// ── run(): full projection sanity ─────────────────────────────────────────
describe('run()', () => {
  const P_FULL = {
    ...BASE,
    taxInflation: 0.025,
    kid1Birth: 2027, kid2Birth: 2030, kid3Birth: 2034, numKids: 3,
    childcareMonthly: 2800,
    tuitionInflation: 0.035, yeshivaStartAge: 2, yeshivaEndAge: 17, kid1YeshivaStartAge: 3,
    startingLiquid: 1100000, nycRent: 5500,
    normTCY0: 477000, normTCY1: 422000, normTCY2: 428000, normTCY3: 423000,
    normTCY4: 427000, normTCY5: 432000, normTCY6: 436000, normTCY7: 440000,
    normTCY8: 445000, normTCY9: 449000, normTCY10: 454000, normGrowth: 0.01,
    company401kMatch: 8750, k401Start: 210000,
    nancyW2Y0: 130000, nancyW2Y1: 80000, nancyW2Y2: 100000, nancyW2Y3: 75000,
    nancyHourlyRate: 300, nancyRampYear: 2030, nancyRampClients: 5,
    nancyMaxClients: 18, nancyRampYears: 6, nancyWeeksPerYear: 46,
    nancySoloPractice: 1, nancyPracticeOverhead: 15000, nancyHomeOfficeDeduct: 8000, nancyQBIRate: 0.20,
    baseGroceries: 7000, baseDining: 14000, baseShopping: 22000, baseVacations: 20000,
    baseAuto: 3500, baseInsurance: 1500, baseMisc: 10000, baseEntertainment: 4500,
    baseCharity: 8500, baseMedical: 4500, baseTransit: 4000, baseUtilsPhoneNet: 5500,
    expenseInflation: 0.03, postKidVacations: 10000,
    homePrice: 2000000, downPctg: 50, mortgageRate: 5.0, homePurchaseYear: 2030,
    propTaxBase: 18000, maintBase: 10000, homeAppreciation: 0.03,
    suburbAutoBoost: 3500, suburbInsBoost: 1500, suburbUtilBoost: 2500,
    investReturn: 0.06, capGainsTaxRate: 0.345, costBasisPct: 0.55, mcVol: 0.14,
  };

  it('returns rows from planStartYear to planEndYear', () => {
    const { R } = run(P_FULL);
    expect(R[0].yr).toBe(2026);
    expect(R[R.length - 1].yr).toBe(2058);
    expect(R.length).toBe(33); // 2026-2058 inclusive
  });

  it('respects custom planEndYear', () => {
    const { R } = run({ ...P_FULL, planEndYear: 2050 });
    expect(R[R.length - 1].yr).toBe(2050);
    expect(R.length).toBe(25); // 2026-2050 inclusive
  });

  it('net worth = liquid + equity (within $1 rounding tolerance)', () => {
    const { R } = run(P_FULL);
    for (const r of R) {
      expect(Math.abs(r.nw - (r.liq + r.eq))).toBeLessThanOrEqual(1);
    }
  });

  it('equity is 0 before home purchase, positive after', () => {
    const { R } = run(P_FULL);
    const r2029 = R.find(r => r.yr === 2029);
    const r2030 = R.find(r => r.yr === 2030);
    expect(r2029.eq).toBe(0);
    expect(r2030.eq).toBeGreaterThan(0);
  });

  it('tuition base year uses planStartYear not 2026 (C4 fix)', () => {
    const p2028 = { ...P_FULL, planStartYear: 2028 };
    const { R: R28 } = run(p2028);
    const { R: R26 } = run(P_FULL);
    // Both run to 2058; compare tuition in a year where kid1 is in school
    // kid1Birth=2027, age=4 in 2031, yeshivaStartAge=3 → in school
    const r28 = R28.find(r => r.yr === 2031);
    const r26 = R26.find(r => r.yr === 2031);
    // p2028 has 3 years of tuition inflation, p2026 has 5 years → p2028 < p2026
    expect(r28.tu).toBeLessThan(r26.tu);
  });

  it('401k grows every year', () => {
    const { R } = run(P_FULL);
    for (let i = 1; i < R.length; i++) {
      expect(R[i].k401).toBeGreaterThan(R[i - 1].k401);
    }
  });

  it('effective tax rate is 25–50% in year 1 at ~$600K gross', () => {
    const { R } = run(P_FULL);
    const r0 = R[0];
    expect(r0.effRate).toBeGreaterThan(0.25);
    expect(r0.effRate).toBeLessThan(0.50);
  });
});

// ── runMonteCarlo(): structure checks ─────────────────────────────────────
describe('runMonteCarlo()', () => {
  const P_MC = {
    planStartYear: 2026, taxInflation: 0,
    kid1Birth: 2027, numKids: 1,
    childcareMonthly: 2800,
    tuitionInflation: 0.035, yeshivaStartAge: 2, yeshivaEndAge: 17, kid1YeshivaStartAge: 3,
    startingLiquid: 1100000, nycRent: 5500,
    normTCY0: 477000, normTCY1: 422000, normTCY2: 428000, normTCY3: 423000,
    normTCY4: 427000, normTCY5: 432000, normTCY6: 436000, normTCY7: 440000,
    normTCY8: 445000, normTCY9: 449000, normTCY10: 454000, normGrowth: 0.01,
    pretax401k: 23500, pretaxBenefits: 11700, company401kMatch: 8750, k401Start: 210000,
    nancyW2Y0: 130000, nancyW2Y1: 80000, nancyW2Y2: 100000, nancyW2Y3: 75000,
    nancyHourlyRate: 300, nancyRampYear: 2030, nancyRampClients: 5,
    nancyMaxClients: 18, nancyRampYears: 6, nancyWeeksPerYear: 46,
    nancySoloPractice: 1, nancyPracticeOverhead: 15000, nancyHomeOfficeDeduct: 8000, nancyQBIRate: 0.20,
    baseGroceries: 7000, baseDining: 14000, baseShopping: 22000, baseVacations: 20000,
    baseAuto: 3500, baseInsurance: 1500, baseMisc: 10000, baseEntertainment: 4500,
    baseCharity: 8500, baseMedical: 4500, baseTransit: 4000, baseUtilsPhoneNet: 5500,
    expenseInflation: 0.03, postKidVacations: 10000,
    homePurchaseYear: 2030, homePrice: 2000000, downPctg: 50, mortgageRate: 5.0,
    propTaxBase: 18000, maintBase: 10000, homeAppreciation: 0.03,
    suburbAutoBoost: 3500, suburbInsBoost: 1500, suburbUtilBoost: 2500,
    investReturn: 0.06, capGainsTaxRate: 0.345, costBasisPct: 0.55, mcVol: 0.14,
  };

  it('band has one entry per projection year', () => {
    const mc = runMonteCarlo(P_MC, 50);
    expect(mc.band.p10.length).toBe((P_MC.planEndYear || 2058) - 2026 + 1);
  });

  it('p10 < p50 < p90 at final year', () => {
    const mc = runMonteCarlo(P_MC, 100);
    expect(mc.finalP10).toBeLessThan(mc.finalP50);
    expect(mc.finalP50).toBeLessThan(mc.finalP90);
  });

  it('ruinPct is a valid percentage', () => {
    const mc = runMonteCarlo(P_MC, 50);
    expect(mc.ruinPct).toBeGreaterThanOrEqual(0);
    expect(mc.ruinPct).toBeLessThanOrEqual(100);
  });
});
