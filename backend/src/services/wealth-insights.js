// Wealth insights: spending patterns vs your own usual, and vs Monarch budgets.
// Pure-ish — pulls category spend from stored Monarch transaction docs, and (if
// a Monarch token is available) this month's budget targets. Produces short,
// plain-language insight strings for the Wealth tab.
const documents = require('../store/documents');

let monarchApi = null;
try { monarchApi = require('./monarch-api'); } catch { /* optional */ }

const MIN_SPEND = 50;      // ignore trivially small categories
const SPIKE_RATIO = 1.25;  // 25%+ over your usual is noteworthy
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
      if (s.current < MIN_SPEND || !s.priors.length) continue;
      const avg = s.priors.reduce((a, b) => a + b, 0) / s.priors.length;
      if (avg < MIN_SPEND) continue;
      const ratio = s.current / avg;
      if (ratio >= SPIKE_RATIO) {
        spikes.push({ category, current: s.current, avg, over: pct((ratio - 1) * 100) });
      }
    }
    // Biggest dollar overages first, top 3.
    spikes.sort((a, b) => (b.current - b.avg) - (a.current - a.avg));
    for (const s of spikes.slice(0, 3)) {
      insights.push({
        type: 'spending_pattern',
        title: `${s.category} up ${s.over} vs your usual`,
        detail: `You've spent ${fmt(s.current)} on ${s.category} this month — about ${s.over} more than your recent average of ${fmt(s.avg)}.`,
      });
    }
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
