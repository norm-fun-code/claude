// Wealth insights: spending patterns vs your own usual, and vs Monarch budgets.
// Pure-ish — pulls category spend from stored Monarch transaction docs, and (if
// a Monarch token is available) this month's budget targets. Produces short,
// plain-language insight strings for the Wealth tab.
//
// Semantic contract (On My Radar audit): every insight this function returns
// ALSO declares a small set of structured fields describing what kind of
// thing it is, not just what it says — this is the authoritative source
// brain/radar.js's wealthCandidate() consumes to decide whether (and how) an
// insight belongs on "On My Radar." Before this contract existed, radar.js
// took wealthInsights[0] unconditionally and stamped it material/tier-1 —
// which meant a POSITIVE "saving 28% of income" result rendered as a red
// "Needs attention" alert, because nothing upstream had ever recorded that
// it was good news. These fields fix that at the source, not with a title-
// specific patch:
//   - attentionClass: 'action_required' | 'watch' | 'positive' | 'informational'
//       ('ready' is reserved for newly-available artifacts like the weekly
//       review, which this module doesn't produce.) 'informational' means
//       "never shown on Radar" — routine, already-on-track data.
//   - material: does this represent a real, dollar/impact-significant fact?
//   - timeSensitive: does its relevance decay if not seen soon?
//   - actionable: is there something the user could actually do about it?
//   - direction: 'positive' | 'negative' | 'neutral' | 'uncertain' — the
//       VALENCE of the fact, independent of how urgent it is.
//   - reasonCode: a stable, non-title-specific identifier a presentation
//       layer (radar.js) can switch on to write copy — never regex/string
//       matching against `title`/`detail`.
// `evidence` (already existed for some types) is the structured data a
// presentation layer can format into compact bullets instead of re-parsing
// prose; every type below now carries one.
const documents = require('../store/documents');
const metricsStore = require('../store/metrics');
const { computeSubscriptionInsights } = require('../intelligence/subscriptions');
const { isInternalTransfer } = require('../connectors/monarch');
const stats = require('../intelligence/stats');
const monarchWealth = require('./monarch-wealth');
const { buildAllocationInsights } = require('../intelligence/allocation');

const MIN_SPEND = 50;       // ignore trivially small categories
const SPIKE_RATIO = 1.15;   // 15%+ over your usual is noteworthy
const SPIKE_DOLLARS = 100;  // ...and at least $100 more, so it's material
const OVER_BUDGET = 1.05;  // 5%+ over budget is noteworthy
// Below this baseline, a percentage overage is mostly an artifact of a tiny
// denominator (a $100 avg category swinging to $500 reads as "400% above
// usual" even though the dollar impact is modest) — omit the percentage
// entirely below this line rather than lead with a manufactured-looking
// number (truth-and-evidence contract, audit priority #1: "prefer dollar
// deviation over huge percentages against tiny baselines").
const SMALL_BASELINE_FOR_PCT = 150;

// Categories paid as a single monthly lump sum, not a recurring daily spend —
// projecting "on pace for $X" from day-of-month elapsed is nonsensical for
// these (a rent payment landing on the 1st isn't "trending 250% above usual,"
// it's the whole month's rent). These get a direct actual-vs-budget read
// instead (see the budget-pacing section below).
const LUMP_SUM = new Set(['Rent', 'Mortgage', 'Rent & Utilities']);
const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
const pct = (n) => Math.round(n) + '%';

// A growing trend only rises to a genuine Radar-worthy milestone at a
// meaningfully higher bar than "worth mentioning in the Wealth tab at all"
// ($50/mo, below) — a general, value-based threshold, not tied to any
// specific number seen in production.
const NET_WORTH_MIN_MONTHLY_TO_SURFACE = 50;
const NET_WORTH_MILESTONE_MONTHLY = 1000;

/**
 * The canonical net-worth direction/trend: a 120-day linear fit, reported as
 * a factual $/mo change only — deliberately NOT extrapolated to year-end
 * (see severity/reliability cleanup: market movement, transfers, equity
 * comp, and irregular cash flows make a linear projection of a short
 * trailing slope misleading). THE ONE net-worth-trend authority — extracted
 * so wealth-landing.js's severity/posture card and net_worth_path both read
 * the identical number instead of three independent windows/methods
 * (this function's own former inline version, briefing.js's legacy 23-day-
 * average-vs-latest `wealth.netWorthChange`, and consolidate.js's self-model
 * 30-60-day-average) silently disagreeing with each other.
 *
 * Returns null when there isn't enough history (&lt;8 daily points) or the
 * trend is too small to be worth surfacing at all (&lt;$50/mo either direction).
 */
async function computeNetWorthTrend({ now = new Date() } = {}) {
  const from = new Date(now.getTime() - 120 * 864e5);
  const nw = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'net_worth', from, to: now, agg: 'avg', excludeSource: 'seed' });
  const series = nw.map((r) => ({ day: r.day, value: Number(r.value) })).filter((p) => Number.isFinite(p.value));
  if (series.length < 8) return null;
  // Fit against real calendar days → a true per-day slope. Deliberately no
  // year-end (or any) extrapolation from this slope — market movement,
  // transfers, equity comp, and irregular cash flows make a linear
  // projection of a short trailing window misleading, not just optimistic.
  const fit = stats.fitByDay(series);
  const current = series[series.length - 1].value;
  const perDay = fit && fit.slope != null ? fit.slope : 0;
  const monthlyChange = perDay * 30;
  if (Math.abs(monthlyChange) < NET_WORTH_MIN_MONTHLY_TO_SURFACE) return null;
  return {
    current, monthlyChange,
    direction: monthlyChange >= 0 ? 'growing' : 'declining',
    // A declining trend is a real, if slow-moving, concern worth watching
    // rather than an emergency — material only past a higher dollar bar.
    material: monthlyChange >= 0 ? monthlyChange >= NET_WORTH_MILESTONE_MONTHLY : Math.abs(monthlyChange) >= 300,
    milestone: monthlyChange >= NET_WORTH_MILESTONE_MONTHLY,
  };
}

/**
 * The canonical trailing-30-day savings rate: (income - spending) / income.
 * Extracted so the Wealth landing projection (wealth-landing.js) can read
 * the SAME number the savings_rate insight card is built from, rather than
 * a client (or another server module) independently re-deriving it from raw
 * income/spending metrics — exactly the "mobile must not recalculate
 * savings rate" requirement, satisfied by giving every caller ONE place to
 * ask. Returns null when there's no real income to divide by (same
 * MIN_SPEND gate the insight card uses).
 *
 * Same window as the Net Worth card's rolling-30-days figures — truncated
 * `from` AND an explicit `to: now` upper bound, so this can never silently
 * disagree with the Net Worth card computed in the same request.
 */
async function computeSavingsRate({ now = new Date() } = {}) {
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  from.setUTCHours(0, 0, 0, 0);
  const to = now;
  const sumOf = async (metric) => {
    const rows = await metricsStore.dailyAggregate({ domain: 'wealth', metric, from, to, agg: 'sum', excludeSource: 'seed' });
    return rows.reduce((a, r) => a + Number(r.value || 0), 0);
  };
  const [income, spending] = await Promise.all([sumOf('income'), sumOf('spending')]);
  if (income < MIN_SPEND) return null;
  const rate = (income - spending) / income; // can be negative (overspending)
  const ratePct = Math.round(rate * 100);
  const positive = rate >= 0;
  return {
    income: Math.round(income), spending: Math.round(spending), ratePct, positive,
    windowDays: 30,
    // Same semantic contract every insight below carries — a healthy or
    // strong positive rate is never 'action_required'/'watch', regardless
    // of how high the percentage is (a savings rate cannot be simultaneously
    // "28%" and "needs attention").
    attentionClass: positive ? 'informational' : 'action_required',
  };
}

/**
 * Build wealth insight lines. Returns [{ type, title, detail }].
 *  - "vs usual": current-month category spend vs the avg of prior full months.
 *  - "vs budget": current-month actual vs Monarch's planned amount per category.
 */
async function buildWealthInsights({ spendingPace = null } = {}) {
  const insights = [];

  // 0) Savings rate — the single most important personal-finance number:
  // (income − spending) / income over the trailing 30 days. Only surfaced when
  // there's real income to divide by.
  try {
    const sr = await computeSavingsRate();
    if (sr) {
      const { income, spending, ratePct, positive } = sr;
      insights.push({
        type: 'savings_rate',
        tone: positive ? 'win' : 'watch',
        title: positive
          ? `Saving ${ratePct}% of income (30d)`
          : `Spending ${Math.abs(ratePct)}% more than you earned (30d)`,
        detail: positive
          ? `Over the last 30 days you brought in ${fmt(income)} and spent ${fmt(spending)} — a savings rate of ${ratePct}%. ${ratePct >= 20 ? 'Strong — at or above the 20% rule of thumb.' : 'Below the common 20% target; small cuts compound.'}`
          : `Over the last 30 days you spent ${fmt(spending)} against ${fmt(income)} of income — drawing down savings. Worth a look at the biggest categories.`,
        // A positive savings rate — even a strong one — is routine on-track
        // information, not an alert: never material, regardless of how high
        // the percentage is. There's no persisted trend/comparison here to
        // tell "healthy as usual" apart from "a genuinely new milestone," so
        // rather than guess, this stays informational (Wealth tab only,
        // never Radar) until a real novelty signal exists to justify more.
        // A NEGATIVE rate (spending more than earned) is the one genuinely
        // actionable fact this insight can produce.
        attentionClass: sr.attentionClass,
        material: !positive,
        timeSensitive: !positive,
        actionable: !positive,
        direction: positive ? 'positive' : 'negative',
        reasonCode: positive ? 'savings_rate_healthy' : 'overspending_30d',
        evidence: { kind: 'savings_rate', income, spending, ratePct, windowDays: 30 },
      });
    }
  } catch (err) {
    console.error('[wealth-insights] savings rate failed:', err.message);
  }

  // Budget pacing (per-category actual vs Monarch's planned amount) — fetched
  // ONCE here and reused by both the "vs usual" spike cards (section 1, to add a
  // budget read to each trend) and the dedicated budget-pacing cards (section 3).
  // A spending trend the user can't map onto a budget is only half the story:
  // "Taxi up 823% vs usual" lands very differently when it's still inside a
  // generous budget vs blowing through it. null when Monarch MCP isn't set up.
  let pacing = null;
  try {
    pacing = await monarchWealth.getBudgetPacing();
  } catch (err) {
    console.error('[wealth-insights] budget pacing failed:', err.message);
  }
  // category (lowercased) -> budget line, for O(1) lookup while building spikes.
  const budgetByCat = new Map();
  for (const l of pacing?.lines || []) {
    if (l.category) budgetByCat.set(String(l.category).toLowerCase(), l);
  }

  // Given a category's budget line and its projected full-month spend, return a
  // short clause tying the "vs usual" trend to the budget — or '' when there's no
  // budget to compare against. `pace` (actual/expected-by-now) already encodes
  // the full-month projection: projected ≈ pace × budget, so pace>1 ⇒ on track to
  // finish over. Uses the budget line's OWN actual/budget figures so the sentence
  // is internally consistent with Monarch's budget view.
  const budgetClause = (category) => {
    const l = budgetByCat.get(String(category).toLowerCase());
    if (!l || !(l.budget > 0)) return '';
    if (l.overBudget) {
      return ` It's also already past your ${fmt(l.budget)} budget (${fmt(l.actual)} spent).`;
    }
    if (l.pace >= 1.05) {
      return ` Against your ${fmt(l.budget)} budget, that's on pace to finish about ${pct((l.pace - 1) * 100)} over.`;
    }
    return ` Still, that's within your ${fmt(l.budget)} budget so far.`;
  };

  // 1) Spend vs your usual — ALWAYS from wealth-pace.js's categoryBreakdown,
  // the one canonical "current vs. matched-elapsed-fraction historical
  // median" figure per category (see computeDiscretionaryMatchedPace). This
  // module used to run its own INDEPENDENT baseline here (a mean of trailing
  // full calendar months vs. a run-rate-projected current month, via
  // documents.monthlyCategorySpend) — a second, incompatible definition of
  // "usual" for the exact same category/month that the top Wealth card's
  // "Driven by X" line already explains with wealth-pace's median. The two
  // would silently disagree (e.g. "Driven by Clothing +$2,852" up top vs.
  // "Clothing: $3,125 more than usual" in this list, for the same month) —
  // never two independently-computed baselines for the same fact on one
  // screen again. `spendingPace` is the SAME resolved
  // computeDiscretionaryMatchedPace() result the caller (wealth-landing.js)
  // already computed for the top card — passed in, never recomputed, so
  // there is exactly one query path and exactly one number.
  if (spendingPace && spendingPace.coverageTier === 'typical' && Array.isArray(spendingPace.categoryBreakdown)) {
    const candidates = spendingPace.categoryBreakdown.filter((c) => !LUMP_SUM.has(c.category));
    for (const s of candidates.slice(0, 3)) {
      const pctSuffix = s.pct != null ? ` (${pct(s.pct)} above usual)` : '';
      insights.push({
        type: 'spending_pattern',
        tone: 'watch',
        category: s.category,
        title: `${s.category}: ${fmt(s.excessDollars)} more than usual${pctSuffix}`,
        // Trend vs the user's own history (matched to the same elapsed
        // fraction of the month, so no "on pace for" projection is needed —
        // the comparison is already apples-to-apples) PLUS, when Monarch has
        // a budget for the category, where that trend lands against the
        // budget — the two reads the user actually cares about, on one card.
        detail:
          `You've spent ${fmt(s.currentAmount)} on ${s.category} so far this month — about ${fmt(s.excessDollars)} more than your typical ${fmt(s.matchedMedian)} by this point in the month.` +
          budgetClause(s.category),
        // excessDollars is the actual dollar overage (current - matched
        // median), NOT the percentage — a small-base/huge-% spike and a
        // large-base/modest-% one can be comparably real dollar impacts, but
        // ranking by raw percentage alone makes the small-base one look far
        // more urgent than it is (product review finding). Callers should
        // rank/select by this, not by re-parsing the title string.
        evidence: { kind: 'spending_pattern', category: s.category, current: s.currentAmount, matchedMedian: s.matchedMedian, impactDollars: s.excessDollars },
        // Already gated by wealth-pace.js's CATEGORY_MIN_SPEND +
        // CATEGORY_EXCESS_DOLLAR_FLOOR — every entry that reaches this line
        // is a real, dollar-material deviation from the user's own matched
        // history, worth acting on now.
        attentionClass: 'action_required', material: true, timeSensitive: true, actionable: true,
        direction: 'negative', reasonCode: 'spending_spike',
      });
    }
  } else {
    // Degraded fallback whenever there's no USABLE matched-pace category
    // breakdown — either no spendingPace at all (Monarch not configured, or
    // the pace computation errored), or a real spendingPace whose
    // coverageTier is 'insufficient' (fewer than wealth-pace's
    // MIN_COMPARABLE_MONTHS=6 eligible historical months, e.g. a newer
    // account) — wealth-pace deliberately returns an empty categoryBreakdown
    // in that case rather than inventing a median from too thin a sample.
    // Never used alongside a real, sufficient-coverage spendingPace, so this
    // can't disagree with the top card. Coarser than wealth-pace's matched-
    // elapsed-fraction median (a plain mean of up to 3 trailing full months
    // vs. a projected current month), but better than showing nothing for an
    // account with real transaction history and no 6-month pace baseline yet.
    let rows = [];
    try {
      // Exclude internal transfers / card payments so the category breakdown
      // matches the spending metric (which already excludes them). Filtered
      // here rather than in the store helper so diagnostics can still see
      // raw rows.
      rows = (await documents.monthlyCategorySpend({ months: 4 }))
        .filter((r) => !isInternalTransfer(r.category));
    } catch (err) {
      console.error('[wealth-insights] category spend failed:', err.message);
    }

    if (rows.length) {
      const months = [...new Set(rows.map((r) => r.month))].sort(); // ascending
      const current = months[months.length - 1];
      const priorMonths = months.slice(0, -1);

      const now = new Date();
      const currentIsThisMonth =
        current === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const dayOfMonth = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const projFactor = currentIsThisMonth ? daysInMonth / dayOfMonth : 1;
      const projectionReliable = !currentIsThisMonth || dayOfMonth >= 7;

      const byCat = new Map();
      for (const r of rows) {
        const slot = byCat.get(r.category) || { current: 0, priors: [] };
        if (r.month === current) slot.current = r.spend;
        else if (priorMonths.includes(r.month)) slot.priors.push(r.spend);
        byCat.set(r.category, slot);
      }

      const spikes = [];
      for (const [category, s] of byCat) {
        if (LUMP_SUM.has(category)) continue;
        if (!s.priors.length) continue;
        const avg = s.priors.reduce((a, b) => a + b, 0) / s.priors.length;
        if (avg < MIN_SPEND) continue;
        const projected = s.current * projFactor;
        if (projected < MIN_SPEND) continue;
        const ratio = projected / avg;
        if (ratio >= SPIKE_RATIO && projected - avg >= SPIKE_DOLLARS) {
          spikes.push({ category, current: s.current, projected, avg, over: pct((ratio - 1) * 100) });
        }
      }
      if (projectionReliable) {
        spikes.sort((a, b) => (b.projected - b.avg) - (a.projected - a.avg));
        const projected = currentIsThisMonth && projFactor > 1.05;
        for (const s of spikes.slice(0, 3)) {
          const impactDollars = Math.round(s.projected - s.avg);
          const vsUsual = projected
            ? `You've spent ${fmt(s.current)} on ${s.category} so far this month — on pace for about ${fmt(s.projected)}, roughly ${s.over} above your recent average of ${fmt(s.avg)}.`
            : `You've spent ${fmt(s.current)} on ${s.category} this month — about ${s.over} more than your recent average of ${fmt(s.avg)}.`;
          const pctSuffix = s.avg >= SMALL_BASELINE_FOR_PCT ? ` (${s.over} above usual)` : '';
          insights.push({
            type: 'spending_pattern',
            tone: 'watch',
            category: s.category,
            title: `${s.category}: ${fmt(impactDollars)} more than usual${pctSuffix}`,
            detail: vsUsual + budgetClause(s.category),
            evidence: { kind: 'spending_pattern', category: s.category, current: Math.round(s.current), projected: Math.round(s.projected), avg: Math.round(s.avg), impactDollars },
            attentionClass: 'action_required', material: true, timeSensitive: true, actionable: true,
            direction: 'negative', reasonCode: 'spending_spike',
          });
        }
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
          tone: 'neutral',
          title: `${active.length} recurring charges ≈ ${fmt(totalMonthly)}/mo`,
          detail:
            `Monarch tracks ${active.length} recurring expenses totaling ${fmt(totalMonthly)}/month (${fmt(totalAnnual)}/yr). ` +
            `Top: ${active.slice(0, 3).map((s) => `${s.name} (${fmt(s.monthly)}/mo)`).join(', ')}.`,
          evidence: { kind: 'subscriptions', count: active.length, totalAnnual, totalMonthly, items: active.slice(0, 10) },
          // A standing summary, not a new development — always true, never
          // urgent. Wealth-tab reference material, never a Radar candidate.
          attentionClass: 'informational', material: false, timeSensitive: false, actionable: false,
          direction: 'neutral', reasonCode: 'subscriptions_summary',
        });
        const big = active.find((s) => s.annual >= 200);
        if (big) {
          insights.push({
            type: 'subscription_review',
            tone: 'neutral',
            title: `Review: ${big.name} is ${fmt(big.annual)}/yr`,
            detail: `${big.name} bills ${fmt(big.amount)} ${big.frequency} — about ${fmt(big.annual)} a year. Worth confirming it's still earning its keep.`,
            evidence: { kind: 'subscription_review', merchant: big.name, annual: big.annual },
            // Evergreen suggestion, not tied to anything that just happened —
            // worth reviewing eventually, not worth interrupting today for.
            attentionClass: 'informational', material: false, timeSensitive: false, actionable: true,
            direction: 'neutral', reasonCode: 'subscription_review',
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

  // 1c) Net-worth trajectory — the FACTUAL trailing trend only (current
  // value, direction, $/mo change over the window). Deliberately no
  // year-end extrapolation: market movement, transfers, equity comp, and
  // irregular cash flows make a linear projection of a short trailing slope
  // misleading, not just optimistic. See numbers.planPace (wealth-landing.js)
  // for progress against the user's actual stated plan instead.
  try {
    const trend = await computeNetWorthTrend();
    if (trend) {
      const { current, monthlyChange, direction: dir, milestone } = trend;
      insights.push({
        type: 'net_worth_path',
        tone: monthlyChange >= 0 ? 'win' : 'watch',
        title: `Net worth ${dir} ~${fmt(Math.abs(monthlyChange))}/mo`,
        detail:
          `Based on your 4-month trend, net worth is ${dir} about ${fmt(Math.abs(monthlyChange))}/month ` +
          `(now ${fmt(current)}).`,
        evidence: { kind: 'net_worth_path', current: Math.round(current), monthlyChange: Math.round(monthlyChange) },
        ...(monthlyChange >= 0
          ? (milestone
              ? { attentionClass: 'positive', material: true, timeSensitive: false, actionable: false, direction: 'positive', reasonCode: 'net_worth_growth_milestone' }
              : { attentionClass: 'informational', material: false, timeSensitive: false, actionable: false, direction: 'positive', reasonCode: 'net_worth_trend' })
          : { attentionClass: 'watch', material: Math.abs(monthlyChange) >= 300, timeSensitive: false, actionable: true, direction: 'negative', reasonCode: 'net_worth_decline' }),
      });
    }
  } catch (err) {
    console.error('[wealth-insights] net-worth path failed:', err.message);
  }

  // 3) Budget pacing vs Monarch's planned amounts (live, no legacy token needed).
  // Reuses `pacing` fetched once at the top (also feeds the spike cards' budget
  // clause) so we don't hit GetBudget twice per insights build.
  try {
    if (pacing && pacing.lines.length) {
      // Daily-spend categories: show ALL that are already over budget, then cap
      // "on pace to overspend" warnings at 2 so the list doesn't flood.
      const alreadyOver = pacing.lines.filter((l) => l.overBudget && !LUMP_SUM.has(l.category));
      const pacingAhead = pacing.lines.filter((l) => !l.overBudget && !LUMP_SUM.has(l.category) && l.pace >= 1.3);
      for (const l of [...alreadyOver, ...pacingAhead.slice(0, 2)]) {
        const status = l.overBudget
          ? `over budget (${fmt(l.actual)} of ${fmt(l.budget)})`
          : `on pace to overspend — ${pct((l.pace - 1) * 100)} ahead of schedule`;
        insights.push({
          type: 'over_budget',
          tone: 'watch',
          category: l.category,
          title: `${l.category}: ${status}`,
          detail:
            `${l.category}: ${fmt(l.actual)} spent of ${fmt(l.budget)} budget (day ${pacing.dayOfMonth}/${pacing.daysInMonth}). ` +
            (l.overBudget
              ? `Already ${fmt(Math.abs(l.remaining))} over.`
              : `Spending ${pct((l.pace - 1) * 100)} faster than the month is elapsing.`),
          // impactDollars mirrors spending_pattern's field so callers can rank
          // both types by dollar impact with one consistent field name.
          evidence: { kind: 'budget_pacing', category: l.category, budget: l.budget, actual: l.actual, pace: l.pace, overBudget: l.overBudget, impactDollars: Math.round(Math.abs(l.actual - l.budget)) },
          // A confirmed real budget overage (or fast pace toward one) — the
          // most authoritative, actionable wealth signal this module produces.
          attentionClass: 'action_required', material: true, timeSensitive: true, actionable: true,
          direction: 'negative', reasonCode: l.overBudget ? 'over_budget' : 'pacing_over_budget',
        });
      }
      // Lump-sum categories (rent, mortgage) are excluded entirely, not just from
      // the run-rate projection above — a standard, expected fixed payment isn't
      // insight-worthy on its own, whether it's framed as "vs usual" or "vs budget."
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
        // Lead with portfolio VALUE (the number that matters for a long-term
        // investor), and frame the 7-day move as context, not a headline. A single
        // week's swing is noise; surfacing "down $X this week" as the title nudges
        // toward anxiety and market-timing — the two behaviors that hurt returns.
        insights.push({
          type: 'investments',
          tone: 'neutral',
          title: `Portfolio ${fmt(inv.totalValue)}`,
          detail:
            `Worth ${fmt(inv.totalValue)} today. The past 7 days are ${dir} ${fmt(Math.abs(inv.periodChange))} (${absPct}%) — normal short-term movement; what matters is the multi-year trajectory, not any single week.${gainLine}${loseLine}`,
          evidence: {
            kind: 'investments',
            totalValue: Math.round(inv.totalValue),
            periodChange: Math.round(inv.periodChange),
            periodChangePct: parseFloat(absPct),
            holdings: inv.holdings.slice(0, 10),
            topGainers: inv.topGainers,
            topLosers: inv.topLosers,
          },
          // Deliberately informational even on a big up week — the comment
          // above explains why (a single week's swing is noise; surfacing it
          // as an alert or a milestone would itself nudge toward
          // market-timing anxiety, exactly what this card is written to avoid).
          attentionClass: 'informational', material: false, timeSensitive: false, actionable: false,
          direction: inv.periodChange >= 0 ? 'positive' : 'negative', reasonCode: 'portfolio_performance',
        });
      } else {
        // Performance data unavailable — show value only.
        insights.push({
          type: 'investments',
          tone: 'neutral',
          title: `Portfolio value: ${fmt(inv.totalValue)}`,
          detail: `Total portfolio value: ${fmt(inv.totalValue)}. 7-day performance data not yet available from Monarch.`,
          evidence: { kind: 'investments', totalValue: Math.round(inv.totalValue) },
          attentionClass: 'informational', material: false, timeSensitive: false, actionable: false,
          direction: 'neutral', reasonCode: 'portfolio_value',
        });
      }
    }
  } catch (err) {
    console.error('[wealth-insights] investments failed:', err.message);
  }

  // NB: asset allocation + single-name concentration are NOT pushed into this
  // text feed — they have a dedicated visual "Asset Mix" card (GET
  // /api/wealth/allocation), since they're a structural view, not a daily insight.

  // Dedupe: if a category is already flagged "over budget" (authoritative — it's
  // vs a real budget), drop a redundant "trending above usual" run-rate spike for
  // the SAME category, so one overspend doesn't occupy two cards.
  const overBudgetCats = new Set(
    insights.filter((i) => i.type === 'over_budget' && i.category).map((i) => i.category)
  );
  let deduped = insights.filter(
    (i) => !(i.type === 'spending_pattern' && i.category && overBudgetCats.has(i.category))
  );

  // Lead with the wins. Stable-sort by tone so the user sees what's going RIGHT
  // (saving 57%, net worth growing, under budget) before the watch-outs, instead
  // of a wall of negatives — without dropping any signal. Within the 'watch'
  // band, order by DOLLAR IMPACT (evidence.impactDollars), not insertion order —
  // this is THE canonical ranking (truth-and-evidence contract, audit priority
  // #1: "prefer dollar deviation over huge percentages against tiny baselines").
  // Both spending_pattern and over_budget items carry impactDollars, so an
  // objectively bigger over_budget overage (e.g. $800) always outranks a
  // smaller spending_pattern spike (e.g. $400) regardless of which section of
  // this function pushed it first. This is the ONE place that ranking happens —
  // routes/briefing.js's chief-brief spendingContext reads THIS SAME ordering
  // instead of independently re-sorting the same list a second time.
  const toneRank = { win: 0, neutral: 1, watch: 2 };
  deduped = deduped
    .map((ins, i) => ({ ins, i }))
    .sort((a, b) => {
      const toneDiff = (toneRank[a.ins.tone] ?? 1) - (toneRank[b.ins.tone] ?? 1);
      if (toneDiff !== 0) return toneDiff;
      const aDollars = a.ins.evidence?.impactDollars;
      const bDollars = b.ins.evidence?.impactDollars;
      if (typeof aDollars === 'number' && typeof bDollars === 'number' && aDollars !== bDollars) {
        return bDollars - aDollars;
      }
      return a.i - b.i;
    })
    .map((x) => x.ins);

  // Every insight built above declares the full semantic contract explicitly
  // (see the module header comment). The one exception is the heuristic
  // subscriptions fallback (intelligence/subscriptions.js's
  // computeSubscriptionInsights, used only when Monarch's own recurring-
  // streams API isn't available) — it predates this contract and produces
  // the same shape either way, so it's normalized here rather than
  // duplicating the contract in a second module. Default is deliberately the
  // SAFEST one: 'informational' (never shown on Radar) — an insight this
  // function forgot to classify must never silently default to an alert.
  // `asOf` is stamped once, uniformly, at the moment this whole batch was
  // computed — every figure above comes from a live read taken during this
  // same call, so a single timestamp for the batch is honest, not a fiction.
  const builtAt = new Date().toISOString();
  deduped = deduped.map((ins) => ({
    attentionClass: 'informational', material: false, timeSensitive: false, actionable: false,
    direction: 'neutral', reasonCode: ins.type || 'wealth_insight',
    ...ins,
    asOf: ins.asOf || builtAt,
  }));

  return deduped;
}

module.exports = { buildWealthInsights, computeSavingsRate, computeNetWorthTrend };
