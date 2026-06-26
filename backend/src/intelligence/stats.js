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
 * Lanczos approximation of ln Γ(z) — the building block for the regularized
 * incomplete beta function (and thus the exact Student-t tail).
 */
function logGamma(z) {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Continued-fraction expansion for the incomplete beta (Numerical Recipes). */
function betacf(a, b, x) {
  const FPMIN = 1e-30, EPS = 3e-12, MAXIT = 200;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b) — exact (to ~1e-12) for any a,b>0. */
function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lbt);
  return x < (a + 1) / (a + b + 2)
    ? (bt * betacf(a, b, x)) / a
    : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/**
 * Two-sided p-value P(|T| > |t|) for a Student-t statistic with `df` degrees of
 * freedom — the EXACT tail (via the regularized incomplete beta), not the normal
 * approximation. This matters at the small n the split/experiment engines run on:
 * the normal approx is materially anticonservative (e.g. at df=8 it underestimates
 * a tail by ~2×), which is exactly how noise gets mislabeled "significant".
 */
function studentTTwoSided(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return null;
  if (t === 0) return 1;
  return incompleteBeta(df / 2, 0.5, df / (df + t * t));
}

/** 0.975-quantile |t| for `df` (two-sided alpha) via bisection on the exact tail. */
function tCritical(df, twoSidedAlpha = 0.05) {
  if (!Number.isFinite(df) || df <= 0) return null;
  let lo = 0, hi = 1000;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (studentTTwoSided(mid, df) > twoSidedAlpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Two-sided p-value for a Pearson correlation r over n pairs, via the
 * t-statistic t = r·√((n−2)/(1−r²)) under H0: ρ=0, using the EXACT Student-t
 * tail with n−2 degrees of freedom. Returns a p-value in [0,1], or null if
 * undefined (n<3 or |r|≥1 handled at the bounds).
 */
function pearsonPValue(r, n) {
  if (r == null || !Number.isFinite(r) || n == null || n < 3) return null;
  if (Math.abs(r) >= 1) return 0;
  const t = Math.abs(r) * Math.sqrt((n - 2) / (1 - r * r));
  return studentTTwoSided(t, n - 2);
}

/**
 * Welch's unequal-variance two-sample t-test — the correct comparison for the
 * group-split engines (habit-on vs habit-off days, best vs worst nights, etc.),
 * where the two groups are small, differently sized, and have different spread.
 * Convention: `diff = mean(b) − mean(a)`, so feed (lowGroup, highGroup) to get a
 * difference that carries the "high minus low" sign. Returns
 * { meanA, meanB, diff, t, df, p, cohenD, ciLow, ciHigh, nA, nB } or null when
 * either group has <2 finite values. cohenD uses the pooled SD; the 95% CI is on
 * the mean difference using the exact t critical value at the Welch df.
 */
function welchTTest(a, b) {
  const xa = (a || []).filter(Number.isFinite);
  const xb = (b || []).filter(Number.isFinite);
  const nA = xa.length, nB = xb.length;
  if (nA < 2 || nB < 2) return null;
  const mA = mean(xa), mB = mean(xb);
  const vA = xa.reduce((s, v) => s + (v - mA) ** 2, 0) / (nA - 1);
  const vB = xb.reduce((s, v) => s + (v - mB) ** 2, 0) / (nB - 1);
  const diff = mB - mA;
  const pooledSd = Math.sqrt(((nA - 1) * vA + (nB - 1) * vB) / (nA + nB - 2));
  const cohenD = pooledSd > 0 ? diff / pooledSd : 0;
  const seA = vA / nA, seB = vB / nB;
  const se = Math.sqrt(seA + seB);
  if (se === 0) {
    // Both groups perfectly flat. If their means differ at all the separation is
    // total (p→0); if identical there is no effect (p=1).
    const same = diff === 0;
    return { meanA: mA, meanB: mB, diff, t: same ? 0 : Infinity, df: nA + nB - 2,
      p: same ? 1 : 0, cohenD, ciLow: diff, ciHigh: diff, nA, nB };
  }
  const t = diff / se;
  const df = (seA + seB) ** 2 / (seA ** 2 / (nA - 1) + seB ** 2 / (nB - 1));
  const p = studentTTwoSided(t, df);
  const tc = tCritical(df) ?? 1.96;
  return { meanA: mA, meanB: mB, diff, t, df, p, cohenD, ciLow: diff - tc * se, ciHigh: diff + tc * se, nA, nB };
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
  // Guard against a near-flat baseline (e.g. a seeded synthetic baseline that
  // hasn't been diluted by real daily entries yet). With tiny spread, a single
  // genuine reading produces an enormous z and a confident FALSE anomaly every
  // day. Require a minimum coefficient of variation (~3%) — real health metrics
  // (HRV, RHR, sleep) always have far more day-to-day spread than this, so this
  // only suppresses the synthetic-flat case.
  const MIN_CV = 0.03;
  if (baselineMean !== 0 && baselineStd / Math.abs(baselineMean) < MIN_CV) return null;
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
  studentTTwoSided,
  tCritical,
  incompleteBeta,
  welchTTest,
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
