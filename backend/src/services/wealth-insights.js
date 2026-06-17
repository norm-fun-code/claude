// Wealth insights: spending patterns vs your own usual, and vs Monarch budgets.
// Pure-ish — pulls category spend from stored Monarch transaction docs, and (if
// a Monarch token is available) this month's budget targets. Produces short,
// plain-language insight strings for the Wealth tab.
const documents = require('../store/documents');
const metricsStore = require('../store/metrics');
const { computeSubscriptionInsights } = require('../intelligence/subscriptions');
const { isInternalTransfer } = require('../connectors/monarch');
const stats = require('../intelligence/stats');
const monarchWealth = require('./monarch-wealth');

const MIN_SPEND = 50;       // ignore trivially small categories
const SPIKE_RATIO = 1.15;   // 15%+ over your usual is noteworthy
const SPIKE_DOLLARS = 100;  // ...and at least $100 more, so it's material
const OVER_BUDGET = 1.05;  // 5%+ over budget is noteworthy
const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
const pct = (n) => Math.round(n) + '%';

/**
 * Build wealth insight lines. Returns [{ type, title, detail }].
 *  - "vs usual": current-month category spend vs the avg of prior full months.
 *  - "vs budget": current-month actual vs Monarch's planned amount per category.
 */
async function buildWealthInsights() {
  const insights = [];

  // 0) Savings rate — the single most important personal-finance number:
  // (income − spending) / income over the trailing 30 days. Only surfaced when
  // there's real income to divide by.
  try {
    const from = new Date(Date.now() - 30 * 864e5);
    const sumOf = async (metric) => {
      const rows = await metricsStore.dailyAggregate({ domain: 'wealth', metric, from, agg: 'sum', excludeSource: 'seed' });
      return rows.reduce((a, r) => a + Number(r.value || 0), 0);
    };
    const [income, spending] = await Promise.all([sumOf('income'), sumOf('spending')]);
    if (income >= MIN_SPEND) {
      const rate = (income - spending) / income; // can be negative (overspending)
      const ratePct = Math.round(rate * 100);
      const positive = rate >= 0;
      insights.push({
        type: 'savings_rate',
        title: positive
          ? `Saving ${ratePct}% of income (30d)`
          : `Spending ${Math.abs(ratePct)}% more than you earned (30d)`,
        detail: positive
          ? `Over the last 30 days you brought in ${fmt(income)} and spent ${fmt(spending)} — a savings rate of ${ratePct}%. ${ratePct >= 20 ? 'Strong — at or above the 20% rule of thumb.' : 'Below the common 20% target; small cuts compound.'}`
          : `Over the last 30 days you spent ${fmt(spending)} against ${fmt(income)} of income — drawing down savings. Worth a look at the biggest categories.`,
      });
    }
  } catch (err) {
    console.error('[wealth-insights] savings rate failed:', err.message);
  }

  // 1) Spend vs your usual, from stored transactions.
  let rows = [];
  try {
    // Exclude internal transfers / card payments so the category breakdown
    // matches the spending metric (which already excludes them). Filtered here
    // rather than in the store helper so diagnostics can still see raw rows.
    rows = (await documents.monthlyCategorySpend({ months: 4 }))
      .filter((r) => !isInternalTransfer(r.category));
  } catch (err) {
    console.error('[wealth-insights] category spend failed:', err.message);
  }

  if (rows.length) {
    const months = [...new Set(rows.map((r) => r.month))].sort(); // ascending
    const current = months[months.length - 1];
    const priorMonths = months.slice(0, -1);

    // The current month is partial (e.g. day 1 of June). Comparing its
    // run-rate against FULL prior months would flag everything as "down" early
    // and exaggerate spikes late. So project the current month to a full-month
    // equivalent by day-of-month, and only trust the projection once enough of
    // the month has elapsed that the run-rate is meaningful.
    const now = new Date();
    const currentIsThisMonth =
      current === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const projFactor = currentIsThisMonth ? daysInMonth / dayOfMonth : 1;
    // Need ~a week of data before a run-rate projection is worth surfacing.
    const projectionReliable = !currentIsThisMonth || dayOfMonth >= 7;

    // category -> { current, priors: [] }
    const byCat = new Map();
    for (const r of rows) {
      const slot = byCat.get(r.category) || { current: 0, priors: [] };
      if (r.month === current) slot.current = r.spend;
      else if (priorMonths.includes(r.month)) slot.priors.push(r.spend);
      byCat.set(r.category, slot);
    }

    const spikes = [];
    for (const [category, s] of byCat) {
      if (!s.priors.length) continue;
      const avg = s.priors.reduce((a, b) => a + b, 0) / s.priors.length;
      if (avg < MIN_SPEND) continue;
      // Project the partial month to a full-month run-rate for a fair compare.
      const projected = s.current * projFactor;
      if (projected < MIN_SPEND) continue;
      const ratio = projected / avg;
      if (ratio >= SPIKE_RATIO && projected - avg >= SPIKE_DOLLARS) {
        spikes.push({ category, current: s.current, projected, avg, over: pct((ratio - 1) * 100) });
      }
    }
    // Only surface run-rate spikes once the month is far enough along to trust.
    if (projectionReliable) {
      // Biggest dollar overages first, top 3.
      spikes.sort((a, b) => (b.projected - b.avg) - (a.projected - a.avg));
      const projected = currentIsThisMonth && projFactor > 1.05;
      for (const s of spikes.slice(0, 3)) {
        insights.push({
          type: 'spending_pattern',
          title: `${s.category} trending ${s.over} above your usual`,
          detail: projected
            ? `You've spent ${fmt(s.current)} on ${s.category} so far this month — on pace for about ${fmt(s.projected)}, roughly ${s.over} above your recent average of ${fmt(s.avg)}.`
            : `You've spent ${fmt(s.current)} on ${s.category} this month — about ${s.over} more than your recent average of ${fmt(s.avg)}.`,
        });
      }
    }
  }

  // 1b) Subscriptions — authoritative from Monarch recurring streams when available,
  // heuristic fallback from stored transactions otherwise.
  try {
    const recurring = await monarchWealth.getRecurring();
    if (recurring) {
      const active = recurring.expenses;
      if (active.length) {
        const totalMonthly = Math.round(recurring.totalMonthlyExpense);
        const totalAnnual = Math.round(recurring.totalAnnualExpense);
        insights.push({
          type: 'subscriptions',
          title: `${active.length} recurring charges ≈ ${fmt(totalMonthly)}/mo`,
          detail:
            `Monarch tracks ${active.length} recurring expenses totaling ${fmt(totalMonthly)}/month (${fmt(totalAnnual)}/yr). ` +
            `Top: ${active.slice(0, 3).map((s) => `${s.name} (${fmt(s.monthly)}/mo)`).join(', ')}.`,
          evidence: { kind: 'subscriptions', count: active.length, totalAnnual, totalMonthly, items: active.slice(0, 10) },
        });
        const big = active.find((s) => s.annual >= 200);
        if (big) {
          insights.push({
            type: 'subscription_review',
            title: `Review: ${big.name} is ${fmt(big.annual)}/yr`,
            detail: `${big.name} bills ${fmt(big.amount)} ${big.frequency} — about ${fmt(big.annual)} a year. Worth confirming it's still earning its keep.`,
            evidence: { kind: 'subscription_review', merchant: big.name, annual: big.annual },
          });
        }
      }
    } else {
      // Fallback: heuristic detection from stored transactions.
      const txns = (await documents.spendTransactions({ days: 150 }))
        .filter((t) => !isInternalTransfer(t.category));
      if (txns.length) {
        for (const s of computeSubscriptionInsights(txns)) insights.push(s);
      }
    }
  } catch (err) {
    console.error('[wealth-insights] subscriptions failed:', err.message);
  }

  // 1c) Net-worth trajectory — project the trend to year-end (Wealthfront "Path"
  // style), so you see where you're heading at the current rate.
  try {
    const from = new Date(Date.now() - 120 * 864e5);
    const nw = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'net_worth', from, agg: 'avg', excludeSource: 'seed' });
    const series = nw.map((r) => ({ day: r.day, value: Number(r.value) })).filter((p) => Number.isFinite(p.value));
    if (series.length >= 8) {
      // Fit against real calendar days → a true per-day slope.
      const fit = stats.fitByDay(series);
      const current = series[series.length - 1].value;
      const perDay = fit && fit.slope != null ? fit.slope : 0;
      const daysToYearEnd = Math.max(0, (new Date(new Date().getFullYear(), 11, 31) - new Date()) / 864e5);
      const projected = current + perDay * daysToYearEnd;
      const monthlyChange = perDay * 30;
      if (Math.abs(monthlyChange) >= 50) {
        const dir = monthlyChange >= 0 ? 'growing' : 'declining';
        insights.push({
          type: 'net_worth_path',
          title: `Net worth ${dir} ~${fmt(Math.abs(monthlyChange))}/mo`,
          detail:
            `Based on your 4-month trend, net worth is ${dir} about ${fmt(Math.abs(monthlyChange))}/month — ` +
            `on track for roughly ${fmt(projected)} by year-end (now ${fmt(current)}). A projection from trend, not a guarantee.`,
          evidence: { kind: 'net_worth_path', current: Math.round(current), projected: Math.round(projected), monthlyChange: Math.round(monthlyChange) },
        });
      }
    }
  } catch (err) {
    console.error('[wealth-insights] net-worth path failed:', err.message);
  }

  // 3) Budget pacing vs Monarch's planned amounts (live, no legacy token needed).
  try {
    const pacing = await monarchWealth.getBudgetPacing();
    if (pacing && pacing.lines.length) {
      // Categories paid as a single monthly lump sum — pace extrapolation doesn't apply.
      const LUMP_SUM = new Set(['Rent', 'Mortgage', 'Rent & Utilities']);

      // Daily-spend categories: flag if spending 30%+ faster than the month is progressing.
      const overPace = pacing.lines.filter((l) => {
        if (l.overBudget) return true;
        if (LUMP_SUM.has(l.category)) return false;
        return l.pace >= 1.3;
      });
      for (const l of overPace.slice(0, 3)) {
        const status = l.overBudget
          ? `over budget (${fmt(l.actual)} of ${fmt(l.budget)})`
          : `on pace to overspend — ${pct((l.pace - 1) * 100)} ahead of schedule`;
        insights.push({
          type: 'over_budget',
          title: `${l.category}: ${status}`,
          detail:
            `${l.category}: ${fmt(l.actual)} spent of ${fmt(l.budget)} budget (day ${pacing.dayOfMonth}/${pacing.daysInMonth}). ` +
            (l.overBudget
              ? `Already ${fmt(Math.abs(l.remaining))} over.`
              : `Spending ${pct((l.pace - 1) * 100)} faster than the month is elapsing.`),
          evidence: { kind: 'budget_pacing', category: l.category, budget: l.budget, actual: l.actual, pace: l.pace, overBudget: l.overBudget },
        });
      }

      // Lump-sum categories: compare actual vs budget directly.
      const lumpSumPaid = pacing.lines.filter((l) => LUMP_SUM.has(l.category) && l.actual > 0);
      for (const l of lumpSumPaid) {
        if (l.overBudget) {
          insights.push({
            type: 'over_budget',
            title: `${l.category}: over budget (${fmt(l.actual)} of ${fmt(l.budget)})`,
            detail: `${l.category}: paid ${fmt(l.actual)} vs ${fmt(l.budget)} budget — ${fmt(Math.abs(l.remaining))} over.`,
            evidence: { kind: 'budget_pacing', category: l.category, budget: l.budget, actual: l.actual, lumpSum: true },
          });
        } else {
          insights.push({
            type: 'under_budget',
            title: `${l.category}: ${fmt(l.actual)} of ${fmt(l.budget)} budget — under by ${fmt(l.remaining)}`,
            detail: `${l.category}: paid ${fmt(l.actual)} vs ${fmt(l.budget)} budget this month — ${fmt(l.remaining)} under budget.`,
            evidence: { kind: 'budget_pacing', category: l.category, budget: l.budget, actual: l.actual, lumpSum: true },
          });
        }
      }
    }
  } catch (err) {
    console.error('[wealth-insights] budget pacing failed:', err.message);
  }

  // 4) Investment performance (7-day window from Monarch).
  //    Suppress when periodChange rounds to $0 — Monarch sometimes returns no
  //    period_change_dollars (e.g. when the date range has no prior snapshot),
  //    giving a misleading "up $0 (0.0%)" that looks broken.
  try {
    const inv = await monarchWealth.getInvestments();
    if (inv && inv.totalValue > 0) {
      const hasPerformance = Math.abs(inv.periodChange) >= 10;
      if (hasPerformance) {
        const dir = inv.periodChange >= 0 ? 'up' : 'down';
        const absPct = Math.abs(inv.periodChangePct).toFixed(1);
        const gainLine = inv.topGainers.length
          ? ` Top gainer: ${inv.topGainers[0].ticker || 'unknown'} +${fmt(inv.topGainers[0].periodChange)}.`
          : '';
        const loseLine = inv.topLosers.length && inv.topLosers[0].periodChange < 0
          ? ` Biggest drag: ${inv.topLosers[0].ticker || 'unknown'} ${fmt(inv.topLosers[0].periodChange)}.`
          : '';
        insights.push({
          type: 'investments',
          title: `Portfolio ${dir} ${fmt(Math.abs(inv.periodChange))} (${absPct}%) past 7d`,
          detail:
            `Total portfolio value: ${fmt(inv.totalValue)}. Over the past 7 days: ${dir} ${fmt(Math.abs(inv.periodChange))} (${absPct}%).${gainLine}${loseLine}`,
          evidence: {
            kind: 'investments',
            totalValue: Math.round(inv.totalValue),
            periodChange: Math.round(inv.periodChange),
            periodChangePct: parseFloat(absPct),
            holdings: inv.holdings.slice(0, 10),
            topGainers: inv.topGainers,
            topLosers: inv.topLosers,
          },
        });
      } else {
        // Performance data unavailable — show value only.
        insights.push({
          type: 'investments',
          title: `Portfolio value: ${fmt(inv.totalValue)}`,
          detail: `Total portfolio value: ${fmt(inv.totalValue)}. 7-day performance data not yet available from Monarch.`,
          evidence: { kind: 'investments', totalValue: Math.round(inv.totalValue) },
        });
      }
    }
  } catch (err) {
    console.error('[wealth-insights] investments failed:', err.message);
  }

  return insights;
}

module.exports = { buildWealthInsights };
