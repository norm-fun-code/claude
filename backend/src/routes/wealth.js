// Wealth router: lightweight net-worth snapshot (for external integrations),
// the plan-baseline comparison, and asset-allocation/concentration view.
// Twenty-third router extraction out of server.js's monolith (see the
// engineering review's #1+#6 recommendation) — a straight move, verified
// line-by-line against the original before removing it from server.js.
const express = require('express');
const metricsStore = require('../store/metrics');
const { asyncHandler } = require('../middleware/asyncHandler');

function createWealthRouter() {
  const router = express.Router();

  // Lightweight wealth snapshot for external integrations (e.g. a financial planner).
  // Returns the latest stored values for net worth and per-bucket totals.
  // 401k is NOT a separate metric — Monarch balance exports aggregate all accounts into
  // assets/liabilities/net_worth. To get a standalone 401k value, set MONARCH_401K_ACCOUNT
  // to the exact account name from your Monarch export (e.g. "Fidelity 401k") and
  // this endpoint will return it under `retirement`.
  router.get('/wealth/snapshot', asyncHandler(async (req, res) => {
    const [nw, assets, liabilities] = await Promise.all([
      metricsStore.latest({ domain: 'wealth', metric: 'net_worth' }),
      metricsStore.latest({ domain: 'wealth', metric: 'assets' }),
      metricsStore.latest({ domain: 'wealth', metric: 'liabilities' }),
    ]);

    // Optional: per-account 401k lookup if MONARCH_401K_ACCOUNT is set.
    // Requires the balance export to have been imported with per-account rows.
    const retirementMetric = process.env.MONARCH_401K_ACCOUNT
      ? `account_${process.env.MONARCH_401K_ACCOUNT.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
      : null;
    const retirement = retirementMetric
      ? await metricsStore.latest({ domain: 'wealth', metric: retirementMetric }).catch(() => null)
      : null;

    res.json({
      netWorth: nw ? { value: Math.round(Number(nw.value)), updatedAt: nw.ts } : null,
      assets: assets ? { value: Math.round(Number(assets.value)), updatedAt: assets.ts } : null,
      liabilities: liabilities ? { value: Math.round(Number(liabilities.value)), updatedAt: liabilities.ts } : null,
      retirement: retirement ? { value: Math.round(Number(retirement.value)), updatedAt: retirement.ts } : null,
    });
  }));

  // Plan baseline for "net worth vs. plan" comparison in the Wealth tab.
  // Returns the key starting-position figures from planner_state so the mobile
  // app can show actual NW vs. where the plan said you'd start.
  router.get('/wealth/plan', asyncHandler(async (req, res) => {
    const { loadPlan } = require('../services/financial-plan');
    const plan = await loadPlan(); // DB-first, falls back to financial-plan.json
    if (!plan || !plan.P) return res.json({ available: false });
    const P = plan.P;

    // Compute how far through the plan year we are, then pro-rate the
    // annual liquid growth to get today's expected liquid NW (the "pace").
    // This mirrors the Cohen Financial Planner's "Live Snapshot" calculation.
    const planYear = 2026;
    const yearStart = new Date(`${planYear}-01-01T00:00:00`);
    const yearEnd   = new Date(`${planYear + 1}-01-01T00:00:00`);
    const now       = new Date();
    const pctYear   = Math.min(1, Math.max(0,
      (now - yearStart) / (yearEnd - yearStart)
    ));
    const startingLiquid = P.startingLiquid ?? null;
    const growth2026     = P.planLiquidGrowth2026 ?? null;
    const planLiquidAtPace = startingLiquid != null && growth2026 != null
      ? Math.round(startingLiquid + growth2026 * pctYear)
      : null;

    res.json({
      available: true,
      startingLiquid,
      k401Start: P.k401Start ?? null,
      planLiquidGrowth2026: growth2026,
      planLiquidAtPace,
      pctYearElapsed: Math.round(pctYear * 100),
      planYear,
    });
  }));

  // Asset allocation + single-name concentration for the dedicated Asset Mix card.
  router.get('/wealth/allocation', asyncHandler(async (req, res) => {
    const monarchWealth = require('../services/monarch-wealth');
    const { computeAllocationView } = require('../intelligence/allocation');
    const [accountsData, investments] = await Promise.all([
      monarchWealth.getAccounts(),
      monarchWealth.getInvestments().catch(() => null),
    ]);
    const view = computeAllocationView(accountsData, { holdings: investments?.holdings || null });
    if (!view) return res.json({ available: false });
    res.json({ available: true, ...view });
  }));

  return router;
}

module.exports = { createWealthRouter };
