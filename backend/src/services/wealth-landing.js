// Wealth redesign (audit rec #5) — the ONE authoritative Wealth landing-page
// projection. NormOS is not a second Monarch: Monarch stays the system of
// record for transactions/accounts/categorization/budgets; this module
// INTERPRETS canonical data already computed elsewhere (wealth-insights.js's
// buildWealthInsights/computeSavingsRate/computeNetWorthTrend, brain/
// snapshot.js's canonicalSpendingMtd, intelligence/source-health.js) into a
// small, decision-first shape — it does not reimplement any of the
// flow/anomaly/materiality math those modules already own.
//
// Every consumer (Wealth tab, Ask, Chief Brief, Today) that wants "what
// should the user know about their money right now" should call
// buildWealthLandingProjection() rather than re-deriving posture/pace/
// savings-rate/net-worth-direction independently — that duplication (three
// different net-worth-trend windows, a client-side savings-rate calc, etc.)
// is exactly the bug class this module exists to close.
'use strict';

const wealthInsightsMod = require('./wealth-insights');
const metricsStore = require('../store/metrics');
const sourcesStore = require('../store/sources');
const documents = require('../store/documents');
const dismissedInsights = require('../store/dismissedInsights');
const { getMonarchHealth } = require('../intelligence/source-health');

const fmt = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US');

// A dismissed wealth insight resurfaces only once the SAME underlying
// category/type recurs at least this many times larger than what was
// dismissed — "materially new evidence," not the same fact restated with a
// slightly different month's number (acceptance criterion #9).
const REACTIVATE_MULTIPLIER = 1.5;

// A single transaction "explains" a spending spike when it accounts for at
// least this share of the dollar overage — e.g. one $600 concert-ticket
// purchase inside a $700 Entertainment spike. Below this share, the spike
// reflects genuinely elevated day-to-day spending, not one event.
const EXPLAINS_SPIKE_SHARE = 0.6;

// Best-effort grouping of common Monarch default categories that read as one
// coherent "eating out" / "shopping" story rather than N separate cards —
// intentionally small and non-exhaustive (there is no reliable category
// taxonomy to derive this from); categories outside this map are simply
// never consolidated, which is always safe (falls back to showing them
// separately, still capped at 3 total).
const RELATED_CATEGORY_GROUPS = {
  'Restaurants & Bars': 'Dining out',
  'Restaurants': 'Dining out',
  'Fast Food': 'Dining out',
  'Coffee Shops': 'Dining out',
  'Clothing': 'Shopping',
  'Shopping': 'Shopping',
  'Electronics': 'Shopping',
};

const TIER_RANK = { action_required: 0, watch: 1, positive: 2, informational: 3 };

// ── Wealth severity contract (severity/reliability cleanup) ──
// One deterministic severity per insight and for the overall Wealth summary,
// shared by the Wealth tab, Today's radar candidate, and Recommended Action —
// derived ONLY from fields other modules already compute (attentionClass,
// explainedBy, reasonCode, evidence dollars, cashflow-lookahead, plan pace).
// Never a second materiality model, never LLM-chosen.
//
//   critical    — credible urgent financial risk requiring immediate action
//   action      — meaningful unresolved issue with a concrete action
//   review      — unusual activity worth confirming, not yet a confirmed issue
//   explained   — anomaly already explained (auto-matched, or user-confirmed
//                 "This was intentional")
//   on_track    — no material unresolved issue
//   unavailable — source data stale/incomplete/disconnected

// A budget/pace problem only rises to "action" (not just "review") once it's
// a CONFIRMED, PERSISTENT issue (over budget / pacing over budget / spending
// more than earned) — a single-month spending spike that hasn't recurred is
// "worth confirming" (review), not yet a decision to make. This is why
// "percent above usual" alone must never drive severity: a spending_spike
// insight can carry a huge % and still only be a review-tier unconfirmed
// anomaly until it's either persistent or explained.
const PERSISTENT_ACTION_REASON_CODES = new Set(['over_budget', 'pacing_over_budget', 'overspending_30d']);
// Below this dollar size, even a persistent issue doesn't rise above
// "review" — material dollar size is a required severity input.
const ACTION_DOLLAR_FLOOR = 300;
// A plan-pace shortfall below this is ordinary month-to-month noise, not a
// severity-relevant trajectory problem.
const PLAN_BEHIND_MATERIAL_FLOOR = 2000;

/** Per-insight severity — pure, derived from fields wealth-insights.js
 *  already attaches to every insight (never re-detected here). */
function itemSeverity(insight) {
  if (insight.explainedBy) return 'explained';
  if (insight.attentionClass === 'action_required') {
    const impact = insight.evidence?.impactDollars ?? insight.evidence?.actual ?? 0;
    if (PERSISTENT_ACTION_REASON_CODES.has(insight.reasonCode) && impact >= ACTION_DOLLAR_FLOOR) return 'action';
    return 'review'; // e.g. an unconfirmed spending_spike — worth confirming, not yet a decision
  }
  if (insight.attentionClass === 'watch') return 'review';
  return 'on_track'; // positive / informational
}

/**
 * Overall Wealth summary severity — computed FROM the child items' own
 * severities (never independently generated), plus the two whole-picture
 * signals no single insight carries: a genuinely critical cash position
 * (bills exceeding the buffer, or an already-negative buffer) and a
 * materially-behind financial plan. Priority order, each precondition
 * excluding the ones above it:
 *   1. unavailable — source data incomplete/stale/disconnected
 *   2. critical    — real, configured financial danger (cash), or an
 *                     item-level critical
 *   3. action       — at least one unresolved item needs a decision, or the
 *                      plan trajectory is materially off
 *   4. review       — at least one unresolved item is worth confirming
 *   5. on_track     — everything unresolved has been explained, or nothing
 *                      is wrong (summary is computed from unresolved
 *                      children only — an explained item never keeps the
 *                      summary elevated)
 */
function deriveSeverity({ dataComplete, itemSeverities = [], cashCritical = false, planBehindMaterial = false }) {
  if (!dataComplete) return 'unavailable';
  if (cashCritical || itemSeverities.includes('critical')) return 'critical';
  if (itemSeverities.includes('action') || planBehindMaterial) return 'action';
  if (itemSeverities.includes('review')) return 'review';
  return 'on_track';
}

/** Deterministic, non-LLM summary line — computed from the SAME counts the
 *  severity itself was computed from, so the top-level line can never
 *  disagree with its own children (e.g. "On track" while a red exception
 *  sits below it). */
function summaryLabel(severity, { actionCount = 0, reviewCount = 0 } = {}) {
  if (severity === 'unavailable') return 'Data incomplete';
  if (severity === 'critical') return 'Action needed';
  if (severity === 'action') return actionCount > 1 ? `Action needed · ${actionCount} items` : 'Action needed';
  if (severity === 'review') return reviewCount > 1 ? `On track · ${reviewCount} categories to review` : 'On track · 1 to review';
  return 'On track';
}

/** Pure: does `day` (a Date or 'YYYY-MM-DD') fall in the same calendar month
 *  as `asOf`, in UTC terms (matches how spendTransactions buckets days). */
function isCurrentMonth(day, asOf) {
  const d = new Date(day);
  return d.getUTCFullYear() === asOf.getUTCFullYear() && d.getUTCMonth() === asOf.getUTCMonth();
}

/**
 * For each spending_pattern spike, check whether ONE transaction this month
 * in that category explains most of the dollar overage — if so, annotate it
 * (`explainedBy`) and soften its title/attentionClass: a one-time purchase
 * the user already knows about is worth a quiet note, not an alert demanding
 * a decision (it already made one, purchasing). Pure w.r.t. its inputs; the
 * one I/O call (spendTransactions) is fetched once and reused for every
 * candidate rather than once per insight.
 */
async function annotateExplainedSpikes(insights, asOf) {
  const spikeCats = new Set(
    insights.filter((i) => i.type === 'spending_pattern' && i.evidence?.category).map((i) => i.evidence.category)
  );
  if (!spikeCats.size) return insights;

  let txns = [];
  try {
    txns = await documents.spendTransactions({ days: 35 });
  } catch {
    return insights; // best-effort — an explanation failing to load must never block the insight itself
  }
  const thisMonth = txns.filter((t) => isCurrentMonth(t.day, asOf));

  return insights.map((ins) => {
    if (ins.type !== 'spending_pattern' || !ins.evidence?.category) return ins;
    const impactDollars = ins.evidence.impactDollars;
    if (!(impactDollars > 0)) return ins;
    const inCat = thisMonth.filter((t) => t.category === ins.evidence.category);
    if (!inCat.length) return ins;
    const largest = inCat.reduce((a, b) => (b.amount > a.amount ? b : a), inCat[0]);
    if (largest.amount < impactDollars * EXPLAINS_SPIKE_SHARE) return ins;
    return {
      ...ins,
      title: `${ins.evidence.category}: a one-time ${largest.merchant} purchase explains most of the increase`,
      detail: `${ins.detail} A single ${fmt(largest.amount)} charge at ${largest.merchant} accounts for most of this — not an ongoing pattern.`,
      // A one-off, already-happened purchase isn't a decision to make now —
      // downgrade from action_required to watch (still worth a glance, not
      // an alert) unless the category is ALSO genuinely over its budget
      // (evidence carries no budget flag here, so this only ever softens a
      // pure run-rate spike, never a real over_budget card).
      attentionClass: 'watch', timeSensitive: false,
      explainedBy: { merchant: largest.merchant, amount: Math.round(largest.amount), day: String(largest.day) },
    };
  });
}

/**
 * Consolidate related-category spikes (RELATED_CATEGORY_GROUPS) into one
 * combined card so "Dining out" isn't three separate cards for Restaurants,
 * Fast Food, and Coffee Shops — summed dollars, never double-counted (each
 * source insight is removed once folded into its group's combined card).
 */
function consolidateRelatedCategories(insights) {
  const groups = new Map(); // groupLabel -> insights[]
  const ungrouped = [];
  for (const ins of insights) {
    const label = ins.type === 'spending_pattern' && ins.evidence?.category
      ? RELATED_CATEGORY_GROUPS[ins.evidence.category]
      : null;
    if (!label) { ungrouped.push(ins); continue; }
    const arr = groups.get(label) || [];
    arr.push(ins);
    groups.set(label, arr);
  }
  const combined = [];
  for (const [label, members] of groups) {
    if (members.length < 2) { ungrouped.push(...members); continue; }
    const totalImpact = members.reduce((s, m) => s + (m.evidence?.impactDollars || 0), 0);
    const cats = members.map((m) => m.evidence.category).join(', ');
    // Highest-attention member's class wins (never hide an action_required
    // member's urgency by averaging it away with quieter siblings).
    const worst = members.reduce((a, b) => (TIER_RANK[b.attentionClass] < TIER_RANK[a.attentionClass] ? b : a));
    combined.push({
      type: 'spending_pattern', tone: worst.tone, category: label,
      title: `${label}: ${fmt(totalImpact)} more than usual`,
      detail: `Combined across ${cats}, spending is running ${fmt(totalImpact)} above your recent average this month.`,
      evidence: { kind: 'spending_pattern', category: label, impactDollars: Math.round(totalImpact), consolidatedFrom: cats },
      attentionClass: worst.attentionClass, material: true, timeSensitive: worst.timeSensitive,
      actionable: true, direction: 'negative', reasonCode: 'spending_spike_consolidated',
      asOf: worst.asOf,
    });
  }
  return [...ungrouped, ...combined];
}

/**
 * Filter out insights whose dismiss key was dismissed, UNLESS the current
 * occurrence is materially larger than what was dismissed (REACTIVATE_
 * MULTIPLIER) — "stay suppressed until materially new evidence appears"
 * (acceptance criterion #9). An insight with no comparable dollar evidence,
 * or a dismissal with no recorded context (dismissed before this feature
 * existed, or a non-wealth dismissal), stays suppressed indefinitely —
 * matching today's behavior exactly (fail toward the existing contract).
 */
function applyWealthDismissals(insights, dismissedKeys, dismissedContext) {
  return insights
    .map((i) => ({ ...i, dismissKey: dismissedInsights.dismissKey(i) }))
    .filter((i) => {
      if (!dismissedKeys.has(i.dismissKey)) return true;
      const ctx = dismissedContext.get(i.dismissKey);
      const newAmount = i.evidence?.impactDollars ?? i.evidence?.actual ?? null;
      if (ctx?.amount != null && newAmount != null && newAmount >= ctx.amount * REACTIVATE_MULTIPLIER) return true;
      return false;
    });
}

/** Rank for "What Changed": action_required > watch > positive >
 *  informational (acceptance criteria's "urgent > materially off-plan >
 *  positive progress > informational"), preserving each tier's existing
 *  dollar-impact ordering from buildWealthInsights. Informational items only
 *  fill remaining slots — the landing page leads with what actually changed,
 *  not routine reassurance, but a slot is never left empty if something
 *  informational is genuinely the most relevant thing left to say. */
function rankForWhatChanged(insights) {
  const withIdx = insights.map((ins, i) => ({ ins, i }));
  withIdx.sort((a, b) => {
    const t = (TIER_RANK[a.ins.attentionClass] ?? 3) - (TIER_RANK[b.ins.attentionClass] ?? 3);
    if (t !== 0) return t;
    const ad = a.ins.evidence?.impactDollars, bd = b.ins.evidence?.impactDollars;
    if (typeof ad === 'number' && typeof bd === 'number' && ad !== bd) return bd - ad;
    return a.i - b.i;
  });
  return withIdx.map((x) => x.ins);
}

function toChangeCard(ins) {
  return {
    dismissKey: ins.dismissKey,
    type: ins.type,
    title: ins.title,
    detail: ins.detail,
    attentionClass: ins.attentionClass,
    severity: ins.severity,
    actionable: Boolean(ins.actionable),
    evidence: ins.evidence || null,
    explainedBy: ins.explainedBy || null,
  };
}

/** One safe, deterministic recommended action — driven ONLY by items whose
 *  own severity actually rose to 'action' or 'critical' (never a raw
 *  attentionClass:'action_required' item that severity downgraded to
 *  'review' — that's exactly the old contradiction where an item labeled
 *  "Not a concern" still drove a red recommended action). `cashCritical`
 *  (a real, configured danger) takes priority over the softer `cashflowThin`
 *  heads-up when both are true. Never manufactured when nothing warrants it. */
function deriveRecommendedAction(actionableItems, cashflowThin, cashCritical) {
  const top = actionableItems[0];
  if (top) {
    const dismissKey = top.dismissKey;
    if (top.reasonCode === 'overspending_30d') {
      return {
        kind: 'adjust_pace', title: 'Adjust this month’s discretionary pace',
        detail: top.detail, dismissKey, askPrompt: 'Help me adjust my spending pace for the rest of this month.',
      };
    }
    if (top.reasonCode === 'over_budget' || top.reasonCode === 'pacing_over_budget') {
      return {
        kind: 'review_budget', title: `Review ${top.category || 'this'} spending`,
        detail: top.detail, dismissKey, askPrompt: `Why is ${top.category || 'this category'} over budget, and what should I do?`,
      };
    }
    if (top.reasonCode === 'spending_spike') {
      return {
        kind: 'review_transaction', title: `Confirm ${top.category || 'this'} spike is expected`,
        detail: top.detail, dismissKey, askPrompt: `Is the ${top.category || ''} spending increase expected or should I look closer?`,
      };
    }
    return { kind: 'review', title: top.title, detail: top.detail, dismissKey, askPrompt: top.title };
  }
  if (cashCritical) {
    return {
      kind: 'cash_critical', title: 'Cash buffer won’t cover upcoming bills',
      detail: 'Upcoming recurring bills exceed your current cash buffer — move cash or delay a bill before it hits.',
      dismissKey: null, askPrompt: 'My cash buffer looks like it will go negative before upcoming bills clear — what should I do?',
    };
  }
  if (cashflowThin) {
    return {
      kind: 'move_cash', title: 'Check cash buffer before upcoming bills',
      detail: 'Upcoming recurring bills are large relative to your cash buffer.', dismissKey: null,
      askPrompt: 'Do I have enough cash buffer for upcoming bills?',
    };
  }
  return null;
}

/**
 * The canonical Wealth landing-page projection. Cheap (metric aggregates +
 * a couple of small store reads, no LLM) — safe to recompute on every
 * request, same design choice as todayCommandCenter.
 */
async function buildWealthLandingProjection({ asOf = new Date(), tz = process.env.TZ || 'America/New_York', wealthInsights: providedInsights = null } = {}) {
  const { canonicalSpendingMtd } = require('../brain/snapshot');
  const { computeDiscretionaryMatchedPace } = require('./wealth-pace');

  // A caller that already resolved the SAME authority this request (e.g.
  // briefing.js's full build, which threads its BrainSnapshot-resolved raw
  // insights through here) passes them in via `wealthInsights` so this
  // projection never triggers a second buildWealthInsights() call for the
  // same build — the exact "resolve each authority exactly once" invariant
  // BrainSnapshot exists to guarantee (see brain/snapshot.js).
  const insightsPromise = Array.isArray(providedInsights)
    ? Promise.resolve(providedInsights)
    : wealthInsightsMod.buildWealthInsights().catch(() => []);

  const [insightsRaw, spendingMtd, spendingPace, netWorthRow, savingsRate, netWorthTrend, sources, dismissedKeys, dismissedContext] =
    await Promise.all([
      insightsPromise,
      canonicalSpendingMtd(asOf, tz).catch(() => null),
      // Matched-pace baseline (median of the same elapsed-fraction-of-month
      // spend across trailing complete months) — reuses canonicalSpendingMtd
      // internally for the current-month figure, so it can never disagree
      // with `spendingMtd` above.
      computeDiscretionaryMatchedPace({ asOf, tz }).catch(() => null),
      metricsStore.latest({ domain: 'wealth', metric: 'net_worth' }).catch(() => null),
      wealthInsightsMod.computeSavingsRate({ now: asOf }).catch(() => null),
      wealthInsightsMod.computeNetWorthTrend({ now: asOf }).catch(() => null),
      sourcesStore.listSources().catch(() => []),
      dismissedInsights.dismissedKeys(),
      dismissedInsights.dismissedContextByKey(),
    ]);

  const monarchHealth = getMonarchHealth(sources, asOf.getTime());
  const dataComplete = monarchHealth.configured && monarchHealth.healthy;

  let cashflowThin = false;
  let cashBuffer = null;
  // A REAL configured risk (bills exceed the buffer, or the buffer is
  // already negative) — stricter than `thin`, and the only source-level
  // signal severe enough to earn 'critical' on its own. Reuses the SAME
  // computeCashflowLookahead() output `thin` already reads; no new
  // detection.
  let cashCritical = false;
  try {
    const monarchWealth = require('./monarch-wealth');
    if (monarchWealth.isConfigured()) {
      const [recurring, accountsData] = await Promise.all([
        monarchWealth.getRecurring().catch(() => null),
        monarchWealth.getAccounts().catch(() => null),
      ]);
      if (recurring) {
        const { computeCashflowLookahead } = require('../intelligence/cashflow-lookahead');
        const streams = [...(recurring.expenses || []), ...(recurring.creditCards || [])];
        const look = computeCashflowLookahead({ streams, accounts: accountsData?.accounts || [], asOf });
        cashflowThin = look.thin;
        cashBuffer = look.cashBuffer;
        cashCritical = look.cashBuffer != null && (look.cashBuffer < 0 || look.totalUpcoming > look.cashBuffer);
      }
    }
  } catch { /* best-effort — cash buffer is an optional posture-card number */ }

  // Plan pace (net worth vs. the financial plan), reusing the SAME loader
  // routes/wealth.js's GET /wealth/plan uses — not a second computation.
  let planPace = null;
  try {
    const { loadPlan } = require('./financial-plan');
    const plan = await loadPlan();
    const P = plan?.P;
    if (P?.startingLiquid != null && P?.planLiquidGrowth2026 != null && netWorthRow) {
      const planYear = asOf.getFullYear();
      const yearStart = new Date(`${planYear}-01-01T00:00:00`);
      const yearEnd = new Date(`${planYear + 1}-01-01T00:00:00`);
      const pctYear = Math.min(1, Math.max(0, (asOf - yearStart) / (yearEnd - yearStart)));
      const planLiquidAtPace = Math.round(P.startingLiquid + P.planLiquidGrowth2026 * pctYear);
      const netWorth = Number(netWorthRow.value);
      const delta = Math.round(netWorth - planLiquidAtPace);
      planPace = { planLiquidAtPace, delta, ahead: delta >= 0, pctYearElapsed: Math.round(pctYear * 100) };
    }
  } catch { /* best-effort — plan pace is optional, only shown when a plan exists */ }

  // Dismissal-aware (with reactivation) -> explain single-transaction
  // spikes -> consolidate related categories -> rank for "What Changed" ->
  // stamp each with its severity (the summary is computed FROM these, never
  // independently — required so an item can never disagree with the
  // top-level line).
  const dismissFiltered = applyWealthDismissals(insightsRaw, dismissedKeys, dismissedContext);
  const explained = await annotateExplainedSpikes(dismissFiltered, asOf);
  const consolidated = consolidateRelatedCategories(explained);
  const ranked = rankForWhatChanged(consolidated);
  const nonInformational = ranked.filter((i) => i.attentionClass !== 'informational');
  const informational = ranked.filter((i) => i.attentionClass === 'informational');
  const rankedWithSeverity = [...nonInformational, ...informational].map((i) => ({ ...i, severity: itemSeverity(i) }));
  const whatChanged = rankedWithSeverity.slice(0, 3).map(toChangeCard);

  const itemSeverities = rankedWithSeverity.map((i) => i.severity);
  const actionCount = itemSeverities.filter((s) => s === 'action' || s === 'critical').length;
  const reviewCount = itemSeverities.filter((s) => s === 'review').length;
  // "Ahead of plan" stays a POSITIVE FACT shown alongside the numbers
  // (numbers.planPace below) — it never elevates severity. Only a material
  // shortfall does, since that's an unresolved issue.
  const planAheadMaterial = Boolean(planPace && planPace.ahead && Math.abs(planPace.delta) >= 1000);
  const planBehindMaterial = Boolean(planPace && !planPace.ahead && Math.abs(planPace.delta) >= PLAN_BEHIND_MATERIAL_FLOOR);

  const severity = deriveSeverity({ dataComplete, itemSeverities, cashCritical, planBehindMaterial });
  const summary = summaryLabel(severity, { actionCount, reviewCount });

  const actionableItems = rankedWithSeverity.filter((i) => i.severity === 'action' || i.severity === 'critical');
  const recommendedAction = severity === 'unavailable' ? null : deriveRecommendedAction(actionableItems, cashflowThin, cashCritical);

  // Current-month category breakdown for the Spending drill-in — reuses the
  // exact same query/dedup wealth-insights.js's spike detector reads, just
  // the current month's raw totals rather than a vs-prior-average compare.
  let spendingDetail = [];
  try {
    const rows = await documents.monthlyCategorySpend({ months: 1 });
    const { isInternalTransfer } = require('../connectors/monarch');
    spendingDetail = rows
      .filter((r) => !isInternalTransfer(r.category))
      .map((r) => ({ category: r.category, amount: Math.round(r.spend) }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);
  } catch { /* best-effort — the Spending drill-in degrades to empty, not a crash */ }

  return {
    asOf: asOf.toISOString(),
    severity,
    summary,
    numbers: {
      // amount is the EXACT canonical MTD total, unchanged by this
      // projection's `comparison` block — the same number every surface
      // (Ask, briefing, Today) already reads via canonicalSpendingMtd.
      mtdDiscretionary: spendingMtd != null ? {
        amount: Math.round(spendingMtd),
        comparison: spendingPace && spendingPace.medianBaseline != null ? {
          coverageTier: spendingPace.coverageTier,
          monthsUsed: spendingPace.monthsUsed,
          monthsConsidered: spendingPace.monthsConsidered,
          medianBaseline: spendingPace.medianBaseline,
          vsMedian: spendingPace.vsMedian,
          paceLabel: spendingPace.paceLabel,
          previousMonthAmount: spendingPace.previousMonthAmount,
          vsPreviousMonth: spendingPace.vsPreviousMonth,
          drivers: spendingPace.drivers,
          monthsBreakdown: spendingPace.monthsBreakdown,
        } : null,
      } : null,
      savingsRate: savingsRate ? {
        ratePct: savingsRate.ratePct, income: savingsRate.income, spending: savingsRate.spending,
        windowDays: savingsRate.windowDays, healthy: savingsRate.positive,
      } : null,
      netWorth: netWorthRow ? {
        amount: Math.round(Number(netWorthRow.value)),
        asOf: netWorthRow.ts ? new Date(netWorthRow.ts).toISOString() : null,
        // No `projectedYearEnd` — a linear extrapolation of a short trailing
        // slope is misleading (market movement, transfers, equity comp, and
        // irregular cash flows are lumpy); only the factual trend itself is
        // reported. See numbers.planPace for progress vs. the actual plan.
        trend: netWorthTrend ? {
          monthlyChange: Math.round(netWorthTrend.monthlyChange), direction: netWorthTrend.direction,
          material: netWorthTrend.material,
        } : null,
      } : null,
      planPace,
      cashBuffer: cashBuffer != null ? { amount: Math.round(cashBuffer), thin: cashflowThin, critical: cashCritical } : null,
    },
    whatChanged,
    recommendedAction,
    sourceHealth: {
      configured: monarchHealth.configured, healthy: monarchHealth.healthy,
      freshestHoursAgo: monarchHealth.freshestHoursAgo != null ? Math.round(monarchHealth.freshestHoursAgo) : null,
      rows: monarchHealth.rows.map((r) => ({ id: r.id, hoursAgo: r.hoursAgo != null ? Math.round(r.hoursAgo) : null, isStale: r.isStale, lastError: r.lastError })),
      qualification: dataComplete ? null : 'Wealth data may be incomplete or out of date — Monarch hasn’t synced recently.',
    },
    spendingDetail,
  };
}

module.exports = {
  buildWealthLandingProjection,
  // Exported for tests / reuse — pure helpers, no I/O.
  itemSeverity, deriveSeverity, summaryLabel,
  rankForWhatChanged, applyWealthDismissals, consolidateRelatedCategories, annotateExplainedSpikes,
  REACTIVATE_MULTIPLIER, EXPLAINS_SPIKE_SHARE, ACTION_DOLLAR_FLOOR, PLAN_BEHIND_MATERIAL_FLOOR,
};
