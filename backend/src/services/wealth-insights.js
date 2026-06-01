// Wealth insights: spending patterns vs your own usual, and vs Monarch budgets.
// Pure-ish — pulls category spend from stored Monarch transaction docs, and (if
// a Monarch token is available) this month's budget targets. Produces short,
// plain-language insight strings for the Wealth tab.
const documents = require('../store/documents');
const metricsStore = require('../store/metrics');
const { computeSubscriptionInsights } = require('../intelligence/subscriptions');
const stats = require('../intelligence/stats');

let monarchApi = null;
try { monarchApi = require('./monarch-api'); } catch { /* optional */ }

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
      const rows = await metricsStore.dailyAggregate({ domain: 'wealth', metric, from, agg: 'sum' });
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
    rows = await documents.monthlyCategorySpend({ months: 4 });
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

  // 1b) Subscriptions / recurring charges (Rocket-Money-style).
  try {
    const txns = await documents.spendTransactions({ days: 150 });
    if (txns.length) {
      for (const s of computeSubscriptionInsights(txns)) insights.push(s);
    }
  } catch (err) {
    console.error('[wealth-insights] subscriptions failed:', err.message);
  }

  // 1c) Net-worth trajectory — project the trend to year-end (Wealthfront "Path"
  // style), so you see where you're heading at the current rate.
  try {
    const from = new Date(Date.now() - 120 * 864e5);
    const nw = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'net_worth', from, agg: 'avg' });
    const vals = nw.map((r) => Number(r.value)).filter(Number.isFinite);
    if (vals.length >= 8) {
      const fit = stats.linearFit(vals);
      const current = vals[vals.length - 1];
      // Slope is per present-sample; approximate samples→days via the date span.
      const spanDays = Math.max(1, (new Date(nw[nw.length - 1].day) - new Date(nw[0].day)) / 864e5);
      const perDay = fit && fit.slope != null ? (fit.slope * (vals.length - 1)) / spanDays : 0;
      const daysToYearEnd = Math.max(0, (new Date(new Date().getFullYear(), 11, 31) - new Date()) / 864e5);
      const projected = current + perDay * daysToYearEnd;
      const monthlyChange = perDay * 30;
      if (Math.abs(monthlyChange) >= 50) {
        const dir = monthlyChange >= 0 ? 'growing' : 'declining';
        insights.push({
          type: 'net_worth_path',
          title: `Net worth ${dir} ~${fmt(Math.abs(monthlyChange))}/mo`,
          detail:
            `At your recent pace, net worth is ${dir} about ${fmt(Math.abs(monthlyChange))}/month — ` +
            `on track for roughly ${fmt(projected)} by year-end (now ${fmt(current)}). A projection from trend, not a guarantee.`,
          evidence: { kind: 'net_worth_path', current: Math.round(current), projected: Math.round(projected), monthlyChange: Math.round(monthlyChange) },
        });
      }
    }
  } catch (err) {
    console.error('[wealth-insights] net-worth path failed:', err.message);
  }

  // 2) Spend vs Monarch budget (if we have a token to read budgets).
  const token = process.env.MONARCH_TOKEN;
  if (token && monarchApi?.getBudgets) {
    try {
      const now = new Date();
      const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const endMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const endDate = `${endMonth.getFullYear()}-${String(endMonth.getMonth() + 1).padStart(2, '0')}-${String(endMonth.getDate()).padStart(2, '0')}`;
      const budgets = await monarchApi.getBudgets(token, { startDate, endDate });

      const over = budgets
        .filter((b) => b.budget >= MIN_SPEND && b.actual > b.budget * OVER_BUDGET)
        .map((b) => ({ ...b, overBy: b.actual - b.budget }))
        .sort((a, b) => b.overBy - a.overBy)
        .slice(0, 3);

      for (const b of over) {
        insights.push({
          type: 'over_budget',
          title: `Over budget on ${b.category}`,
          detail: `${b.category}: ${fmt(b.actual)} spent against a ${fmt(b.budget)} budget — ${fmt(b.overBy)} over (${pct((b.actual / b.budget - 1) * 100)}).`,
        });
      }
    } catch (err) {
      console.error('[wealth-insights] budgets failed:', err.message);
    }
  }

  return insights;
}

module.exports = { buildWealthInsights };
