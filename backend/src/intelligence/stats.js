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
  const slope = num / den;
  const intercept = my - slope * mx;
  // Residual standard deviation (n-2 dof for a fitted line).
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * xs[i];
    ss += (values[i] - pred) ** 2;
  }
  const residualStd = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return { slope, intercept, residualStd, n };
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
function trendStats(series, window = 7) {
  const values = series.map((p) => Number(p.value)).filter(Number.isFinite);
  if (values.length < 4) return null;

  const recent = values.slice(-window);
  const prior = values.slice(-2 * window, -window);
  const recentMean = mean(recent);
  const priorMean = prior.length ? mean(prior) : null;

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
  linregSlope,
  linearFit,
  normalCdf,
  alignByDay,
  trendStats,
  dayKey,
};
