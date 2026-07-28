// Discretionary MTD "matched-pace" baseline. Answers: is the current
// month-to-date discretionary total unusual, by how much, and why — on top
// of, never instead of, the canonical discretionary-spending rule.
//
// Reuses (never redefines):
//   - brain/snapshot.js's canonicalSpendingMtd — the exact current MTD total.
//   - connectors/monarch.js's isFixedCategory/isInternalTransfer — the same
//     exclusion rules (rent/mortgage, transfers/CC-payments) applied to the
//     per-category "driver" breakdown below.
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
// A category must contribute at least this many dollars of excess above its
// own matched-pace median to be named a "driver" — mirrors wealth-insights.js's
// SPIKE_DOLLARS convention (dollar-impact discipline over raw percentage).
const CATEGORY_EXCESS_DOLLAR_FLOOR = 100;
// Below this baseline, a percentage comparison is mostly a tiny-denominator
// artifact — mirrors wealth-insights.js's SMALL_BASELINE_FOR_PCT.
const MIN_MEANINGFUL_BASELINE = 150;
// A dollar swing smaller than this is noise, not a pace worth labeling.
const PACE_MIN_DOLLARS = 50;
// Within +/-10% of the median reads as "near typical pace."
const PACE_NEAR_BAND = 0.10;
// 10%-35% above the median reads as "above typical pace"; beyond that,
// "well above typical pace."
const PACE_ABOVE_BAND = 0.35;
const MAX_DRIVERS = 2;

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

/** Qualitative pace label. Deliberately NOT a severity/color decision —
 *  wealth-landing.js's deriveSeverity already combines spending pace with
 *  savings rate, plan pace, and cash into ONE overall severity; this label is
 *  descriptive context sitting inside that same card, never an independent
 *  warning of its own. */
function paceLabelFor(dollars, ratio) {
  if (Math.abs(dollars) < PACE_MIN_DOLLARS) return 'near_typical';
  if (ratio <= 1 - PACE_NEAR_BAND) return 'below_typical';
  if (ratio < 1 + PACE_NEAR_BAND) return 'near_typical';
  if (ratio < 1 + PACE_ABOVE_BAND) return 'above_typical';
  return 'well_above_typical';
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
 * categories driving any material excess.
 */
async function computeDiscretionaryMatchedPace({ asOf = new Date(), tz = process.env.TZ || 'America/New_York', monthsBack = 12 } = {}) {
  const metricsStore = require('../store/metrics');
  const documents = require('../store/documents');
  const { canonicalSpendingMtd } = require('../brain/snapshot');
  const { median } = require('../intelligence/stats');
  const { isInternalTransfer, isFixedCategory } = require('../connectors/monarch');

  const currentAmount = await canonicalSpendingMtd(asOf, tz);
  const { y, m, d: elapsedDays } = localYmd(tz, asOf);
  const daysInCurrentMonth = daysInMonth(y, m);

  const empty = {
    currentAmount: currentAmount != null ? Math.round(currentAmount) : null,
    asOf: asOf.toISOString(), elapsedDays, daysInCurrentMonth,
    monthsConsidered: 0, monthsUsed: 0, coverageTier: 'insufficient',
    medianBaseline: null, vsMedian: null, paceLabel: null,
    previousMonthAmount: null, vsPreviousMonth: null, drivers: [], monthsBreakdown: [],
  };
  // No discretionary spend recorded yet this month at all — could mean
  // genuinely nothing spent, or the source hasn't synced this month yet.
  // Either way there's nothing honest to compare against — omit rather than
  // invent a $0 pace (never interpret missing transactions as zero spending).
  if (currentAmount == null) return empty;

  const monthsBreakdown = [];
  for (let monthsAgo = 1; monthsAgo <= monthsBack; monthsAgo++) {
    const target = monthOffset(y, m, monthsAgo);
    const targetDaysInMonth = daysInMonth(target.y, target.m);
    const matchedDay = matchedDayOfMonth(elapsedDays, daysInCurrentMonth, targetDaysInMonth);
    const from = dayKeyUtc(target.y, target.m, 1);
    const to = dayKeyUtc(target.y, target.m, matchedDay);
    // eslint-disable-next-line no-await-in-loop -- each iteration's range depends only on constants computed above; sequential is simplest and this runs at most 12 times.
    const rows = await metricsStore.dailyAggregate({
      domain: 'wealth', metric: 'spending_discretionary', from, to, agg: 'sum', excludeSource: 'seed', tz,
    });
    const amount = rows.reduce((a, r) => a + Number(r.value || 0), 0);
    // The daily sync writes a zero-filled row for every day it tracks (see
    // monarch-mcp-sync.js) — so a PRESENT row can be trusted even at $0, but
    // a MISSING row for a day inside the matched window means the account
    // wasn't yet connected / that day never synced: a real gap, not a quiet
    // day. Never treat a gap as $0 spend — require every day present.
    const eligible = rows.length >= matchedDay;
    monthsBreakdown.push({ monthsAgo, ym: `${target.y}-${pad2(target.m)}`, matchedDay, amount, eligible });
  }

  const eligibleAmounts = monthsBreakdown.filter((mo) => mo.eligible).map((mo) => mo.amount);
  const monthsUsed = eligibleAmounts.length;
  // Coverage safeguard: 6-12 eligible months -> "typical pace"; 3-5 ->
  // "recent pace"; fewer than 3 -> omit the historical comparison entirely
  // rather than invent certainty from too little history.
  const coverageTier = monthsUsed >= 6 ? 'typical' : monthsUsed >= 3 ? 'recent' : 'insufficient';
  const medianBaseline = monthsUsed >= 3 ? median(eligibleAmounts) : null;

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

  // Drivers: which categories account for the excess above the matched
  // historical median — only computed when spending is materially above
  // pace and there's a real baseline to explain it against. Never manufactured
  // when nothing meaningful is elevated.
  let drivers = [];
  if (medianBaseline != null && vsMedian && vsMedian.dollars >= CATEGORY_EXCESS_DOLLAR_FLOOR) {
    const eligibleMonths = monthsBreakdown.filter((mo) => mo.eligible);
    const todayYmd = ymdStr(y, m, elapsedDays);
    const [currentCats, ...historicalCats] = await Promise.all([
      documents.categorySpendInRange({ fromYmd: ymdStr(y, m, 1), toYmd: todayYmd }),
      ...eligibleMonths.map((mo) => {
        const target = monthOffset(y, m, mo.monthsAgo);
        return documents.categorySpendInRange({
          fromYmd: ymdStr(target.y, target.m, 1), toYmd: ymdStr(target.y, target.m, mo.matchedDay),
        });
      }),
    ]);
    const clean = (rows) => rows.filter((r) => !isInternalTransfer(r.category) && !isFixedCategory(r.category));
    const currentByCat = new Map(clean(currentCats).map((r) => [r.category, r.spend]));
    const histByCat = new Map(); // category -> [amounts across eligible months]
    for (const rows of historicalCats.map(clean)) {
      for (const r of rows) {
        if (!histByCat.has(r.category)) histByCat.set(r.category, []);
        histByCat.get(r.category).push(r.spend);
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
      const excessDollars = Math.round(currentSpend - catMedian);
      if (excessDollars < CATEGORY_EXCESS_DOLLAR_FLOOR) continue;
      candidates.push({
        category, currentAmount: Math.round(currentSpend), matchedMedian: Math.round(catMedian),
        excessDollars, pct: pctOrNull(excessDollars, catMedian),
      });
    }
    candidates.sort((a, b) => b.excessDollars - a.excessDollars);
    drivers = candidates.slice(0, MAX_DRIVERS);
  }

  return {
    currentAmount: Math.round(currentAmount), asOf: asOf.toISOString(), elapsedDays, daysInCurrentMonth,
    monthsConsidered: monthsBreakdown.length, monthsUsed, coverageTier,
    medianBaseline: medianBaseline != null ? Math.round(medianBaseline) : null,
    vsMedian, paceLabel, previousMonthAmount, vsPreviousMonth, drivers, monthsBreakdown,
  };
}

module.exports = {
  computeDiscretionaryMatchedPace,
  // Pure helpers exported for unit testing without a database.
  localYmd, daysInMonth, monthOffset, matchedDayOfMonth, dayKeyUtc, paceLabelFor, pctOrNull,
  CATEGORY_MIN_SPEND, CATEGORY_EXCESS_DOLLAR_FLOOR, MIN_MEANINGFUL_BASELINE,
  PACE_MIN_DOLLARS, PACE_NEAR_BAND, PACE_ABOVE_BAND, MAX_DRIVERS,
};
