// Goal achievement-probability forecasting (Phase 6).
//
// Turns a tracked goal (current metric level + target_value + target_date) into
// a forward-looking estimate: where the current trend is headed, when it would
// reach the target, and the probability of hitting the target by its date.
//
// The math is a least-squares trend projection with normal-distributed
// uncertainty that grows with the forecast horizon. Pure and deterministic —
// `forecastGoal` / `computeForecasts` take data in and return finding objects,
// so they're unit-testable without a database.
const stats = require('./stats');
const cat = require('./catalog');
const { formatDate, daysBetween, addDays } = require('../util/date');

// Tuning.
const FIT_WINDOW = 30; // days of recent history to fit the trend on
const MIN_POINTS = 4; // below this, decline to forecast
const ON_TRACK = 0.7; // P(hit) at/above this → on track
const AT_RISK = 0.35; // between this and ON_TRACK → at risk; below → off track
const MAX_HORIZON_DAYS = 5 * 365; // cap "projected date" extrapolation

function round(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function pct(p) {
  return `${Math.round(p * 100)}%`;
}

function statusFor(probability) {
  if (probability >= ON_TRACK) return 'on_track';
  if (probability >= AT_RISK) return 'at_risk';
  return 'off_track';
}

/**
 * Forecast a single goal from its metric's daily series.
 *
 * @param {object} goal - row from `goals` (domain, metric, title, target_value,
 *   baseline_value, target_date, unit, id)
 * @param {Array<{day?: any, ts?: any, value: number}>} series - ascending daily series
 * @param {{asOf?: Date}} [opts]
 * @returns {object|null} a finding-shaped forecast, or null if the goal isn't
 *   metric-bound / has no target.
 */
function forecastGoal(goal, series = [], opts = {}) {
  if (!goal || !goal.metric || goal.target_value == null) return null;

  const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
  const domain = goal.domain;
  const label = cat.label(domain, goal.metric);
  const unit = goal.unit ? `${goal.unit}` : '';
  const u = unit ? ` ${unit}` : '';
  const target = Number(goal.target_value);
  const metricKey = `${domain}:${goal.metric}`;

  const base = {
    type: 'forecast',
    domains: [domain],
    evidence: { auto: true, kind: 'forecast', goalId: goal.id, metric: metricKey },
  };

  const values = series
    .map((p) => Number(p.value))
    .filter((v) => Number.isFinite(v));

  // Not enough signal to project — surface the goal, but say so plainly.
  if (values.length < MIN_POINTS) {
    return {
      ...base,
      title: `${goal.title}: not enough data to forecast yet`,
      detail: `Tracking ${label} toward ${round(target)}${u}, but only ${values.length} day(s) of history. Need at least ${MIN_POINTS}.`,
      confidence: null,
      evidence: { ...base.evidence, status: 'insufficient_data', current: round(values.at(-1) ?? null), target: round(target) },
    };
  }

  // Fit against REAL calendar days (not sample index), so the slope is genuinely
  // per-day even when the metric is logged irregularly. Falls back to index-fit
  // if the series lacks usable day stamps.
  const recentSeries = series.slice(-FIT_WINDOW);
  const recent = recentSeries.map((p) => Number(p.value)).filter(Number.isFinite);
  const dayFit = stats.fitByDay(recentSeries);
  const fit = dayFit || stats.linearFit(recent);
  const slopePerDay = fit?.slope ?? 0;
  // Fitted current level (smoother than the raw last point) at the latest x.
  const lastX = dayFit ? dayFit.lastX : recent.length - 1;
  const current = fit ? fit.intercept + fit.slope * lastX : recent.at(-1);
  const baseline = goal.baseline_value != null ? Number(goal.baseline_value) : recent[0];

  // Which way is "toward the target" from where we are now?
  const needUp = target >= current;
  const achieved = needUp ? current >= target : current <= target;

  // When would the current trend cross the target? (independent of target_date)
  let projectedDate = null;
  let daysToTarget = null;
  if (!achieved && slopePerDay !== 0) {
    const d = (target - current) / slopePerDay;
    if (d > 0 && d <= MAX_HORIZON_DAYS) {
      daysToTarget = d;
      projectedDate = addDays(asOf, Math.ceil(d));
    }
  } else if (achieved) {
    daysToTarget = 0;
    projectedDate = asOf;
  }

  // Probability of hitting the target by target_date, if there is one.
  let probability = null;
  let projectedValue = null;
  let daysRemaining = null;
  if (goal.target_date) {
    daysRemaining = Math.max(0, daysBetween(asOf, goal.target_date));
    projectedValue = current + slopePerDay * daysRemaining;
    if (achieved && daysRemaining === 0) {
      probability = 1;
    } else {
      // Statistically correct OLS prediction interval at the target date, rather
      // than the dimensionally-wrong residualStd·√horizon random-walk guess.
      const x0 = lastX + daysRemaining; // day offset of the target date in the fit's frame
      const eps = Math.max(1e-9, 0.01 * Math.abs(target - baseline));
      const sd = Math.max(stats.predictionSE(fit, x0) ?? (fit?.residualStd ?? 0), eps);
      const z = (projectedValue - target) / sd;
      probability = needUp ? stats.normalCdf(z) : stats.normalCdf(-z);
    }
  }

  // Confidence: the probability when we have one; otherwise a trend-strength
  // proxy bounded to [0,1] so the briefing can rank these against other findings.
  const status = probability == null
    ? (projectedDate ? 'on_pace' : 'stalled')
    : statusFor(probability);

  const byClause = goal.target_date ? ` by ${formatDate(goal.target_date)}` : '';
  let title;
  if (probability != null) {
    title = `${goal.title}: ${pct(probability)} likely to hit ${round(target)}${u}${byClause}`;
  } else if (projectedDate) {
    title = `${goal.title}: on pace to reach ${round(target)}${u} around ${formatDate(projectedDate)}`;
  } else {
    title = `${goal.title}: not on pace to reach ${round(target)}${u} at the current trend`;
  }

  const perDay = round(slopePerDay, 3);
  const trendPhrase =
    slopePerDay === 0
      ? `${label} is flat`
      : `${label} is moving ${perDay > 0 ? '+' : ''}${perDay}${u}/day`;
  const etaPhrase = projectedDate
    ? `At this rate it crosses the target around ${formatDate(projectedDate)}.`
    : `At this rate it doesn't reach the target.`;
  // Only show a projected value when the trend is actually heading toward the
  // target — a straight-line projection of a wrong-way trend is misleading
  // (e.g. "projected 7ms" from declining HRV).
  const headingToward = needUp ? slopePerDay > 0 : slopePerDay < 0;
  const showProjection = projectedValue != null && (headingToward || achieved);
  const detail =
    `Now ${round(current)}${u} → target ${round(target)}${u}. ${trendPhrase}. ${etaPhrase}` +
    (showProjection ? ` Projected ${round(projectedValue)}${u}${byClause}.` : '');

  return {
    ...base,
    title,
    detail,
    confidence: probability,
    evidence: {
      ...base.evidence,
      status,
      current: round(current),
      target: round(target),
      baseline: round(baseline),
      slopePerDay: round(slopePerDay, 4),
      projectedValue: round(projectedValue),
      projectedDate: projectedDate ? projectedDate.toISOString().slice(0, 10) : null,
      targetDate: goal.target_date ? new Date(goal.target_date).toISOString().slice(0, 10) : null,
      daysRemaining,
      probability: round(probability, 3),
      n: recent.length,
    },
  };
}

/**
 * Forecast every metric-bound active goal, pulling each goal's series from a
 * pre-loaded `seriesByKey` (keyed `domain:metric`). Mirrors computeTrends /
 * computeCorrelations so analyze() can run it without extra I/O.
 */
function computeForecasts(goals = [], seriesByKey = {}, opts = {}) {
  const out = [];
  for (const goal of goals) {
    if (!goal.metric || goal.target_value == null) continue;
    const series = seriesByKey[`${goal.domain}:${goal.metric}`] || [];
    const f = forecastGoal(goal, series, opts);
    if (f) out.push(f);
  }
  return out;
}

module.exports = { forecastGoal, computeForecasts, FIT_WINDOW, MIN_POINTS };
