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

const DEFAULTS = {
  loadDays: 60, // history window pulled from the spine
  trendWindow: 7, // days per side for recent-vs-prior
  trendMinPct: 0.1, // |change| >= 10% to report
  corrWindow: 30, // days considered for correlation
  corrMinN: 10, // min aligned day-pairs
  corrMinAbsR: 0.5, // |r| >= 0.5 to report
  corrGateAbsR: 0.3, // each half must reach this for a correlation to be "confirmed"
  corrLags: [0, 1], // test same-day and next-day
  maxCorrelations: 12,
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
        confirmed,
      });
    }
  }

  candidates.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

  return candidates.slice(0, o.maxCorrelations).map((c) => {
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
      detail: `${labelA} and ${labelB} move ${sign === 'positive' ? 'together' : 'inversely'} (r=${round(c.r)}, n=${c.n}, ${lagNote}). ${c.confirmed ? 'Held on both halves of the window.' : 'Not yet confirmed on a holdout.'} Association, not proof of cause.`,
      confidence: Math.abs(c.r) * (c.confirmed ? 1 : 0.6),
      evidence: {
        auto: true,
        kind: 'correlation',
        a: c.keyA,
        b: c.keyB,
        r: round(c.r, 3),
        n: c.n,
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

  const all = [...trends, ...correlations, ...actions];
  const windowStart = from;
  const windowEnd = new Date();

  await findingsStore.supersedeAuto(['trend', 'correlation', 'leverage']);
  for (const f of all) {
    await findingsStore.createFinding({ ...f, windowStart, windowEnd });
  }

  return {
    metrics: Object.keys(seriesByKey).length,
    trends: trends.length,
    correlations: correlations.length,
    actions: actions.length,
  };
}

module.exports = { analyze, computeTrends, computeCorrelations, DEFAULTS };

// CLI entrypoint
if (require.main === module) {
  const { pool } = require('../db');
  analyze()
    .then((s) =>
      console.log(
        `Analyzed ${s.metrics} metrics → ${s.trends} trends, ${s.correlations} correlations, ${s.actions} leverage actions.`
      )
    )
    .catch((err) => {
      console.error('Analyze failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
