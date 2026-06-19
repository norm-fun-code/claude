// Norm's long-range financial plan — base parameters + household context.
// Used to ground the NormOS chat advisor so it can answer forward-looking
// questions ("can we afford $2M in 2030?", "when does Nancy's practice break
// even?") from the same model the Cohen Financial Planner runs.
//
// Source: reads LIVE from the planner_state table (same Railway PostgreSQL DB
// shared with the Cohen Financial Planner). Falls back to financial-plan.json
// if the table is missing or empty (e.g. local dev without the planner).

const path = require('path');
const { pool } = require('../db');

const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');

/** Load plan params: DB first, static JSON fallback. */
async function loadPlan() {
  try {
    const result = await pool.query('SELECT state FROM planner_state WHERE id = 1');
    if (result.rows.length && result.rows[0].state && result.rows[0].state.P) {
      return result.rows[0].state; // { P: {...}, ... }
    }
  } catch (err) {
    // Table may not exist in local dev — fall through to static file
  }
  // Fallback: static snapshot checked into the repo
  return require('./financial-plan.json');
}

/** Build a compact but complete narrative of the plan from the base parameters. */
async function buildPlanContext() {
  try {
    const plan = await loadPlan();
    const P = plan.P;
    if (!P) return null;

    // Norm's income — cash + RSU stock by year
    const incomeLines = [];
    for (const yr of [2026, 2027, 2028, 2029]) {
      const cash = P[`normCash${yr}`];
      const stock = P[`normStock${yr}`];
      if (cash || stock) {
        incomeLines.push(`  ${yr}: Norm gross ${fmt((cash || 0) + (stock || 0))} (${fmt(cash || 0)} cash + ${fmt(stock || 0)} RSUs)`);
      }
    }
    // Nancy's W2 + practice trajectory
    const nancyLines = [];
    for (const yr of [2026, 2027, 2028, 2029]) {
      const w2 = P[`nancyW2_${yr}`];
      if (w2) nancyLines.push(`  ${yr}: Nancy W2 ${fmt(w2)}`);
    }
    if (P.nancyRampYear) {
      const peakGross = P.nancyMaxClients * P.nancyHourlyRate * P.nancyWeeksPerYear;
      nancyLines.push(
        `  ${P.nancyRampYear}+: Solo practice @ $${P.nancyHourlyRate}/hr, ramps ${P.nancyRampClients}→${P.nancyMaxClients} clients over ${P.nancyRampYears}yr, peak gross ~${fmt(peakGross)}`
      );
    }

    const pretaxTotal = (P.pretax401k || 0) + (P.pretaxBenefits || 0);
    const homeDown = (P.homePrice || 0) * (P.downPctg || 0) / 100;
    const homeMortgage = (P.homePrice || 0) - homeDown;

    const kidsText = (() => {
      const births = [P.kid1Birth, P.kid2Birth, P.kid3Birth, P.kid4Birth].filter(Boolean).slice(0, P.numKids || 3);
      return `${P.numKids || 3} kids planned, births: ${births.join(', ')}`;
    })();

    // Named scenarios (just names — the params are in the DB if needed)
    const scenarioNames = Array.isArray(plan.scenarios)
      ? plan.scenarios.map((s) => s.name).join(', ')
      : 'Base Case';

    return `FINANCIAL PLAN (Norm Cohen — long-range model):

INCOME
${incomeLines.join('\n')}
  Pre-tax deductions: 401k ${fmt(P.pretax401k || 0)} + benefits ${fmt(P.pretaxBenefits || 0)} = ${fmt(pretaxTotal)} (+ company match ${fmt(P.company401kMatch || 0)})
${nancyLines.join('\n')}

STARTING POSITION (2026)
  Liquid NW: ${fmt(P.startingLiquid || 0)}
  Fidelity: ~$509K (FXAIX $347K, MU $44K, MSFT $35K, GOOG $31K, TSM $30K, CRWV $13K)
  Crypto: ~$36K (SOL $15.5K, ETH $10.5K, LINK $10.3K — no BTC by choice)
  Stripe RSUs: ~$555K (earmarked for Brooklyn down payment, NOT investable)
  401k: ~${fmt(P.k401Start || 210000)} starting balance
  Private investments: ~$42K

HOME PURCHASE PLAN
  Target: ${fmt(P.homePrice || 0)} (${P.downPctg || 0}% down = ${fmt(homeDown)}) in ${P.homePurchaseYear || 2030}
  Mortgage: ${fmt(homeMortgage)} @ ${P.mortgageRate || 5}% 30yr
  Property tax: ~${fmt((P.propTaxBase || 20000))} base, +${P.homeAppreciation*100 || 3}%/yr with appreciation
  Post-purchase expenses: +${fmt((P.suburbAutoBoost || 0) + (P.suburbInsBoost || 0) + (P.suburbUtilBoost || 0))}/yr suburb premium (auto, insurance, utilities)
  Currently: UES (500 E 77th, lease through 2029). Planning Brooklyn/Midwood move.

KIDS & TUITION (Barkai schools)
  ${kidsText}
  Yeshiva: Orot/Ganon (ages ${P.yeshivaStartAge}+), Kid 1 enters Ganon at age ${P.kid1YeshivaStartAge}
  Rates (2026): ~$12-14K (Ganon), $25K (K), $32K (1-5th), $36K (6-8th), $40K (HS)
  Tuition inflation: ${((P.tuitionInflation || 0.03) * 100).toFixed(1)}%/yr
  Childcare: Nanny ${P.nannyDaysPerWeek || 5}d/wk @ $${P.nannyHourlyRate || 40}/hr until age ${P.nannyEndAge || 2}, then daycare ${fmt(P.daycareMonthly || 3000)}/mo

BASE EXPENSES (annual, pre-inflation)
  Rent: ${fmt(P.nycRent * 12 || 0)} (NYC, until home purchase)
  Groceries: ${fmt(P.baseGroceries || 0)} | Dining: ${fmt(P.baseDining || 0)} | Shopping: ${fmt(P.baseShopping || 0)}
  Vacations: ${fmt(P.baseVacations || 0)} (drops to ${fmt(P.postKidVacations || 0)} with kids) | Charity: ${fmt(P.baseCharity || 0)}
  Medical: ${fmt(P.baseMedical || 0)} | Entertainment: ${fmt(P.baseEntertainment || 0)} | Auto: ${fmt(P.baseAuto || 0)}
  Expense inflation: ${((P.expenseInflation || 0.03) * 100).toFixed(1)}%/yr

PORTFOLIO & TAX ASSUMPTIONS
  Portfolio return: ${((P.investReturn || 0.065) * 100).toFixed(1)}%/yr (deliberately conservative vs 10% historical)
  Cap gains rate all-in NYC: ${((P.capGainsTaxRate || 0.238) * 100).toFixed(1)}%
  Cost basis on stock sales: ${((P.costBasisPct || 0.55) * 100).toFixed(0)}%
  Stripe RSUs = down payment capital only, pre-establish post-IPO diversification plan before liquidity
  Core/satellite: ~65% FXAIX index, ~35% high-conviction names
  Active tax-loss harvesting on FXAIX lots; wash sale doesn't apply to crypto (TLH freely)

NANCY SOLO PRACTICE CONTEXT
  QBI deduction: ${((P.nancyQBIRate || 0.2) * 100).toFixed(0)}% + home office ${fmt(P.nancyHomeOfficeDeduct || 8000)} + overhead ${fmt(P.nancyPracticeOverhead || 0)}
  Solo practice status: YES — meaningfully reduces effective tax rate vs W2

NAMED SCENARIOS IN PLAN: ${scenarioNames}`;
  } catch (err) {
    console.error('[financial-plan] context build failed:', err.message);
    return null;
  }
}

module.exports = { buildPlanContext, loadPlan };
