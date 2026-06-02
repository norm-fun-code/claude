// Intelligence layer: turns the metrics spine into findings.
//
//   computeTrends / computeCorrelations  — pure (take series, return findings)
//   analyze()                            — loads from DB, persists findings
//
// Trends: recent-vs-prior change per metric. Correlations: cross-metric Pearson
// over a window, including a 1-day lag (e.g. last night's sleep -> today's focus).
require('dotenv').config();
const stats = require('./stats');
const cat = require('./catalog');
const { rankActions } = require('./leverage');
const { computeForecasts } = require('./forecast');
const { computeHealthComposites } = require('./recovery');

const DEFAULTS = {
  loadDays: 60, // history window pulled from the spine
  trendWindow: 7, // days per side for recent-vs-prior
  trendMinPct: 0.1, // |change| >= 10% to report
  corrWindow: 30, // days considered for correlation
  corrMinN: 20, // min aligned day-pairs (raised: r≥0.5 at n=10 isn't significant)
  corrMinAbsR: 0.5, // |r| >= 0.5 to report
  corrGateAbsR: 0.3, // each half must reach this for a correlation to be "confirmed"
  corrFdrQ: 0.1, // Benjamini–Hochberg false-discovery rate for the all-pairs search
  corrLags: [0, 1], // test same-day and next-day
  maxCorrelations: 12,
  anomalyBaselineDays: 30, // trailing window forming each metric's personal baseline
  anomalyMinN: 8, // need at least this many baseline days
  anomalyMinZ: 1.8, // |z| past this is "unusual for you" (~7% tail)
  maxAnomalies: 6,
  // Flow metrics that post sparsely (only on transaction days). A daily-mean
  // "trend" on these is misleading — e.g. "spending down 75%" really compares
  // recent vs prior *daily averages*, not the weekly totals shown on the Wealth
  // tab. These are covered properly by the dedicated wealth insights instead.
  trendSkip: ['wealth:spending', 'wealth:spending_discretionary', 'wealth:income', 'wealth:net_cashflow'],
};

function pct(n) {
  return `${n >= 0 ? '+' : ''}${Math.round(n * 100)}%`;
}

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function splitKey(key) {
  const i = key.indexOf(':');
  return { domain: key.slice(0, i), metric: key.slice(i + 1) };
}

/** Pure: per-metric recent-vs-prior trend findings. */
function computeTrends(seriesByKey, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const findings = [];

  for (const [key, series] of Object.entries(seriesByKey)) {
    if (o.trendSkip && o.trendSkip.includes(key)) continue;
    const t = stats.trendStats(series, o.trendWindow);
    if (!t || t.pctChange == null || Math.abs(t.pctChange) < o.trendMinPct) continue;

    const { domain, metric } = splitKey(key);
    const label = cat.label(domain, metric);
    const dir = t.pctChange >= 0 ? 'up' : 'down';
    const good = cat.goodWhen(domain, metric);
    let qualifier = '';
    if (good === 'up') qualifier = dir === 'up' ? ' (improving)' : ' (worsening)';
    else if (good === 'down') qualifier = dir === 'down' ? ' (improving)' : ' (worsening)';

    findings.push({
      type: 'trend',
      domains: [domain],
      title: `${label} ${dir} ${pct(t.pctChange)} over ${o.trendWindow}d${qualifier}`,
      detail:
        `${label}: last ${o.trendWindow}d avg ${round(t.recentMean)} vs prior ${round(t.priorMean)} ` +
        `(${pct(t.pctChange)}). Latest ${round(t.latest)}.`,
      confidence: Math.min(1, Math.abs(t.pctChange) / 0.5),
      evidence: {
        auto: true,
        kind: 'trend',
        metric: key,
        recentMean: round(t.recentMean),
        priorMean: round(t.priorMean),
        pctChange: round(t.pctChange, 3),
        slope: t.slope == null ? null : round(t.slope, 3),
        n: t.n,
      },
    });
  }

  return findings;
}

/**
 * Pure: personalized-baseline anomaly findings. Flags when today's value is far
 * from the user's OWN recent norm (|z| past a threshold) — the "unusual for you"
 * signal, graded relative to personal history rather than population cutoffs.
 */
function computeAnomalies(seriesByKey, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const findings = [];

  for (const [key, series] of Object.entries(seriesByKey)) {
    if (o.trendSkip && o.trendSkip.includes(key)) continue; // sparse flow metrics
    const a = stats.baselineAnomaly(series, { baselineDays: o.anomalyBaselineDays, minN: o.anomalyMinN });
    if (!a || Math.abs(a.z) < o.anomalyMinZ) continue;

    const { domain, metric } = splitKey(key);
    const label = cat.label(domain, metric);
    const good = cat.goodWhen(domain, metric);
    const dir = a.z > 0 ? 'above' : 'below';
    // Is this anomaly good or bad given the metric's preferred direction?
    let tone = 'unusual';
    if (good === 'up') tone = a.z > 0 ? 'a strong day' : 'worth attention';
    else if (good === 'down') tone = a.z < 0 ? 'a strong day' : 'worth attention';
    const sigmas = round(Math.abs(a.z), 1);

    findings.push({
      type: 'anomaly',
      domains: [domain],
      title: `${label} ${dir} your usual (${sigmas}σ) — ${tone}`,
      detail:
        `${label} is ${round(a.latest)} today vs your ~${o.anomalyBaselineDays}d baseline of ` +
        `${round(a.baselineMean)} (±${round(a.baselineStd)}). That's ${sigmas} standard deviations ${dir} ` +
        `your personal norm.`,
      confidence: Math.min(1, Math.abs(a.z) / 3),
      evidence: {
        auto: true,
        kind: 'anomaly',
        metric: key,
        latest: round(a.latest),
        baselineMean: round(a.baselineMean),
        baselineStd: round(a.baselineStd),
        z: round(a.z, 2),
        n: a.n,
      },
    });
  }

  // Strongest deviations first.
  findings.sort((x, y) => Math.abs(y.evidence.z) - Math.abs(x.evidence.z));
  return findings.slice(0, o.maxAnomalies);
}

/** Pure: cross-metric correlation findings (best lag per pair). */
function computeCorrelations(seriesByKey, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const keys = Object.keys(seriesByKey);
  const candidates = [];

  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = seriesByKey[keys[i]];
      const b = seriesByKey[keys[j]];

      // Pick the lag with the strongest valid correlation.
      let best = null;
      for (const lag of o.corrLags) {
        const { xs, ys, n } = stats.alignByDay(a, b, lag);
        if (n < o.corrMinN) continue;
        const r = stats.pearson(xs, ys);
        if (r == null) continue;
        if (!best || Math.abs(r) > Math.abs(best.r)) best = { r, n, lag, xs, ys };
      }
      if (!best || Math.abs(best.r) < o.corrMinAbsR) continue;

      // Confirmation gate: split the aligned series in half; the relationship
      // must hold (same sign, |r| >= gate) on BOTH halves to be "confirmed".
      // Guards against spurious one-off correlations (multiple-comparisons trap).
      const mid = Math.floor(best.xs.length / 2);
      const r1 = stats.pearson(best.xs.slice(0, mid), best.ys.slice(0, mid));
      const r2 = stats.pearson(best.xs.slice(mid), best.ys.slice(mid));
      const confirmed =
        r1 != null &&
        r2 != null &&
        Math.sign(r1) === Math.sign(r2) &&
        Math.min(Math.abs(r1), Math.abs(r2)) >= o.corrGateAbsR;

      candidates.push({
        keyA: keys[i],
        keyB: keys[j],
        r: best.r,
        n: best.n,
        lag: best.lag,
        p: stats.pearsonPValue(best.r, best.n),
        confirmed,
      });
    }
  }

  // Multiple-comparisons correction: an all-pairs × lag search runs hundreds of
  // tests, so ~5% would clear |r|≥0.5 by chance. Keep only pairs whose p-value
  // survives Benjamini–Hochberg FDR control across the whole candidate set.
  const keep = stats.benjaminiHochberg(candidates.map((c) => c.p), o.corrFdrQ);
  const significant = candidates.filter((_, i) => keep[i]);

  significant.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

  return significant.slice(0, o.maxCorrelations).map((c) => {
    const a = splitKey(c.keyA);
    const b = splitKey(c.keyB);
    const labelA = cat.label(a.domain, a.metric);
    const labelB = cat.label(b.domain, b.metric);
    const strength = Math.abs(c.r) >= 0.7 ? 'strong' : 'moderate';
    const sign = c.r >= 0 ? 'positive' : 'negative';
    const lagNote = c.lag === 0 ? 'same-day' : `${labelB} ${c.lag}d later`;
    const domains = [...new Set([a.domain, b.domain])];
    const status = c.confirmed ? ' [confirmed]' : ' [candidate — needs an experiment]';

    return {
      type: 'correlation',
      domains,
      title: `${labelA} ↔ ${labelB}: ${strength} ${sign} correlation${status}`,
      detail: `${labelA} and ${labelB} move ${sign === 'positive' ? 'together' : 'inversely'} (r=${round(c.r)}, n=${c.n}, p=${c.p == null ? 'n/a' : round(c.p, 3)}, ${lagNote}). ${c.confirmed ? 'Held on both halves of the window.' : 'Not yet confirmed on a holdout.'} Association, not proof of cause.`,
      // Confidence blends effect size with statistical significance, so a strong
      // r on thin data isn't over-trusted.
      confidence: round(Math.abs(c.r) * (c.confirmed ? 1 : 0.6) * (c.p != null && c.p < 0.05 ? 1 : 0.7), 3),
      evidence: {
        auto: true,
        kind: 'correlation',
        a: c.keyA,
        b: c.keyB,
        r: round(c.r, 3),
        n: c.n,
        p: c.p == null ? null : round(c.p, 4),
        lag: c.lag,
        confirmed: c.confirmed,
        crossDomain: domains.length > 1,
      },
    };
  });
}

/** Orchestrator: load series, compute findings, persist them. */
async function analyze(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const metricsStore = require('../store/metrics');
  const findingsStore = require('../store/findings');

  const from = new Date(Date.now() - o.loadDays * 24 * 60 * 60 * 1000);
  const keys = await metricsStore.listMetricKeys();

  const seriesByKey = {};
  for (const { domain, metric } of keys) {
    const rows = await metricsStore.dailyAggregate({
      domain,
      metric,
      from,
      agg: cat.aggFor(metric),
    });
    if (rows.length) seriesByKey[`${domain}:${metric}`] = rows;
  }

  const trends = computeTrends(seriesByKey, o);
  const correlations = computeCorrelations(seriesByKey, o);
  const anomalies = computeAnomalies(seriesByKey, o);
  const composites = computeHealthComposites(seriesByKey, o);

  // Rank the highest-leverage actions from the findings + any off-track goals.
  const latestByKey = {};
  for (const [key, series] of Object.entries(seriesByKey)) {
    if (series.length) latestByKey[key] = Number(series[series.length - 1].value);
  }
  let goals = [];
  try {
    const r = await require('../db').query(`SELECT * FROM goals WHERE status = 'active'`);
    goals = r.rows;
  } catch {
    // goals table optional / empty
  }
  const actions = rankActions([...trends, ...correlations], { goals, latestByKey });

  // Goal achievement-probability forecasts from the same loaded series.
  const forecasts = computeForecasts(goals, seriesByKey);

  const all = [...trends, ...correlations, ...anomalies, ...composites, ...actions, ...forecasts];
  const windowStart = from;
  const windowEnd = new Date();

  // Supersede old findings and write the new set atomically, so a mid-run
  // failure can't leave the user with everything superseded and only a partial
  // set re-created (which the dashboard reads as 'open').
  const COMPOSITE_TYPES = ['recovery', 'sleep_debt', 'sleep_consistency', 'training_load'];
  const { withTransaction } = require('../db');
  await withTransaction(async (client) => {
    const tx = (text, params) => client.query(text, params);
    await findingsStore.supersedeAuto(['trend', 'correlation', 'anomaly', 'leverage', 'forecast', ...COMPOSITE_TYPES], tx);
    for (const f of all) {
      await findingsStore.createFinding({ ...f, windowStart, windowEnd }, tx);
    }
  });

  return {
    metrics: Object.keys(seriesByKey).length,
    trends: trends.length,
    correlations: correlations.length,
    anomalies: anomalies.length,
    composites: composites.length,
    actions: actions.length,
    forecasts: forecasts.length,
  };
}

module.exports = { analyze, computeTrends, computeCorrelations, computeAnomalies, DEFAULTS };

// CLI entrypoint
if (require.main === module) {
  const { pool } = require('../db');
  analyze()
    .then((s) =>
      console.log(
        `Analyzed ${s.metrics} metrics → ${s.trends} trends, ${s.correlations} correlations, ${s.actions} leverage actions, ${s.forecasts} forecasts.`
      )
    )
    .catch((err) => {
      console.error('Analyze failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
