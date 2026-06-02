// Pure statistics for the intelligence layer. No I/O — everything here takes
// arrays/series and returns numbers, so it's fully unit-testable.

function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Pearson correlation coefficient. Returns null if undefined (n<3 or zero variance). */
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return null;
  return num / Math.sqrt(dx2 * dy2);
}

/** Slope of a simple linear fit of values against their index (per step). */
function linregSlope(values) {
  const n = values.length;
  if (n < 2) return null;
  const xs = values.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (values[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

/**
 * Least-squares fit of values against their index (per step). Returns
 * { slope, intercept, residualStd, n } or null if underdetermined. `residualStd`
 * is the spread of points around the fitted line — the raw material for a
 * forecast's uncertainty.
 */
function linearFit(values) {
  if (!values || values.length < 2) return null;
  // Fit against the index 0..n-1 (per-step). Delegates to linearFitXY so the
  // result carries sxx/mx for prediction intervals, same as fitByDay.
  return linearFitXY(values.map((_, i) => i), values);
}

/**
 * Least-squares fit of ys against arbitrary xs (e.g. day offsets). Returns
 * { slope, intercept, residualStd, n, sxx, mx } so callers can build a proper
 * prediction interval. slope is in "y per unit x".
 */
function linearFitXY(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (sxx === 0) return null;
  const slope = num / sxx;
  const intercept = my - slope * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * xs[i];
    ss += (ys[i] - pred) ** 2;
  }
  const residualStd = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return { slope, intercept, residualStd, n, sxx, mx };
}

/**
 * Fit a daily series [{ day, value }] against REAL day offsets from the first
 * point, so slope is per-CALENDAR-DAY (not per-present-sample). This is the
 * correct basis for trends/forecasts on metrics that aren't logged every day.
 * Returns the linearFitXY result plus { spanDays, lastX }.
 */
function fitByDay(series) {
  const pts = (series || [])
    .map((p) => ({ t: new Date(p.day).getTime(), v: Number(p.value) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const t0 = pts[0].t;
  const xs = pts.map((p) => (p.t - t0) / 864e5); // day offsets
  const ys = pts.map((p) => p.v);
  const fit = linearFitXY(xs, ys);
  if (!fit) return null;
  return { ...fit, spanDays: xs[xs.length - 1], lastX: xs[xs.length - 1] };
}

/**
 * 1-sigma prediction interval half-width for an OLS extrapolation to x0, the
 * statistically correct horizon uncertainty:
 *   se = residualStd · √(1 + 1/n + (x0 − mx)² / sxx)
 * (Replaces the dimensionally-wrong residualStd·√horizon random-walk guess.)
 */
function predictionSE(fit, x0) {
  if (!fit || fit.residualStd == null || fit.sxx === 0) return null;
  const { residualStd, n, sxx, mx } = fit;
  return residualStd * Math.sqrt(1 + 1 / n + ((x0 - mx) ** 2) / sxx);
}

/**
 * Standard normal CDF Φ(z) via the Abramowitz & Stegun 7.1.26 approximation
 * (max abs error ~7.5e-8). Returns P(Z ≤ z) for Z ~ N(0,1).
 */
function normalCdf(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/**
 * Two-sided p-value for a Pearson correlation r over n pairs, via the
 * t-statistic t = r·√((n−2)/(1−r²)) under H0: ρ=0. For the modest n we deal with
 * we approximate the t-distribution's tail with the normal CDF (slightly
 * anticonservative for very small n, but it's only a gate, and we also require a
 * minimum n upstream). Returns a p-value in [0,1], or null if undefined.
 */
function pearsonPValue(r, n) {
  if (r == null || !Number.isFinite(r) || n == null || n < 3) return null;
  if (Math.abs(r) >= 1) return 0;
  const t = Math.abs(r) * Math.sqrt((n - 2) / (1 - r * r));
  // Two-sided tail. normalCdf(t) is P(Z≤t); upper tail is 1−that, ×2 for two-sided.
  return Math.min(1, 2 * (1 - normalCdf(t)));
}

/**
 * Benjamini–Hochberg FDR: given an array of p-values, return a boolean array
 * marking which are significant at false-discovery-rate q. Controls the
 * expected proportion of false positives across many simultaneous tests — the
 * right correction for an all-pairs correlation search.
 */
function benjaminiHochberg(pvalues, q = 0.1) {
  const m = pvalues.length;
  const idx = pvalues
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p != null && Number.isFinite(x.p))
    .sort((a, b) => a.p - b.p);
  const keep = new Array(m).fill(false);
  let maxK = -1;
  for (let k = 0; k < idx.length; k++) {
    if (idx[k].p <= ((k + 1) / idx.length) * q) maxK = k;
  }
  for (let k = 0; k <= maxK; k++) keep[idx[k].i] = true;
  return keep;
}

/**
 * Personalized baseline anomaly check. Compares the latest value against the
 * user's own recent history (a rolling baseline) and returns how many standard
 * deviations it sits from their personal mean — the "unusual for *you*" signal
 * that powers Oura/Whoop-style readiness, rather than population thresholds.
 *
 * series: [{ day, value }] ascending. baselineDays: how many trailing days form
 * the baseline (the latest point is excluded from its own baseline). Returns
 * { latest, baselineMean, baselineStd, z, n } or null if too little history.
 */
function baselineAnomaly(series, { baselineDays = 30, minN = 8 } = {}) {
  const values = series.map((p) => Number(p.value)).filter(Number.isFinite);
  if (values.length < minN + 1) return null;
  const latest = values[values.length - 1];
  const baseline = values.slice(-(baselineDays + 1), -1); // exclude latest
  if (baseline.length < minN) return null;
  const baselineMean = mean(baseline);
  const baselineStd = std(baseline);
  if (baselineMean == null || baselineStd == null || baselineStd === 0) return null;
  const z = (latest - baselineMean) / baselineStd;
  return { latest, baselineMean, baselineStd, z, n: baseline.length };
}

function dayKey(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Align two daily series on the same day. Each series is [{ day, value }].
 * `lag` shifts series B forward by N days relative to A (B's day - lag matches
 * A's day), to test "A today vs B `lag` days later".
 * Returns { xs, ys, n }.
 */
function alignByDay(seriesA, seriesB, lag = 0) {
  const mapB = new Map();
  for (const p of seriesB) mapB.set(dayKey(p.day), Number(p.value));

  const xs = [];
  const ys = [];
  for (const p of seriesA) {
    const aKey = dayKey(p.day);
    const bDate = new Date(aKey);
    bDate.setUTCDate(bDate.getUTCDate() + lag);
    const bKey = dayKey(bDate);
    if (mapB.has(bKey)) {
      const ax = Number(p.value);
      const by = mapB.get(bKey);
      if (Number.isFinite(ax) && Number.isFinite(by)) {
        xs.push(ax);
        ys.push(by);
      }
    }
  }
  return { xs, ys, n: xs.length };
}

/**
 * Recent-vs-prior trend over a daily series [{ day, value }].
 * Compares the mean of the last `window` days to the `window` days before it.
 */
function trendStats(series, window = 7, { minPriorN = 3 } = {}) {
  const values = series.map((p) => Number(p.value)).filter(Number.isFinite);
  if (values.length < 4) return null;

  const recent = values.slice(-window);
  const prior = values.slice(-2 * window, -window);
  const recentMean = mean(recent);
  // Require a real prior window before reporting a % change. Otherwise an 8-day
  // series gives a 1-day "prior", so a single low first day reads as a fake,
  // maximally-confident "+100% improving" trend in the user's second week.
  const priorMean = prior.length >= minPriorN ? mean(prior) : null;

  let pctChange = null;
  if (priorMean != null && priorMean !== 0) {
    pctChange = (recentMean - priorMean) / Math.abs(priorMean);
  }

  return {
    n: values.length,
    latest: values[values.length - 1],
    recentMean,
    priorMean,
    pctChange,
    slope: linregSlope(recent),
  };
}

module.exports = {
  mean,
  std,
  pearson,
  pearsonPValue,
  benjaminiHochberg,
  baselineAnomaly,
  linregSlope,
  linearFit,
  linearFitXY,
  fitByDay,
  predictionSE,
  normalCdf,
  alignByDay,
  trendStats,
  dayKey,
};
