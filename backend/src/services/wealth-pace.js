// Discretionary MTD "matched-pace" baseline. Answers: is the current
// month-to-date discretionary total unusual, by how much, and why — on top
// of, never instead of, the canonical discretionary-spending rule.
//
// Reuses (never redefines):
//   - services/discretionarySpend.js's discretionaryBreakdown — THE single
//     canonical predicate for "what counts as discretionary spend in this
//     date range", applied identically to the current month, the previous
//     month, and every historical month in the median pool. Wealth
//     matched-pace audit: this module used to sum the metrics table's
//     `wealth:spending_discretionary` row for historical months — those
//     rows carry whichever exclusion-rule version was live the day they
//     were written, with no marker to tell an old-definition row from a
//     current one, so a stale-definition month could silently sit in the
//     median pool and skew it. Computing every month LIVE from the
//     canonical `documents` transaction corpus removes that risk by
//     construction — there is no stored total to go stale.
//   - connectors/monarch.js's isFixedCategory/isInternalTransfer — the same
//     exclusion rules, applied by discretionarySpend.js and, separately,
//     to the per-category "driver" breakdown below.
//   - intelligence/stats.js's median — the aggregation itself (median, not
//     mean, so one vacation/annual-purchase month can't masquerade as
//     "typical").
//
// "Matched pace": comparing partial months fairly. Comparing day-28-of-July
// (31 days) against day-28-of-February (28/29 days) by raw day NUMBER isn't
// fair — day 28 is 90% through July but the ENTIRE month of February. So the
// historical comparison window for a prior month is always that month's own
// ELAPSED FRACTION (rounded to a whole day), never a fixed day number — this
// is what makes 28/30/31-day months and February compare fairly.
'use strict';

const CATEGORY_MIN_SPEND = 50;
// A category's matched-window MEDIAN must clear this before the category can
// be called a spike at all — see the guard in computeDiscretionaryMatchedPace
// for why comparing against a ~$0 baseline is meaningless rather than merely
// noisy. Mirrors the degraded fallback path's own `avg < MIN_SPEND` skip
// (wealth-insights.js), which the canonical path was missing.
const CATEGORY_MIN_BASELINE = 50;
// A category must contribute at least this many dollars of excess above its
// own matched-pace median to be named a "driver" — mirrors wealth-insights.js's
// SPIKE_DOLLARS convention (dollar-impact discipline over raw percentage).
const CATEGORY_EXCESS_DOLLAR_FLOOR = 100;
// Below this baseline, a percentage comparison is mostly a tiny-denominator
// artifact — mirrors wealth-insights.js's SMALL_BASELINE_FOR_PCT.
const MIN_MEANINGFUL_BASELINE = 150;
// A dollar swing smaller than this is noise, not a pace worth labeling.
const PACE_MIN_DOLLARS = 50;
// Language-threshold audit: within +/-10% of the median reads as "in line
// with typical." 10-20% either side reads as "slightly" below/above;
// beyond 20% either side reads as "comfortably" below / a caution-worthy
// amount above. Deliberately SYMMETRIC — the old asymmetric bands (a
// single "below_typical" bucket for anything past -10%, but a separate
// 35%-cut "well_above" tier only on the high side) were the actual root
// cause of an 11%-below month rendering "comfortably below pace": there
// was no "slightly below" label for the copy layer to reach for at all.
const PACE_NEAR_BAND = 0.10;
const PACE_FAR_BAND = 0.20;
const MAX_DRIVERS = 2;
// Coverage floor (Wealth matched-pace audit): fewer than this many
// comparable trailing months and the percentage/median comparison is
// suppressed entirely — never a "recent, provisional" comparison from too
// thin a sample. See computeDiscretionaryMatchedPace's coverageTier.
const MIN_COMPARABLE_MONTHS = 6;
// Recompute/backfill window (Wealth matched-pace audit): at least 13
// trailing months, so a 12-month "same month last year" comparison is
// always in reach once the account has that much history.
const DEFAULT_MONTHS_BACK = 13;

/** Y/M/D integers for `asOf`'s LOCAL calendar date in `tz` — the one place
 *  this module reads a wall-clock moment; every other function below works
 *  in pure Y/M/D integer arithmetic so DST and month-length are never a
 *  source of bugs (no millisecond arithmetic ever crosses a month/DST
 *  boundary here). */
function localYmd(tz, asOf) {
  const ymd = asOf.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const [y, m, d] = ymd.split('-').map(Number);
  return { y, m, d };
}

/** Days in calendar month `m` (1-indexed) of year `y`. `Date.UTC(y, m, 0)` is
 *  "day 0 of month m" = the last day of month m-1 in 0-indexed terms, which
 *  is exactly month `m` in 1-indexed terms — and JS's own leap-year rule
 *  handles February automatically. */
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The {y, m} of the month `monthsAgo` before local month {y, m} (0 = same
 *  month, 1 = the prior month, …) — pure integer arithmetic, no Date-object
 *  month-rollover surprises. */
function monthOffset(y, m, monthsAgo) {
  const total = y * 12 + (m - 1) - monthsAgo;
  const ty = Math.floor(total / 12);
  const tm = (((total % 12) + 12) % 12) + 1;
  return { y: ty, m: tm };
}

/** The day-of-month in a target month that "matches" `elapsedDays` of
 *  `daysInCurrentMonth` — the same ELAPSED FRACTION of the month, rounded,
 *  clamped to the target month's own length (so a day-31 current-month
 *  fraction compared against a 28-day February matches at February's day 28
 *  — its whole month — never an out-of-range day). Always at least 1. */
function matchedDayOfMonth(elapsedDays, daysInCurrentMonth, daysInTargetMonth) {
  if (!(daysInCurrentMonth > 0)) return 1;
  const frac = elapsedDays / daysInCurrentMonth;
  const day = Math.round(frac * daysInTargetMonth);
  return Math.min(daysInTargetMonth, Math.max(1, day));
}

const pad2 = (n) => String(n).padStart(2, '0');
const ymdStr = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

/** UTC instant for the day-KEYED metric boundary of local Y-M-D — matches
 *  monarch.js's `dayTs` convention (a metric for local day X is stored at
 *  `${X}T00:00:00Z`, NOT true local midnight); see brain/snapshot.js's
 *  canonicalSpendingMtd comment for why this exact anchor matters for the
 *  `wealth:spending_discretionary` metric specifically. Only for the metrics
 *  table — category queries against `documents` use plain Y-M-D strings
 *  instead (see categorySpendInRange's date-only comparison). */
function dayKeyUtc(y, m, d) {
  return new Date(`${ymdStr(y, m, d)}T00:00:00Z`);
}

/** Qualitative pace label — SYMMETRIC 5-band scheme (Wealth matched-pace
 *  audit): within +/-10% is 'in_line'; 10-20% either side is 'slightly_*';
 *  beyond 20% either side is 'comfortably_below' / 'comfortably_above'.
 *  Deliberately NOT a severity/color decision — wealth-landing.js's
 *  deriveSeverity already combines spending pace with savings rate, plan
 *  pace, and cash into ONE overall severity; this label is descriptive
 *  context sitting inside that same card, never an independent warning of
 *  its own. */
function paceLabelFor(dollars, ratio) {
  if (Math.abs(dollars) < PACE_MIN_DOLLARS) return 'in_line';
  if (ratio <= 1 - PACE_FAR_BAND) return 'comfortably_below';
  if (ratio < 1 - PACE_NEAR_BAND) return 'slightly_below';
  if (ratio <= 1 + PACE_NEAR_BAND) return 'in_line';
  if (ratio < 1 + PACE_FAR_BAND) return 'slightly_above';
  return 'comfortably_above';
}

/** Percentage difference vs. a baseline, or null when the baseline is zero
 *  or too small for a percentage to mean anything (truth-and-evidence
 *  contract: never lead with a manufactured-looking percentage against a
 *  tiny denominator). */
function pctOrNull(dollars, baseline) {
  if (baseline == null || baseline < MIN_MEANINGFUL_BASELINE) return null;
  return Math.round((dollars / baseline) * 100);
}

/**
 * The discretionary MTD matched-pace baseline: current MTD total vs. the
 * MEDIAN of the same elapsed-fraction-of-month spend in each of the trailing
 * `monthsBack` complete months (only months with full transaction coverage
 * for their own matched window count toward the median), plus the top
 * categories driving any material excess. Current, previous, and every
 * historical month are computed through the SAME canonical predicate
 * (discretionarySpend.js's discretionaryBreakdown) — never a mix of a
 * metrics-table figure for one side and a transaction-derived figure for
 * the other.
 */
async function computeDiscretionaryMatchedPace({ asOf = new Date(), tz = process.env.TZ || 'America/New_York', monthsBack = DEFAULT_MONTHS_BACK } = {}) {
  const { batchDiscretionaryBreakdown, earliestMonarchDocumentDate } = require('./discretionarySpend');
  const { median } = require('../intelligence/stats');
  const coverageIntervals = require('./coverageIntervals');
  const sourcesStore = require('../store/sources');

  const { y, m, d: elapsedDays } = localYmd(tz, asOf);
  const daysInCurrentMonth = daysInMonth(y, m);
  const currentMonthStartYmd = ymdStr(y, m, 1);
  const todayYmd = ymdStr(y, m, elapsedDays);

  const empty = {
    currentAmount: null,
    asOf: asOf.toISOString(), elapsedDays, daysInCurrentMonth,
    monthsConsidered: 0, monthsUsed: 0, coverageTier: 'insufficient',
    medianBaseline: null, vsMedian: null, paceLabel: null,
    previousMonthAmount: null, vsPreviousMonth: null, drivers: [], categoryBreakdown: [], monthsBreakdown: [],
  };

  // Every current + historical window this call needs, resolved together —
  // Wealth matched-pace hardening pass, efficiency requirement: ONE bounded
  // transaction query covers the full set (batchDiscretionaryBreakdown),
  // replacing what used to be one discretionaryBreakdown query PER window
  // (up to 14 sequential round trips on every cache serve). earliestDate and
  // the source's coverage-interval record are independent single-row
  // lookups, fetched in parallel with the batch query rather than adding to
  // its critical path.
  const monthTargets = [];
  const windowSpecs = [{ key: 'current', fromYmd: currentMonthStartYmd, toYmd: todayYmd }];
  for (let monthsAgo = 1; monthsAgo <= monthsBack; monthsAgo++) {
    const target = monthOffset(y, m, monthsAgo);
    const targetDaysInMonth = daysInMonth(target.y, target.m);
    const matchedDay = matchedDayOfMonth(elapsedDays, daysInCurrentMonth, targetDaysInMonth);
    const fromYmd = ymdStr(target.y, target.m, 1);
    const toYmd = ymdStr(target.y, target.m, matchedDay);
    monthTargets.push({ monthsAgo, target, matchedDay, fromYmd, toYmd });
    windowSpecs.push({ key: `h${monthsAgo}`, fromYmd, toYmd });
  }

  const [earliestDate, breakdowns, sourceRow] = await Promise.all([
    earliestMonarchDocumentDate(),
    batchDiscretionaryBreakdown(windowSpecs),
    sourcesStore.getSource('monarch'),
  ]);
  // No Monarch transaction data at all yet, or none as of this month's
  // start — could mean genuinely nothing spent, or the source hasn't
  // synced this month yet. Either way there's nothing honest to compare
  // against — omit rather than invent a $0 pace (never interpret missing
  // transactions as zero spending).
  if (earliestDate == null || earliestDate > currentMonthStartYmd) return empty;

  const currentBreakdown = breakdowns.current;
  const currentAmount = currentBreakdown.discretionaryTotal;

  // Coverage floor: a historical month is only eligible if its ENTIRE
  // matched window is provably covered by a real sync, not merely "the
  // account's earliest-ever document is before this window started" (a
  // failed backfill or a gap between two disjoint imports can leave a real
  // hole inside an otherwise-old account). Prefer the genuine coverage-
  // interval record; fall back to the earliest-document heuristic only for
  // a source that hasn't recorded any coverage intervals yet (accounts
  // that haven't re-synced since this tracking shipped) — see the final
  // report's disclosed-limitations section.
  const coverageSet = sourceRow?.config?.coverageIntervals;
  const hasCoverageRecord = Array.isArray(coverageSet) && coverageSet.length > 0;

  const monthsBreakdown = [];
  for (const mt of monthTargets) {
    const breakdown = breakdowns[`h${mt.monthsAgo}`];
    const eligible = hasCoverageRecord
      ? coverageIntervals.isFullyCovered(coverageSet, mt.fromYmd, mt.toYmd)
      : earliestDate <= mt.fromYmd;
    monthsBreakdown.push({
      monthsAgo: mt.monthsAgo, ym: `${mt.target.y}-${pad2(mt.target.m)}`, matchedDay: mt.matchedDay,
      amount: breakdown.discretionaryTotal, eligible,
      // Reconciliation report (Wealth matched-pace hardening pass): which
      // eligibility check actually decided this month, and the gross/refund
      // split behind its discretionary total — see discretionarySpend.js's
      // breakdownFromRows doc comment for the exact reconciliation identity.
      coverageVerdict: hasCoverageRecord ? 'coverage_record' : 'earliest_document_fallback',
      discretionaryGrossPurchases: breakdown.discretionaryGrossPurchases,
      discretionaryRefundsNetted: breakdown.discretionaryRefundsNetted,
      totalEconomicSpend: breakdown.totalEconomicSpend,
      fixedExcluded: breakdown.fixedExcluded, transfersExcluded: breakdown.transfersExcluded,
      source: breakdown.source, definitionVersion: breakdown.definitionVersion,
    });
  }

  const eligibleAmounts = monthsBreakdown.filter((mo) => mo.eligible).map((mo) => mo.amount);
  const monthsUsed = eligibleAmounts.length;
  // Coverage safeguard (Wealth matched-pace audit, tightened): fewer than
  // MIN_COMPARABLE_MONTHS (6) eligible months -> suppress the comparison
  // ENTIRELY (never a "recent, provisional" percentage from too thin a
  // sample) — the caller shows a neutral "historical comparison
  // unavailable" state instead. 6-13 eligible months -> "typical".
  const coverageTier = monthsUsed >= MIN_COMPARABLE_MONTHS ? 'typical' : 'insufficient';
  const medianBaseline = monthsUsed >= MIN_COMPARABLE_MONTHS ? median(eligibleAmounts) : null;

  let vsMedian = null;
  let paceLabel = null;
  if (medianBaseline != null) {
    const dollars = Math.round(currentAmount - medianBaseline);
    const ratio = medianBaseline > 0 ? currentAmount / medianBaseline : (currentAmount > 0 ? Infinity : 1);
    paceLabel = paceLabelFor(dollars, ratio);
    vsMedian = { dollars, pct: pctOrNull(dollars, medianBaseline) };
  }

  const prevMonth = monthsBreakdown.find((mo) => mo.monthsAgo === 1);
  let previousMonthAmount = null;
  let vsPreviousMonth = null;
  if (prevMonth && prevMonth.eligible) {
    previousMonthAmount = Math.round(prevMonth.amount);
    const dollars = Math.round(currentAmount - prevMonth.amount);
    vsPreviousMonth = { dollars, pct: pctOrNull(dollars, prevMonth.amount) };
  }

  // Category breakdown: EVERY category's current spend vs. the median of
  // that SAME category across the same matched-elapsed-fraction historical
  // windows already resolved above — the one canonical "vs your usual"
  // figure per category/month, computed whenever there's enough matched-
  // window coverage to trust a median at all (coverageTier === 'typical'),
  // independent of whether the OVERALL month happens to be running over
  // pace. This is deliberately the single source every consumer that needs
  // a per-category "how much more than usual" figure reads from — including
  // wealth-insights.js's spending_pattern spike cards (see its buildWealthInsights
  // `spendingPace` param) — so the same category/month is never explained by
  // two independently-computed baselines on the same screen (the Wealth
  // hardening audit's regression: the top card's "Driven by Clothing +$2,852"
  // and the "Worth a look" list's "Clothing: $3,125 more than usual" used to
  // disagree because wealth-insights.js computed its own mean-of-3-full-months
  // baseline from documents.monthlyCategorySpend instead of reading this).
  let categoryBreakdown = [];
  let drivers = [];
  if (coverageTier === 'typical') {
    const eligibleMonths = monthsBreakdown.filter((mo) => mo.eligible);
    // Reuse the SAME batch breakdown resolved above — discretionaryByCategory
    // already excludes transfers/fixed via discretionarySpend.js's classify(),
    // so no extra query (and no separate transfer/fixed filtering) is needed
    // here at all.
    const currentByCat = new Map(currentBreakdown.discretionaryByCategory.map((r) => [r.category, r.amount]));
    const histByCat = new Map(); // category -> [amounts across eligible months]
    for (const mo of eligibleMonths) {
      const rows = breakdowns[`h${mo.monthsAgo}`].discretionaryByCategory;
      for (const r of rows) {
        if (!histByCat.has(r.category)) histByCat.set(r.category, []);
        histByCat.get(r.category).push(r.amount);
      }
    }
    const candidates = [];
    for (const [category, currentSpend] of currentByCat) {
      if (currentSpend < CATEGORY_MIN_SPEND) continue;
      // A category absent from SOME eligible months still gets a fair
      // median — pad with $0 for months it wasn't spent in at all, so one
      // busy month can't read as "always this high."
      const amounts = histByCat.get(category) || [];
      const padded = [...amounts, ...Array(Math.max(0, eligibleMonths.length - amounts.length)).fill(0)];
      const catMedian = median(padded) ?? 0;
      // A category whose matched-window median is essentially zero has no
      // comparable history in THIS window — calling that a "spike" compares
      // against an empty denominator and manufactures alarm out of nothing
      // ("$101 more than usual", usual = $0). This bites hardest in the
      // first days of a month, when the matched window is only 1-3 days
      // long and nearly every category's median is $0, so every ordinary
      // purchase reads as a spike. The degraded fallback path already had
      // the equivalent guard (wealth-insights.js's `avg < MIN_SPEND`
      // skip); the canonical path was missing it, which is exactly how a
      // $101 Entertainment charge on Aug 3 surfaced as a Radar card
      // against a $0 baseline. Self-resolves as the month fills in.
      if (catMedian < CATEGORY_MIN_BASELINE) continue;
      const excessDollars = Math.round(currentSpend - catMedian);
      if (excessDollars < CATEGORY_EXCESS_DOLLAR_FLOOR) continue;
      candidates.push({
        category, currentAmount: Math.round(currentSpend), matchedMedian: Math.round(catMedian),
        excessDollars, pct: pctOrNull(excessDollars, catMedian),
      });
    }
    candidates.sort((a, b) => b.excessDollars - a.excessDollars);
    categoryBreakdown = candidates;
    // "Drivers" (the top card's "Driven by X and Y" line) only names names
    // when the OVERALL month is materially above pace — never implying "the
    // month is over because of X" when the month isn't actually over at all.
    // categoryBreakdown above stays available regardless, for surfaces (like
    // wealth-insights.js) that flag a per-category spike on its own terms.
    if (medianBaseline != null && vsMedian && vsMedian.dollars >= CATEGORY_EXCESS_DOLLAR_FLOOR) {
      drivers = candidates.slice(0, MAX_DRIVERS);
    }
  }

  return {
    currentAmount: Math.round(currentAmount), asOf: asOf.toISOString(), elapsedDays, daysInCurrentMonth,
    monthsConsidered: monthsBreakdown.length, monthsUsed, coverageTier,
    medianBaseline: medianBaseline != null ? Math.round(medianBaseline) : null,
    vsMedian, paceLabel, previousMonthAmount, vsPreviousMonth, drivers, categoryBreakdown, monthsBreakdown,
    // Auditable current-month breakdown (Wealth matched-pace audit,
    // requirement 1-4): total economic spend, the fixed/transfer
    // exclusions with categories/amounts, and the resulting discretionary
    // total — the SAME shape as each monthsBreakdown entry, so the current
    // month and every historical month can be reconciled side by side.
    totalEconomicSpend: currentBreakdown.totalEconomicSpend,
    discretionaryGrossPurchases: currentBreakdown.discretionaryGrossPurchases,
    discretionaryRefundsNetted: currentBreakdown.discretionaryRefundsNetted,
    fixedExcluded: currentBreakdown.fixedExcluded,
    transfersExcluded: currentBreakdown.transfersExcluded,
    definitionVersion: currentBreakdown.definitionVersion,
  };
}

module.exports = {
  computeDiscretionaryMatchedPace,
  // Pure helpers exported for unit testing without a database.
  localYmd, daysInMonth, monthOffset, matchedDayOfMonth, dayKeyUtc, paceLabelFor, pctOrNull,
  CATEGORY_MIN_SPEND, CATEGORY_MIN_BASELINE, CATEGORY_EXCESS_DOLLAR_FLOOR, MIN_MEANINGFUL_BASELINE,
  PACE_MIN_DOLLARS, PACE_NEAR_BAND, PACE_FAR_BAND, MIN_COMPARABLE_MONTHS, DEFAULT_MONTHS_BACK, MAX_DRIVERS,
};
