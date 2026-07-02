// "You vs. past you" — the longitudinal zoom-out the daily brief can't see.
//
// Daily numbers hide the long arc: recovery being yellow today says nothing
// about resting HR sitting 3bpm lower than it did in the spring, or meditation
// going from half the days to nearly all of them. Once a week (the Monday
// brief), compare the trailing 4 weeks against the same measures ~3 months ago
// and surface only shifts big enough to be real — improvements AND regressions,
// honestly labeled. Sparse by design: below-threshold drift stays silent so
// this never decays into a weekly progress ritual of noise.
const metricsStore = require('../store/metrics');
const stats = require('./stats');

const WINDOW_DAYS = 28; // each comparison window
const GAP_DAYS = 84;    // baseline window ends ~12 weeks back

// Same bar the rest of the intelligence pipeline holds every "is this real"
// claim to (see analyze.js) — a raw mean gap between two 10-ish-day samples is
// mostly sampling noise on its own; require a genuine two-sample test, then
// correct across the 8 metrics tested so the strongest of many isn't a
// forking-paths artifact.
const SPLIT_ALPHA = 0.05;
const SPLIT_FDR_Q = 0.1;

// HRV/resting HR/sleep can be reported by both Eight Sleep and Apple Watch
// (via HealthKit sync) — source-lock to the night-anchored readings so a
// night isn't double-counted and so seed/demo data (which falls outside this
// allowlist) never leaks into a 3-month-old baseline window.
const NIGHT_SOURCES = ['eight_sleep', 'eight_sleep_baseline'];

// Per-metric gates: minRel (relative change) for physiological measures where
// % is meaningful; minAbs for coarse /5 scales and adherence rates where a
// percentage of a small base misleads. minN = days of data required in EACH
// window (default 10) so one good week can't masquerade as a trend.
const METRICS = [
  { key: 'health:hrv',         label: 'HRV',                unit: 'ms',    good: 'up',   minRel: 0.05, decimals: 0, sources: NIGHT_SOURCES },
  { key: 'health:resting_hr',  label: 'resting HR',         unit: 'bpm',   good: 'down', minRel: 0.03, decimals: 0, sources: NIGHT_SOURCES },
  { key: 'health:sleep_hours', label: 'sleep',              unit: 'h',     good: 'up',   minRel: 0.04, decimals: 1, sources: NIGHT_SOURCES },
  // VO2 max only ever comes from Apple Health (no Eight Sleep/dupe risk), so
  // it uses the plain seed-excluding path like mood/energy/habits below.
  { key: 'health:vo2_max',     label: 'VO₂ max',            unit: '',      good: 'up',   minAbs: 0.5,  decimals: 1, minN: 2 },
  { key: 'wellbeing:mood',     label: 'mood',               unit: '/5',    good: 'up',   minAbs: 0.3,  decimals: 1 },
  { key: 'wellbeing:energy',   label: 'energy',             unit: '/5',    good: 'up',   minAbs: 0.3,  decimals: 1 },
  { key: 'habits:morning_tm',  label: 'morning meditation', unit: '%days', good: 'up',   minAbs: 0.15, decimals: 0 },
  { key: 'habits:exercise',    label: 'exercise',           unit: '%days', good: 'up',   minAbs: 0.15, decimals: 0 },
];

const MAX_LINES = 3;
const DEFAULT_MIN_N = 10;

function fmtVal(v, unit, decimals) {
  if (unit === '%days') return `${Math.round(v * 100)}% of days`;
  // Match analyze.js's fmt() for /5 — no trailing zero (4 -> "4", not "4.0") so
  // a mood value doesn't render differently here than in habit-split findings.
  if (unit === '/5') return `${Math.round(v * 10) / 10}/5`;
  const n = decimals > 0 ? (Math.round(v * 10 ** decimals) / 10 ** decimals).toFixed(decimals) : String(Math.round(v));
  return unit ? `${n}${unit}` : n;
}

/**
 * Pure. rows: [{ label, unit, good, decimals, minRel?, minAbs?, minN?,
 *   recent: {avg, n, vals}, baseline: {avg, n, vals} }].
 * Returns a single-line context string ("HRV 52ms vs 47ms (+11%) · …"), or
 * null when nothing crosses its meaningful-change threshold AND passes a
 * genuine two-sample significance test (see SPLIT_ALPHA/SPLIT_FDR_Q above —
 * the same bar analyze.js holds its own "is this real" findings to).
 */
function composeProgressNote(rows = []) {
  const candidates = [];
  for (const r of rows) {
    const { recent, baseline } = r;
    if (!recent || !baseline) continue;
    const minN = r.minN ?? DEFAULT_MIN_N;
    if (!(recent.n >= minN) || !(baseline.n >= minN)) continue;
    if (!Number.isFinite(recent.avg) || !Number.isFinite(baseline.avg)) continue;

    const delta = recent.avg - baseline.avg;
    const rel = baseline.avg !== 0 ? delta / Math.abs(baseline.avg) : null;
    const passes =
      (r.minAbs != null && Math.abs(delta) >= r.minAbs) ||
      (r.minRel != null && rel != null && Math.abs(rel) >= r.minRel);
    if (!passes) continue;

    // Significance gate: a raw mean gap between two ~10-day samples is mostly
    // sampling noise on its own. Require a real two-sample test before this
    // becomes a "you vs past you" claim, same as every other finding type.
    const w = r.p != null ? { p: r.p } : stats.welchTTest(baseline.vals, recent.vals);
    if (!w || w.p == null || w.p > SPLIT_ALPHA) continue;

    const improved = r.good === 'down' ? delta < 0 : delta > 0;
    // Change annotation: % for physiological units, absolute for /5 and rates.
    const change =
      r.unit === '%days' ? `${delta >= 0 ? '+' : '−'}${Math.round(Math.abs(delta) * 100)} pts`
      : r.unit === '/5' || r.unit === '' ? `${delta >= 0 ? '+' : '−'}${fmtVal(Math.abs(delta), '', r.decimals)}`
      : `${rel >= 0 ? '+' : '−'}${Math.round(Math.abs(rel) * 100)}%`;

    candidates.push({
      p: w.p,
      // Sort key: relative shift when meaningful, else scaled absolute.
      weight: rel != null ? Math.abs(rel) : Math.abs(delta) / 5,
      improved,
      text:
        `${r.label} ${fmtVal(recent.avg, r.unit, r.decimals)} now vs ${fmtVal(baseline.avg, r.unit, r.decimals)} then (${change})` +
        (improved ? '' : ' — moving the wrong way'),
    });
  }
  if (!candidates.length) return null;

  // Multiple-comparisons control: 8 metrics were tested and we're about to
  // surface the strongest — BH-correct across all candidates first.
  const sigKeep = stats.benjaminiHochberg(candidates.map((c) => c.p), SPLIT_FDR_Q);
  const qualified = candidates.filter((_, i) => sigKeep[i]);
  if (!qualified.length) return null;

  qualified.sort((a, b) => b.weight - a.weight);
  return qualified.slice(0, MAX_LINES).map((q) => q.text).join(' · ');
}

async function windowStats(m, from, to) {
  const [domain, metric] = m.key.split(':');
  const rows = m.sources
    ? await metricsStore.dailyAggregatePreferSource({ domain, metric, from, to, agg: 'avg', sources: m.sources })
    : await metricsStore.dailyAggregate({ domain, metric, from, to, agg: 'avg', excludeSource: 'seed' });
  const vals = rows.map((r) => Number(r.value)).filter(Number.isFinite);
  if (!vals.length) return { avg: null, n: 0, vals: [] };
  return { avg: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length, vals };
}

/**
 * Load both windows for every tracked measure and compose the note.
 * Returns the context string or '' — never throws (the brief must not fail
 * because the zoom-out couldn't be computed).
 */
async function computeProgressContext({ asOf = new Date() } = {}) {
  try {
    const day = 86400000;
    const recentFrom = new Date(asOf.getTime() - WINDOW_DAYS * day);
    const baseTo = new Date(asOf.getTime() - GAP_DAYS * day);
    const baseFrom = new Date(baseTo.getTime() - WINDOW_DAYS * day);

    const rows = await Promise.all(
      METRICS.map(async (m) => {
        const [recent, baseline] = await Promise.all([
          windowStats(m, recentFrom, asOf),
          windowStats(m, baseFrom, baseTo),
        ]);
        return { ...m, recent, baseline };
      })
    );
    return composeProgressNote(rows) || '';
  } catch (err) {
    console.error('[progress] failed:', err.message);
    return '';
  }
}

module.exports = { composeProgressNote, computeProgressContext, METRICS, WINDOW_DAYS, GAP_DAYS };
