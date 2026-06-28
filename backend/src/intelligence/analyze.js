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
  trendMinPct: 0.2, // |change| >= 20% to report
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
  //
  // Readwise/Notion sync metrics: the initial full-library sync writes a huge
  // cumulative count (e.g. 17k highlights, 165 books) as a single data point,
  // making every subsequent incremental sync look like a -99% drop. Trend and
  // anomaly analysis on these is meaningless until several months of incremental
  // data dilute the initial spike.
  trendSkip: [
    'wealth:spending', 'wealth:spending_discretionary', 'wealth:income', 'wealth:net_cashflow',
    'learning:highlights_synced', 'learning:books_synced', 'learning:notion_pages', 'learning:notion_pages_synced',
    // Binary habits (0/1 daily) and the habit-completion ratio: a 7-day-avg
    // "trend" on these is noise — "Cold shower up +133%" just means it went from
    // 3/7 to 7/7 days. Adherence is surfaced properly by computeHabitConsistency
    // ("Cold shower 11/13 days"); the on/off→health effect by computeHabitHealthSplits.
    // (exercise_time_of_day is continuous, NOT binary, so it's deliberately kept.)
    'habits:morning_tm', 'habits:afternoon_tm', 'habits:gratitude', 'habits:cold_shower',
    'habits:exercise', 'habits:eat_healthy', 'habits:habit_score',
    // Environment metrics are outside the user's control — trending humidity or
    // temperature produces noise, not insight.
    'environment:temperature', 'environment:humidity', 'environment:uv_index', 'environment:aqi',
    // Calendar event counts are an input signal (meeting load) used in correlations,
    // but a raw "calendar events down 71%" trend finding has no actionable meaning.
    'productivity:calendar_events',
    // Wake time is tracked for correlation with daytime RHR; a "wake time up 15%"
    // trend finding is confusing (it means waking later on average), not actionable.
    'health:wake_time',
    // Eight Sleep DERIVED intermediates (sleep need/debt) feed only the recovery /
    // sleep-balance composites. A raw "Sleep Debt down 52%" trend on a tiny derived
    // value is noise — and they aren't user-controllable inputs. Excluded from the
    // trend AND anomaly engines (both gate on trendSkip).
    'health:sleep_debt', 'health:sleep_need',
  ],
  // Per-key correlation exclusions. Derived intermediates (sleep need/debt) aren't
  // independent inputs; VO₂ max is an Apple Watch FITNESS ESTIMATE that barely
  // moves day to day, so a daily "correlation" against it (e.g. the spurious
  // "higher VO₂ max today → lower sleep need tomorrow") is two near-flat noise
  // series lining up by chance, not physiology. Respiratory rate is a valuable
  // illness / over-reaching EARLY-WARNING signal — but only read as an ANOMALY vs
  // your own baseline (a spike precedes illness by a day or two). A daily Pearson
  // tie like "higher respiratory rate → higher mood" is noise (and physiologically
  // backwards — elevated breathing rate tracks stress, not better mood), so it
  // stays in the anomaly engine and out of the correlation engine. None of these
  // belong in the all-pairs Pearson search.
  corrSkip: ['health:sleep_debt', 'health:sleep_need', 'health:vo2_max', 'health:respiratory_rate'],
  // All wealth metrics are excluded from correlation search. Wealth variables
  // (spending, net worth, cashflow, income) correlate with health and habit
  // metrics purely as lifestyle confounds — high-activity people tend to earn
  // more, poor sleep may co-occur with late nights that drive spending, etc.
  // None of these are actionable causal levers within a 14-day window.
  // Wealth is tracked and trended separately; it has no place in the
  // health/habit/wellbeing correlation engine.
  corrSkipDomains: ['wealth'],
  // Pairs to never surface as correlation findings — either definitionally linked
  // (component→total), computed from each other, or structurally always correlated
  // by physiology (not a discovery). Normalized as sorted(a,b).join('|').
  corrSkipPairs: new Set([
    // Sleep stages are components of total sleep — trivially correlated
    'health:deep_sleep_hours|health:sleep_hours',
    'health:rem_sleep_hours|health:sleep_hours',
    // Sleep score is derived partly from sleep duration — not an independent finding
    'health:deep_sleep_hours|health:sleep_score',
    'health:rem_sleep_hours|health:sleep_score',
    'health:sleep_hours|health:sleep_score',
    // HRV and RHR are both autonomic markers and always anti-correlated by design —
    // surfacing this as a "pattern" implies it's a personal discovery, but it isn't.
    'health:hrv|health:resting_hr',
    // Sleep debt is mathematically derived from sleep duration — not independent
    'health:sleep_debt|health:sleep_hours',
    // Steps and active energy both measure movement from the same underlying data
    'health:active_energy|health:steps',
    // Energy is an OUTPUT of HRV recovery, not a lever for improving HRV. Surfacing
    // this as "high-energy days run better HRV" inverts the causal direction and
    // generates misleading briefing recommendations.
    'health:hrv|wellbeing:energy',
    'health:resting_hr|wellbeing:energy',
  ]),
};

// Significance gates shared by every group-split engine (habit / sleep / activity
// / daytime cardio). A finding must clear BOTH a per-test significance bar AND a
// minimum practical effect size — statistical significance alone surfaces trivial
// effects on large n; a raw effect alone surfaces noise on small n. The FDR step
// then controls false positives across the many comparisons each engine runs.
const SPLIT_ALPHA = 0.05;  // per-test two-sided Welch p-value bar
const SPLIT_FDR_Q = 0.1;   // Benjamini–Hochberg false-discovery rate across candidates

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

function toDayKey(d) {
  return (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
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

  // Eight Sleep HRV/RHR are wake-dated, so a reading for last night carries
  // today's date. If the latest is older than today, there was no Pod session last
  // night — don't raise a "HRV below your usual" anomaly on a 1–2-night-old reading
  // (mirrors the recovery-card staleness guard; otherwise a stale value keeps
  // flagging, mislabeled "yesterday", with stale life-context attached).
  const NIGHT_LOCKED = new Set(['health:hrv', 'health:resting_hr']);
  const todayKey = o.today || new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' });

  for (const [key, series] of Object.entries(seriesByKey)) {
    if (o.trendSkip && o.trendSkip.includes(key)) continue; // sparse flow metrics
    if (NIGHT_LOCKED.has(key) && series.length) {
      const readingDayKey = toDayKey(series[series.length - 1].day);
      if (readingDayKey < todayKey) continue; // stale Pod reading — no anomaly
    }
    const a = stats.baselineAnomaly(series, { baselineDays: o.anomalyBaselineDays, minN: o.anomalyMinN });
    if (!a || Math.abs(a.z) < o.anomalyMinZ) continue;

    const { domain, metric } = splitKey(key);

    // Wellbeing metrics (mood/energy/focus) are manually logged on a 1–5 scale.
    // A value of 0 means the user didn't check in today — not a genuine reading.
    // Firing "Focus well below usual" for an unlogged day is misleading.
    if (domain === 'wellbeing' && a.latest <= 0) continue;

    const label = cat.label(domain, metric);
    const good = cat.goodWhen(domain, metric);
    const dir = a.z > 0 ? 'above' : 'below';
    // Is this anomaly good or bad given the metric's preferred direction?
    let tone = 'unusual';
    if (good === 'up') tone = a.z > 0 ? 'a strong day' : 'worth attention';
    else if (good === 'down') tone = a.z < 0 ? 'a strong day' : 'worth attention';
    const absZ = Math.abs(a.z);
    const magnitude = absZ >= 4 ? 'far' : absZ >= 2.5 ? 'well' : 'noticeably';
    const pctDiff = a.baselineMean !== 0
      ? Math.round(Math.abs((a.latest - a.baselineMean) / a.baselineMean) * 100)
      : null;
    const pctNote = pctDiff != null ? ` (${pctDiff}% ${dir})` : '';

    // Use "yesterday" when the latest data point is from a prior calendar day
    // (common in morning briefings where wellbeing metrics are from yesterday's
    // check-in). NB: series[i].day is a Date object (Postgres DATE) — comparing it
    // directly against a string yields NaN and silently always picked "today".
    // Normalize BOTH sides to YYYY-MM-DD strings in the local zone so the check
    // actually fires.
    const latestDay = series[series.length - 1]?.day;
    const latestDayKey = latestDay ? toDayKey(latestDay) : null;
    const tz = process.env.TZ || 'America/New_York';
    const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const dayLabel = latestDayKey && latestDayKey < todayLocal ? 'yesterday' : 'today';

    findings.push({
      type: 'anomaly',
      domains: [domain],
      title: `${label} ${magnitude} ${dir} your usual${pctNote} — ${tone}`,
      detail:
        `${label} is ${round(a.latest)} ${dayLabel} vs your ~${o.anomalyBaselineDays}d personal baseline of ` +
        `${round(a.baselineMean)}. That's ${magnitude} outside your normal range.`,
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

  const corrSkip = new Set(o.corrSkip || []);
  const corrSkipDomains = new Set(o.corrSkipDomains || []);
  const corrSkipPairs = o.corrSkipPairs || new Set();
  const skipKey = (k) => corrSkip.has(k) || corrSkipDomains.has(k.split(':')[0]);
  const skipPair = (ka, kb) => corrSkipPairs.has([ka, kb].sort().join('|'));
  // Habit-to-habit correlations are structurally meaningless: habit_score is a
  // composite of all individual habits, so cold_shower ↔ habit_score or
  // eat_healthy ↔ habit_score are trivially correlated, not discoveries.
  // Individual habits also co-vary because they share the same "good day" driver.
  const skipHabitPair = (ka, kb) => ka.split(':')[0] === 'habits' && kb.split(':')[0] === 'habits';
  // Environment metrics are handled exclusively by computeDaytimeCardio, which
  // correlates them against Apple Watch daytime HRV/RHR. Block all env pairs here
  // so the general engine never surfaces weather correlations against Eight Sleep
  // overnight data or any other non-daytime metric.
  const skipEnvPair = (ka, kb) =>
    ka.split(':')[0] === 'environment' || kb.split(':')[0] === 'environment';
  // Tautological pairs: the lever is definitionally an input to the outcome formula,
  // so the correlation carries no information (exercise habit → active energy burned).
  const TAUTOLOGICAL = new Set([
    'habits:exercise|health:active_energy',
    'habits:exercise|health:exercise_minutes',
    'health:exercise_minutes|health:active_energy',
    'health:sleep_hours|health:sleep_score',
    'health:deep_sleep_hours|health:sleep_score',
    'health:rem_sleep_hours|health:sleep_score',
  ]);
  const skipTautological = (ka, kb) => TAUTOLOGICAL.has([ka, kb].sort().join('|'));

  for (let i = 0; i < keys.length; i++) {
    if (skipKey(keys[i])) continue;
    for (let j = i + 1; j < keys.length; j++) {
      if (skipKey(keys[j])) continue;
      if (skipPair(keys[i], keys[j])) continue;
      if (skipHabitPair(keys[i], keys[j])) continue;
      if (skipEnvPair(keys[i], keys[j])) continue;
      if (skipTautological(keys[i], keys[j])) continue;
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
    const positive = c.r >= 0;
    const timing = c.lag === 0 ? 'same-day' : 'next-day';
    const domains = [...new Set([a.domain, b.domain])];
    const confirmNote = c.confirmed ? `confirmed, ${c.n} days` : `${c.n}-day emerging pattern`;

    // Plain English titles — no ↔ notation or statistical symbols.
    const direction = positive ? 'higher' : 'lower';
    const title = c.lag === 0
      ? `Higher ${labelA} goes with ${direction} ${labelB} (${confirmNote})`
      : `Higher ${labelA} today → ${direction} ${labelB} tomorrow (${confirmNote})`;

    const movePhrase = positive ? 'move together' : 'move in opposite directions';
    const confirmPhrase = c.confirmed
      ? 'held consistently in both earlier and more recent periods of your data'
      : 'is still building toward full confirmation';
    const detail = `${labelA} and ${labelB} tend to ${movePhrase} — a ${strength} ${timing} personal pattern that ${confirmPhrase}. Association, not proof of cause.`;

    return {
      type: 'correlation',
      domains,
      title,
      detail,
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

/**
 * Detect a persistent gap between mood and energy over the last 7 days.
 * High mood + low energy is the "running on adrenaline" pattern —
 * you feel good but the body is depleted. Surface it so the user doesn't
 * mistake motivation for physical readiness.
 */
function computeWellbeingGap(seriesByKey) {
  const moodSeries = seriesByKey['wellbeing:mood'];
  const energySeries = seriesByKey['wellbeing:energy'];
  if (!moodSeries || !energySeries) return [];

  const cutoff = Date.now() - 7 * 86400000;
  const logged = (series) =>
    series
      .filter((r) => new Date(r.day).getTime() >= cutoff && Number(r.value) > 0)
      .map((r) => Number(r.value));

  const moodVals = logged(moodSeries);
  const energyVals = logged(energySeries);
  if (moodVals.length < 4 || energyVals.length < 4) return [];

  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const r1 = (n) => Math.round(n * 10) / 10;
  const avgMood = mean(moodVals);
  const avgEnergy = mean(energyVals);
  const gap = avgMood - avgEnergy;
  if (gap < 0.75) return [];

  return [{
    type: 'wellbeing_gap',
    title: `Energy (${r1(avgEnergy)}/5) running ${r1(gap)} pts below mood (${r1(avgMood)}/5)`,
    detail: `Over the last 7 days, mood averaged ${r1(avgMood)}/5 while energy averaged ${r1(avgEnergy)}/5 — a ${r1(gap)}-point gap. High mood with low energy often means running on drive rather than physical reserves. Sleep quality and movement are the fastest levers.`,
    domains: ['wellbeing'],
    confidence: Math.min(1, gap / 2),
    evidence: {
      auto: true,
      kind: 'wellbeing_gap',
      avgMood: r1(avgMood),
      avgEnergy: r1(avgEnergy),
      gap: r1(gap),
      n: Math.min(moodVals.length, energyVals.length),
    },
  }];
}

/**
 * Pure: positive habit consistency findings. Surfaces when a binary habit has
 * been maintained at ≥80% adherence over the last 14 logged days — the "this is
 * sticking" signal that the trend engine misses because there's no *change* to
 * report when you're consistently good.
 */
function computeHabitConsistency(seriesByKey, opts = {}) {
  const BINARY_HABITS = {
    exercise: 'Exercise',
    morning_tm: 'Morning meditation',
    afternoon_tm: 'Afternoon meditation',
    cold_shower: 'Cold shower',
    gratitude: 'Gratitude practice',
  };
  const WINDOW_DAYS = 14;
  const MIN_LOGGED = 7;   // need at least a week of data
  const MIN_ADHERENCE = 0.8; // 80%+ = "consistent"
  const findings = [];

  for (const [metric, label] of Object.entries(BINARY_HABITS)) {
    const key = `habits:${metric}`;
    const series = seriesByKey[key];
    if (!series || series.length < MIN_LOGGED) continue;

    // Only the last WINDOW_DAYS calendar days.
    const cutoff = new Date(Date.now() - WINDOW_DAYS * 864e5);
    const recent = series.filter((r) => new Date(r.day) >= cutoff);
    if (recent.length < MIN_LOGGED) continue;

    const daysHit = recent.filter((r) => Number(r.value) >= 0.5).length;
    const adherence = daysHit / recent.length;
    if (adherence < MIN_ADHERENCE) continue;

    const pctStr = Math.round(adherence * 100) + '%';
    findings.push({
      type: 'habit_consistency',
      domains: ['habits'],
      title: `${label} consistent: ${daysHit}/${recent.length} days (${pctStr})`,
      detail:
        `Your daily logs confirm ${label.toLowerCase()} on ${daysHit} of the last ${recent.length} days — ` +
        `${pctStr} adherence. This habit is sticking.`,
      confidence: round(adherence, 2),
      evidence: {
        auto: true,
        kind: 'habit_consistency',
        metric: key,
        daysHit,
        daysTotal: recent.length,
        adherence: round(adherence, 2),
      },
    });
  }

  return findings;
}

/**
 * Pure: habit-vs-health split analysis. Splits each day as "habit on" or
 * "habit off" and computes the mean health-metric value on each side.
 * Far more actionable than a raw Pearson r — "on cold-shower days, HRV
 * averages 62ms vs 49ms" is a concrete, personal finding.
 */
function computeHabitHealthSplits(seriesByKey, opts = {}) {
  const MIN_N = 5;       // per group (habit-on AND habit-off)
  const MIN_PCT = 0.05;  // 5% minimum difference to report
  const MAX_RESULTS = 5;

  const HABITS = {
    'habits:morning_tm':   'Morning meditation',
    'habits:afternoon_tm': 'Afternoon meditation',
    'habits:cold_shower':  'Cold shower',
    'habits:gratitude':    'Gratitude practice',
    'habits:exercise':     'Exercise',
  };

  const OUTCOMES = {
    'health:hrv':         { label: 'HRV',         unit: 'ms',  good: 'up'   },
    'health:resting_hr':  { label: 'Resting HR',  unit: 'bpm', good: 'down' },
    'health:sleep_score': { label: 'Sleep score', unit: '',    good: 'up'   },
    'health:sleep_hours': { label: 'Sleep',       unit: 'h',   good: 'up'   },
  };

  function dayKey(d) {
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
  }

  function toMap(key) {
    const series = seriesByKey[key];
    if (!series || series.length === 0) return null;
    const m = new Map();
    for (const r of series) m.set(dayKey(r.day), Number(r.value));
    return m;
  }

  function splitStats(habitMap, outcomeMap, threshold = 0.5) {
    const onVals = [], offVals = [];
    for (const [day, val] of outcomeMap) {
      const h = habitMap.get(day);
      if (h === undefined || !Number.isFinite(val)) continue;
      (h >= threshold ? onVals : offVals).push(val);
    }
    if (onVals.length < MIN_N || offVals.length < MIN_N) return null;
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const onMean = mean(onVals), offMean = mean(offVals);
    const pct = offMean !== 0 ? (onMean - offMean) / Math.abs(offMean) : null;
    if (pct == null || Math.abs(pct) < MIN_PCT) return null;
    // Significance gate: a raw mean gap between two small groups of noisy daily
    // readings is mostly sampling noise (two random 5-day samples differ >5% all
    // the time). Require a real two-sample test before this becomes a "finding".
    const w = stats.welchTTest(offVals, onVals); // diff = on − off
    if (!w || w.p == null || w.p > SPLIT_ALPHA) return null;
    return { onMean, offMean, pct, onN: onVals.length, offN: offVals.length, p: w.p, cohenD: w.cohenD, ciLow: w.ciLow, ciHigh: w.ciHigh };
  }

  const candidates = [];

  // Single habit × outcome pairs.
  for (const [habitKey, habitLabel] of Object.entries(HABITS)) {
    const hMap = toMap(habitKey);
    if (!hMap) continue;
    for (const [outcomeKey, info] of Object.entries(OUTCOMES)) {
      const oMap = toMap(outcomeKey);
      if (!oMap) continue;
      const s = splitStats(hMap, oMap);
      if (s) candidates.push({ habitLabel, info, outcomeKey, s });
    }
  }

  // "Both meditations" — special combo the user specifically cares about.
  const mornMap = toMap('habits:morning_tm');
  const aftMap  = toMap('habits:afternoon_tm');
  if (mornMap && aftMap) {
    const bothMap = new Map();
    for (const [day, v] of mornMap) {
      const v2 = aftMap.get(day);
      if (v2 !== undefined) bothMap.set(day, v >= 0.5 && v2 >= 0.5 ? 1 : 0);
    }
    for (const [outcomeKey, info] of Object.entries(OUTCOMES)) {
      const oMap = toMap(outcomeKey);
      if (!oMap) continue;
      const s = splitStats(bothMap, oMap);
      if (s) candidates.push({ habitLabel: 'Both meditations', info, outcomeKey, s });
    }
  }

  // NOTE: subjective wellbeing states (mood / energy / focus) are deliberately NOT
  // used as levers here. They are OUTPUTS of autonomic recovery and sleep, not
  // inputs to them — "high-energy days run better HRV" inverts the causal arrow
  // (good HRV makes you feel energetic, not the reverse) and produces misleading
  // recommendations. Only real, controllable behaviors belong in this split.

  // Multiple-comparisons control: we tested many habit × outcome combinations and
  // are about to surface the strongest. Selecting the max of many comparisons
  // inflates false positives (garden of forking paths), so keep only the pairs
  // whose p-value survives Benjamini–Hochberg FDR across the whole candidate set.
  const sigKeep = stats.benjaminiHochberg(candidates.map((c) => c.s.p), SPLIT_FDR_Q);
  const significant = candidates.filter((_, i) => sigKeep[i]);

  // Best effect per outcome so we don't flood with 5 rows about HRV.
  const bestByOutcome = new Map();
  for (const c of significant) {
    const prev = bestByOutcome.get(c.info.label);
    if (!prev || Math.abs(c.s.pct) > Math.abs(prev.s.pct)) bestByOutcome.set(c.info.label, c);
  }
  const top = [...bestByOutcome.values()]
    .sort((a, b) => Math.abs(b.s.pct) - Math.abs(a.s.pct))
    .slice(0, MAX_RESULTS);

  const fmt = (n, unit) => {
    if (unit === 'h')              return `${Math.round(n * 10) / 10}h`;
    if (unit === 'ms' || unit === 'bpm') return `${Math.round(n)}${unit}`;
    return String(Math.round(n));
  };

  return top.map(({ habitLabel, info, outcomeKey, s }) => {
    const { onMean, offMean, pct, onN, offN } = s;
    const improved = (info.good === 'up' && pct > 0) || (info.good === 'down' && pct < 0);
    const direction = pct > 0 ? 'higher' : 'lower';
    const pctStr = `${pct >= 0 ? '+' : ''}${Math.round(pct * 100)}%`;
    const onFmt = fmt(onMean, info.unit);
    const offFmt = fmt(offMean, info.unit);

    return {
      type: 'habit_split',
      domains: ['habits', 'health'],
      title: `${habitLabel}: ${info.label} ${onFmt} vs ${offFmt} on other days (${pctStr})`,
      detail:
        `On the ${onN} days you logged ${habitLabel.toLowerCase()}, ${info.label.toLowerCase()} averaged ` +
        `${onFmt} — ${Math.abs(Math.round(pct * 100))}% ${direction} than on the ${offN} days without (${offFmt}). ` +
        (improved
          ? `Consistent with ${habitLabel.toLowerCase()} supporting your ${info.label.toLowerCase()} — but it's an association, not proof: days you keep the habit may differ in other ways (better sleep, lower stress), and the arrow can run the other way (you may skip the habit on days you already feel off).`
          : `Association, not proof of cause — other factors may drive this pattern.`),
      confidence: Math.min(0.9, Math.abs(pct) / 0.3),
      evidence: {
        auto: true,
        kind: 'habit_split',
        habit: habitLabel,
        outcome: outcomeKey,
        onMean:  round(onMean),
        offMean: round(offMean),
        pct:     round(pct, 3),
        onN,
        offN,
        p: round(s.p, 4),
        cohenD: round(s.cohenD, 2),
        ci: [round(s.ciLow, 2), round(s.ciHigh, 2)],
      },
    };
  });
}

/**
 * Pure: daytime HRV/RHR vs lifestyle correlates.
 *
 * Apple Watch HRV and RHR daily averages reflect autonomic tone across the whole
 * waking day, making them a stress/balance signal rather than a pure recovery
 * signal (that's what night-source-locked Eight Sleep readings capture). Splits
 * days by eating quality, mood, and focus to surface personal patterns like
 * "On days you eat well, your daytime HRV averages 48ms vs 37ms."
 *
 * Receives a pre-built map that includes ONLY daytime series (loaded from
 * apple_health source) + the relevant lifestyle inputs — so it never interferes
 * with the night-source-locked recovery analysis.
 */
function computeDaytimeCardio(daytimeMap) {
  const MIN_N = 5;
  const MIN_PCT = 0.05;
  const MAX_RESULTS = 4;

  const OUTCOMES = {
    'health:hrv_daytime': { label: 'Daytime HRV', unit: 'ms', good: 'up' },
    'health:rhr_daytime': { label: 'Daytime RHR', unit: 'bpm', good: 'down' },
  };

  // Each lever: key in daytimeMap, human label, threshold for "high" bucket.
  const LEVERS = [
    { key: 'habits:eat_healthy',        label: 'Eating well',          threshold: 3 },
    { key: 'wellbeing:mood',            label: 'High-mood days',       threshold: 4 },
    { key: 'wellbeing:focus',           label: 'High-focus days',      threshold: 4 },
    // Wake time >= 7 = woke at/after 7am. Threshold chosen to split typical
    // sleep pattern in halves — 7am is the user's approximate midpoint.
    { key: 'health:wake_time',          label: 'Waking after 7am',     threshold: 7.0 },
    // Weather levers — Apple Watch daytime RHR/HRV vs outdoor conditions.
    // 70°F splits warm vs cool days; 65% splits muggy vs comfortable humidity.
    { key: 'environment:temperature',   label: 'Warm days (>70°F)',    threshold: 70 },
    { key: 'environment:humidity',      label: 'High-humidity days',   threshold: 65 },
  ];

  function dayKey(d) {
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
  }

  function toMap(key) {
    const series = daytimeMap[key];
    if (!series || series.length === 0) return null;
    const m = new Map();
    for (const r of series) m.set(dayKey(r.day), Number(r.value));
    return m;
  }

  function splitStats(leverMap, outcomeMap, threshold) {
    const hiVals = [], loVals = [];
    for (const [day, val] of outcomeMap) {
      const l = leverMap.get(day);
      if (l === undefined || !Number.isFinite(val)) continue;
      (l >= threshold ? hiVals : loVals).push(val);
    }
    if (hiVals.length < MIN_N || loVals.length < MIN_N) return null;
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const hiMean = avg(hiVals);
    const loMean = avg(loVals);
    const pct = loMean !== 0 ? (hiMean - loMean) / Math.abs(loMean) : null;
    if (pct == null || Math.abs(pct) < MIN_PCT) return null;
    // Two-sample significance gate — see computeHabitHealthSplits for rationale.
    const w = stats.welchTTest(loVals, hiVals); // diff = hi − lo
    if (!w || w.p == null || w.p > SPLIT_ALPHA) return null;
    return { hiMean, loMean, pct, hiN: hiVals.length, loN: loVals.length, p: w.p, cohenD: w.cohenD, ciLow: w.ciLow, ciHigh: w.ciHigh };
  }

  const candidates = [];
  for (const lever of LEVERS) {
    const lMap = toMap(lever.key);
    if (!lMap) continue;
    for (const [outKey, outInfo] of Object.entries(OUTCOMES)) {
      const oMap = toMap(outKey);
      if (!oMap) continue;
      const s = splitStats(lMap, oMap, lever.threshold);
      if (s) candidates.push({ lever, outInfo, outKey, s });
    }
  }

  if (!candidates.length) return [];

  // FDR control across all lever × outcome comparisons before picking the best.
  const sigKeep = stats.benjaminiHochberg(candidates.map((c) => c.s.p), SPLIT_FDR_Q);
  const significant = candidates.filter((_, i) => sigKeep[i]);
  if (!significant.length) return [];

  // Best lever per outcome — don't flood with all combinations.
  const bestByOutcome = new Map();
  for (const c of significant) {
    const prev = bestByOutcome.get(c.outInfo.label);
    if (!prev || Math.abs(c.s.pct) > Math.abs(prev.s.pct)) bestByOutcome.set(c.outInfo.label, c);
  }

  const top = [...bestByOutcome.values()]
    .sort((a, b) => Math.abs(b.s.pct) - Math.abs(a.s.pct))
    .slice(0, MAX_RESULTS);

  const fmt = (n, unit) =>
    unit === 'ms' || unit === 'bpm' ? `${Math.round(n)}${unit}` : `${round(n, 1)}`;

  return top.map(({ lever, outInfo, outKey, s }) => {
    const { hiMean, loMean, pct, hiN, loN } = s;
    const improved = (outInfo.good === 'up' && pct > 0) || (outInfo.good === 'down' && pct < 0);
    const dir = pct > 0 ? 'higher' : 'lower';
    const pctStr = `${pct >= 0 ? '+' : ''}${Math.round(pct * 100)}%`;
    return {
      type: 'daytime_cardio',
      domains: ['health', 'wellbeing', 'habits'],
      title: `${lever.label}: ${outInfo.label} ${fmt(hiMean, outInfo.unit)} vs ${fmt(loMean, outInfo.unit)} (${pctStr})`,
      detail:
        `On the ${hiN} days with ${lever.label.toLowerCase()}, your ${outInfo.label.toLowerCase()} averaged ` +
        `${fmt(hiMean, outInfo.unit)} — ${Math.abs(Math.round(pct * 100))}% ${dir} than on the ${loN} ` +
        `other days (${fmt(loMean, outInfo.unit)}). ` +
        (improved
          ? `${lever.label} tracks with better autonomic tone during the day — an association, not proof: the two may share a common driver, and for mood/focus the effect can even run the other way (good autonomic state makes you feel better, not only the reverse).`
          : `Association, not proof of cause — other factors may drive this pattern.`),
      confidence: Math.min(0.9, Math.abs(pct) / 0.3),
      evidence: {
        auto: true,
        kind: 'daytime_cardio',
        lever: lever.key,
        outcome: outKey,
        hiMean: round(hiMean),
        loMean: round(loMean),
        pct: round(pct, 3),
        hiN,
        loN,
        p: round(s.p, 4),
        cohenD: round(s.cohenD, 2),
        ci: [round(s.ciLow, 2), round(s.ciHigh, 2)],
      },
    };
  });
}

/**
 * Pure: SLEEP-impact split — the lever the user most wants to understand. The
 * general correlation engine tests sleep too, but a best-vs-worst-nights split
 * is far more actionable. Splits nights into the user's best third vs worst third
 * (by sleep_score, falling back to sleep_hours) and compares SAME-day outcomes —
 * in the spine sleep[D] is last night and hrv[D]/mood[D] are that same morning/
 * day. Returns up to MAX_RESULTS findings, strongest effect first.
 */
function computeSleepImpact(seriesByKey) {
  const MIN_N = 4, MIN_PCT = 0.05, MAX_RESULTS = 4;

  // Try sleep_score first (richest signal), then sleep_hours — use the first
  // driver that has enough nights AND enough spread to form best/worst thirds.
  // The old code locked onto one driver and bailed if it lacked spread, so a
  // user with very consistent sleep_score got NO sleep-impact insights at all
  // even when sleep_hours varied plenty. This is the Health tab's headline lever,
  // so it should fire whenever any sleep dimension has usable variation.
  let driverKey = null, driverByDay = null, loCut = null, hiCut = null;
  for (const cand of ['health:sleep_score', 'health:sleep_hours']) {
    const series = seriesByKey[cand];
    if (!series || series.length < 2 * MIN_N + 2) continue;
    const byDay = new Map();
    for (const r of series) {
      const v = Number(r.value);
      if (Number.isFinite(v)) byDay.set(toDayKey(r.day), v);
    }
    const vals = [...byDay.values()].sort((a, b) => a - b);
    const lo = vals[Math.floor((vals.length - 1) / 3)];
    const hi = vals[Math.ceil((vals.length - 1) * 2 / 3)];
    if (hi > lo) { driverKey = cand; driverByDay = byDay; loCut = lo; hiCut = hi; break; }
  }
  if (!driverKey) return []; // no sleep dimension with usable spread

  const OUTCOMES = {
    'health:hrv':        { label: 'HRV',        unit: 'ms',  good: 'up'   },
    'health:resting_hr': { label: 'resting HR', unit: 'bpm', good: 'down' },
    'wellbeing:energy':  { label: 'energy',     unit: '/5',  good: 'up'   },
    'wellbeing:focus':   { label: 'focus',      unit: '/5',  good: 'up'   },
    'wellbeing:mood':    { label: 'mood',       unit: '/5',  good: 'up'   },
  };
  const fmt = (n, unit) =>
    unit === 'ms' || unit === 'bpm' ? `${Math.round(n)}${unit}` : `${round(n, 1)}${unit === '/5' ? '/5' : ''}`;

  const scored = [];
  for (const [okey, info] of Object.entries(OUTCOMES)) {
    const series = seriesByKey[okey];
    if (!series) continue;
    const goodVals = [], poorVals = [];
    for (const r of series) {
      const v = Number(r.value);
      if (!Number.isFinite(v)) continue;
      const d = driverByDay.get(toDayKey(r.day));
      if (d == null) continue;
      if (d >= hiCut) goodVals.push(v);
      else if (d <= loCut) poorVals.push(v);
    }
    if (goodVals.length < MIN_N || poorVals.length < MIN_N) continue;
    const gm = mean(goodVals), pm = mean(poorVals);
    const pct = pm !== 0 ? (gm - pm) / Math.abs(pm) : null;
    if (pct == null || Math.abs(pct) < MIN_PCT) continue;
    // Significance gate: best-third vs worst-third nights are still two small,
    // noisy samples. Require a real two-sample test before calling sleep a "lever".
    const w = stats.welchTTest(poorVals, goodVals); // diff = good − poor
    if (!w || w.p == null || w.p > SPLIT_ALPHA) continue;

    const better = (info.good === 'up' && pct > 0) || (info.good === 'down' && pct < 0);
    const dir = pct > 0 ? 'higher' : 'lower';
    const domains = okey.startsWith('wellbeing') ? ['health', 'wellbeing'] : ['health'];
    scored.push({
      absPct: Math.abs(pct),
      p: w.p,
      finding: {
        type: 'sleep_impact',
        domains,
        title: `Sleep → ${info.label}: ${fmt(gm, info.unit)} best nights vs ${fmt(pm, info.unit)} worst (${pct >= 0 ? '+' : ''}${Math.round(pct * 100)}%)`,
        detail:
          `After your best-slept nights, ${info.label} averages ${fmt(gm, info.unit)} — ` +
          `${Math.abs(Math.round(pct * 100))}% ${dir} than after your worst-slept nights (${fmt(pm, info.unit)}), ` +
          `across ${goodVals.length}+${poorVals.length} days. ` +
          (better
            ? `Sleep is one of your strongest levers for ${info.label}.`
            : `Association, not proof of cause — other factors may contribute.`),
        confidence: Math.min(0.9, Math.abs(pct) / 0.3),
        evidence: {
          auto: true, kind: 'sleep_impact', driver: driverKey, outcome: okey,
          goodMean: round(gm), poorMean: round(pm), pct: round(pct, 3),
          goodN: goodVals.length, poorN: poorVals.length,
          p: round(w.p, 4), cohenD: round(w.cohenD, 2), ci: [round(w.ciLow, 2), round(w.ciHigh, 2)],
        },
      },
    });
  }
  // FDR control across the outcomes tested against the sleep driver.
  const keep = stats.benjaminiHochberg(scored.map((s) => s.p), SPLIT_FDR_Q);
  const sig = scored.filter((_, i) => keep[i]);
  sig.sort((a, b) => b.absPct - a.absPct);
  return sig.slice(0, MAX_RESULTS).map((s) => s.finding);
}

/**
 * Pure: EXERCISE-TYPE → next-day recovery. Answers "how do different workouts
 * affect the following day?" For each prior-day activity type, compares the
 * NEXT day's HRV / resting HR against the user's overall next-day average. The
 * activityTypeByDay map ({ 'YYYY-MM-DD': 'zone2'|'pull'|... }) is built from
 * logged activities + the scheduled plan (see loadActivityTypeByDay).
 */
function computeActivityImpact(seriesByKey, activityTypeByDay) {
  const MIN_N = 4, MIN_PCT = 0.05;
  if (!activityTypeByDay || Object.keys(activityTypeByDay).length < 2 * MIN_N) return [];

  const OUTCOMES = {
    'health:hrv':        { label: 'HRV',        unit: 'ms',  good: 'up'   },
    'health:resting_hr': { label: 'resting HR', unit: 'bpm', good: 'down' },
  };
  const TYPE_LABELS = {
    zone2: 'Zone 2', walk: 'a walk', run: 'a run', strength: 'strength',
    push: 'Push', pull: 'Pull', intervals: 'intervals', mobility: 'mobility',
    yoga: 'yoga', other: 'other training',
  };
  const fmt = (n, unit) => `${Math.round(n)}${unit}`;
  const nextDay = (day) => {
    const dt = new Date(`${day}T12:00:00`);
    dt.setDate(dt.getDate() + 1);
    return toDayKey(dt);
  };

  const findings = [];
  for (const [okey, info] of Object.entries(OUTCOMES)) {
    const series = seriesByKey[okey];
    if (!series) continue;
    const outByDay = new Map();
    for (const r of series) {
      const v = Number(r.value);
      if (Number.isFinite(v)) outByDay.set(toDayKey(r.day), v);
    }
    const byType = {}; const allVals = [];
    for (const [day, type] of Object.entries(activityTypeByDay)) {
      const ov = outByDay.get(nextDay(day));
      if (ov == null) continue;
      (byType[type] ||= []).push(ov);
      allVals.push(ov);
    }
    if (allVals.length < 2 * MIN_N) continue;
    const overall = mean(allVals);

    // Test each activity type against the days following ALL OTHER types (a
    // type-vs-rest two-sample test), not against an overall mean that includes
    // the type itself. Gate on Welch significance, then BH-correct across the
    // types tested so the strongest of many isn't a forking-paths artifact.
    const typeCands = [];
    for (const [type, arr] of Object.entries(byType)) {
      if (arr.length < MIN_N) continue;
      const rest = [];
      for (const [t2, arr2] of Object.entries(byType)) if (t2 !== type) rest.push(...arr2);
      if (rest.length < MIN_N) continue;
      const m = mean(arr);
      const pct = overall !== 0 ? (m - overall) / Math.abs(overall) : null;
      if (pct == null || Math.abs(pct) < MIN_PCT) continue;
      const w = stats.welchTTest(rest, arr); // diff = type − rest
      if (!w || w.p == null || w.p > SPLIT_ALPHA) continue;
      typeCands.push({ type, m, pct, n: arr.length, p: w.p, cohenD: w.cohenD, ciLow: w.ciLow, ciHigh: w.ciHigh });
    }
    if (!typeCands.length) continue;
    const keepT = stats.benjaminiHochberg(typeCands.map((c) => c.p), SPLIT_FDR_Q);
    const sigT = typeCands.filter((_, i) => keepT[i]);
    if (!sigT.length) continue;
    let best = null;
    for (const c of sigT) if (!best || Math.abs(c.pct) > Math.abs(best.pct)) best = c;

    const typeLabel = TYPE_LABELS[best.type] || best.type;
    const dir = best.pct > 0 ? 'higher' : 'lower';
    const better = (info.good === 'up' && best.pct > 0) || (info.good === 'down' && best.pct < 0);
    findings.push({
      type: 'activity_impact',
      domains: ['health'],
      title: `Day after ${typeLabel}: ${info.label} ${fmt(best.m, info.unit)} vs ${fmt(overall, info.unit)} typical (${best.pct >= 0 ? '+' : ''}${Math.round(best.pct * 100)}%)`,
      detail:
        `On the ${best.n} days following ${typeLabel}, next-morning ${info.label} averaged ${fmt(best.m, info.unit)} — ` +
        `${Math.abs(Math.round(best.pct * 100))}% ${dir} than your overall next-day average (${fmt(overall, info.unit)}). ` +
        (better
          ? `${typeLabel[0].toUpperCase() + typeLabel.slice(1)} appears easy on your next-day recovery.`
          : `${typeLabel[0].toUpperCase() + typeLabel.slice(1)} tends to cost you next-day recovery — plan an easier day after.`),
      confidence: Math.min(0.85, Math.abs(best.pct) / 0.25),
      evidence: {
        auto: true, kind: 'activity_impact', activity: best.type, outcome: okey,
        typeMean: round(best.m), overallMean: round(overall), pct: round(best.pct, 3), n: best.n,
        p: round(best.p, 4), cohenD: round(best.cohenD, 2), ci: [round(best.ciLow, 2), round(best.ciHigh, 2)],
      },
    });
  }
  return findings;
}

/**
 * Build { 'YYYY-MM-DD': activityType } over the load window. Sources, in
 * increasing authority: the deterministic weekly plan on days the Exercise habit
 * was logged, then actual logged activities (which override the plan). Lets the
 * exercise-type analysis work from day one off the plan, then sharpen as real
 * activity logs accumulate.
 */
async function loadActivityTypeByDay(seriesByKey, from) {
  // JS getDay (0=Sun..6=Sat) → scheduled type id, mirroring services/workout.js.
  const PLAN_BY_JS_DAY = { 0: 'pull', 1: 'zone2', 2: 'mobility', 3: 'intervals', 4: 'push', 5: 'rest', 6: 'zone2' };
  const map = {};

  const ex = seriesByKey['habits:exercise'];
  if (ex) {
    for (const r of ex) {
      if (Number(r.value) >= 0.5) {
        const day = toDayKey(r.day);
        const t = PLAN_BY_JS_DAY[new Date(`${day}T12:00:00`).getDay()];
        if (t && t !== 'rest') map[day] = t;
      }
    }
  }

  try {
    const { rows } = await require('../db').query(
      `SELECT log_date, activity_type FROM activity_logs WHERE log_date >= $1 ORDER BY log_date, id`,
      [from]
    );
    for (const r of rows) {
      if (r.activity_type && r.activity_type !== 'rest') map[toDayKey(r.log_date)] = r.activity_type;
    }
  } catch { /* activity_logs table optional */ }

  return map;
}

/** Orchestrator: load series, compute findings, persist them. */
async function analyze(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const metricsStore = require('../store/metrics');
  const findingsStore = require('../store/findings');

  const from = new Date(Date.now() - o.loadDays * 24 * 60 * 60 * 1000);
  const keys = await metricsStore.listMetricKeys();

  // HRV and RHR are source-locked to the manually-entered Eight Sleep overnight
  // numbers (+ seeded baseline), exactly as the live recovery card does — so the
  // whole analysis engine (trends, anomalies, correlations, recovery composite)
  // uses ONE consistent night-vs-night HRV/RHR series instead of averaging in
  // noisy daytime Apple Watch readings. Everything else aggregates all sources.
  const NIGHT_SOURCES = ['eight_sleep', 'eight_sleep_baseline'];
  const SOURCE_LOCK = { 'health:hrv': NIGHT_SOURCES, 'health:resting_hr': NIGHT_SOURCES };
  const CUMULATIVE = new Set(['steps', 'active_energy', 'exercise_minutes', 'mindful_minutes']);

  const seriesByKey = {};
  for (const { domain, metric } of keys) {
    // Only analyze metrics we deliberately track. listMetricKeys() returns every
    // distinct key in the table — including stale/retired ones (e.g. the old
    // Readwise/Notion sync counts) whose historical rows still linger. Keying
    // findings off whatever happens to be in the DB lets retired metrics keep
    // generating bogus trends/anomalies, so gate on the catalog registry.
    if (!cat.isTracked(domain, metric)) continue;
    const key = `${domain}:${metric}`;
    const lockSources = SOURCE_LOCK[key];
    let rows = lockSources
      ? await metricsStore.dailyAggregatePreferSource({ domain, metric, from, agg: 'avg', sources: lockSources })
      : await metricsStore.dailyAggregate({
          domain,
          metric,
          from,
          agg: cat.aggFor(metric),
          excludeSource: 'seed', // keep demo data from inflating real-data sums
        });
    // Cumulative metrics accumulate over the day, so today's value is a partial
    // running total until midnight. Including it makes trends/anomalies read a
    // sharp false "drop" (e.g. "steps down 94%") when compared to complete prior
    // days. Drop today's trailing point for these metrics.
    //
    // Compare in UTC: date_trunc('day', ts) returns midnight UTC for each bucket,
    // so comparing with toLocaleDateString() would convert midnight UTC to the
    // prior evening in Eastern time — causing today's row to look like yesterday
    // and the exclusion to silently fail. UTC slice is the right anchor.
    if (rows.length && CUMULATIVE.has(metric)) {
      const todayUtc = new Date().toISOString().slice(0, 10);
      const lastDay = rows[rows.length - 1].day;
      const lastDayUtc = (lastDay instanceof Date ? lastDay : new Date(lastDay)).toISOString().slice(0, 10);
      if (lastDayUtc === todayUtc) rows = rows.slice(0, -1);
    }
    if (rows.length) seriesByKey[key] = rows;
  }

  // Load Eight Sleep's personalized sleep debt/need — used by computeHealthComposites
  // but NOT included in trends/anomalies/correlations (derived, not raw inputs).
  for (const esKey of ['health:sleep_debt', 'health:sleep_need']) {
    if (!seriesByKey[esKey]) {
      const [dm, mt] = esKey.split(':');
      try {
        const rows = await metricsStore.dailyAggregatePreferSource({
          domain: dm, metric: mt, from, agg: 'avg', sources: ['eight_sleep'],
        });
        if (rows.length) seriesByKey[esKey] = rows;
      } catch { /* non-critical — composites fall back to generic computation */ }
    }
  }

  // Load Apple Watch daytime HRV/RHR separately from the night-source-locked
  // series. These go into a private map consumed only by computeDaytimeCardio —
  // they never enter the general correlation/trend/anomaly engines, so there's
  // no risk of trivial hrv↔hrv_daytime findings or polluting the recovery signal.
  const daytimeMap = {};
  for (const [vtKey, metric] of [['health:hrv_daytime', 'hrv'], ['health:rhr_daytime', 'resting_hr']]) {
    try {
      const rows = await metricsStore.dailyAggregatePreferSource({
        domain: 'health', metric, from, agg: 'avg', sources: ['apple_health'],
      });
      if (rows.length) daytimeMap[vtKey] = rows;
    } catch { /* non-critical */ }
  }
  // Include the lifestyle inputs the daytime function needs.
  for (const k of ['habits:eat_healthy', 'wellbeing:mood', 'wellbeing:focus']) {
    if (seriesByKey[k]) daytimeMap[k] = seriesByKey[k];
  }
  // Eight Sleep wake time pairs naturally with daytime autonomic tone even though
  // it's a nightly metric — load it here rather than the night-locked series.
  try {
    const wakeRows = await metricsStore.dailyAggregatePreferSource({
      domain: 'health', metric: 'wake_time', from, agg: 'avg', sources: ['eight_sleep'],
    });
    if (wakeRows.length) daytimeMap['health:wake_time'] = wakeRows;
  } catch { /* non-critical — Eight Sleep may not have timing data */ }
  // Environment metrics (temperature, humidity) enter daytimeMap so computeDaytimeCardio
  // can correlate them against Apple Watch daytime HRV/RHR. They are explicitly blocked
  // from the general computeCorrelations engine below (env data is NOT from Apple Watch).
  for (const envKey of ['environment:temperature', 'environment:humidity']) {
    if (seriesByKey[envKey]) daytimeMap[envKey] = seriesByKey[envKey];
  }
  const daytimeCardio = computeDaytimeCardio(daytimeMap);

  const trends = computeTrends(seriesByKey, o);
  const correlations = computeCorrelations(seriesByKey, o);
  const anomalies = computeAnomalies(seriesByKey, o);
  const composites = computeHealthComposites(seriesByKey, o);

  // Annotate anomaly findings with life-context annotations. Look back to
  // yesterday too — a "Knicks game last night" entered Wednesday explains
  // Thursday morning's low sleep/HRV just as much as a same-day annotation.
  try {
    const annotationsStore = require('../store/annotations');
    const startOfYesterday = new Date(); startOfYesterday.setDate(startOfYesterday.getDate() - 1); startOfYesterday.setHours(0, 0, 0, 0);
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const active = await annotationsStore.overlapping(startOfYesterday, new Date());
    // Exclude spending/wealth annotations — those only belong in wealth insights,
    // not as context for health or habit anomaly findings. Check both the category
    // AND the stored question/label: a spending-spike answer ("vacation bills") may
    // have been saved under the generic brief_context category, but its question
    // ("You spent $665...") still identifies it as financial, not a health driver.
    const SPEND_RE = /spend|wealth|financ|budget|\$\d|money|bill/i;
    const lifeAnnotations = active.filter((a) => {
      const cat = String(a.category || '').toLowerCase();
      if (cat.includes('spend') || cat.includes('wealth') || cat.includes('financ')) return false;
      return !SPEND_RE.test(`${a.label || ''} ${a.note || ''}`);
    });
    // Life context (a late meal, a drink, a hot room, travel, a rough night) can
    // plausibly explain a RECOVERY or WELLBEING deviation — HRV, resting HR, sleep,
    // breathing rate, mood/energy/focus. It does NOT explain an ACTIVITY metric:
    // "a heavy meal explains low steps" is nonsense. Only attach the context to
    // anomalies it could actually account for.
    const CONTEXTABLE = new Set([
      'health:hrv', 'health:resting_hr', 'health:sleep_hours', 'health:sleep_score',
      'health:deep_sleep_hours', 'health:rem_sleep_hours', 'health:respiratory_rate',
      'wellbeing:mood', 'wellbeing:energy', 'wellbeing:focus',
    ]);
    if (lifeAnnotations.length) {
      const ctx = lifeAnnotations.map((a) => {
        const when = new Date(a.start_ts) >= startOfToday ? 'today' : 'yesterday';
        return `${a.label || a.category} (${when})`;
      }).slice(0, 3).join('; ');
      for (const a of anomalies) {
        if (!CONTEXTABLE.has(a.evidence?.metric)) continue; // not a deviation this context explains
        a.detail += ` (Context: ${ctx} — may explain this deviation.)`;
      }
    }
  } catch { /* non-critical — don't break the analysis */ }
  const habitConsistency = computeHabitConsistency(seriesByKey, o);
  const habitHealthSplits = computeHabitHealthSplits(seriesByKey, o);
  const sleepImpact = computeSleepImpact(seriesByKey);
  const activityTypeByDay = await loadActivityTypeByDay(seriesByKey, from);
  const activityImpact = computeActivityImpact(seriesByKey, activityTypeByDay);
  const wellbeingGap = computeWellbeingGap(seriesByKey);

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
  // Feed ALL finding types into the leverage engine, not just trends + correlations.
  // habit_splits ("cold shower days: HRV 26% higher"), sleep_impact ("best nights →
  // focus 35% higher"), and activity_impact ("Zone 2 → next-day HRV 18% above avg")
  // are the richest, most personal insights — they were computed above but never
  // reached the leverage engine. Now they're the PRIMARY source of leverage actions.
  const actions = rankActions(
    [...trends, ...correlations, ...habitHealthSplits, ...sleepImpact, ...activityImpact],
    { goals, latestByKey },
  );

  // Goal achievement-probability forecasts from the same loaded series.
  const forecasts = computeForecasts(goals, seriesByKey);

  const all = [...trends, ...correlations, ...anomalies, ...composites, ...actions, ...forecasts, ...habitConsistency, ...habitHealthSplits, ...sleepImpact, ...activityImpact, ...daytimeCardio, ...wellbeingGap];
  const windowStart = from;
  const windowEnd = new Date();

  // Supersede old findings and write the new set atomically, so a mid-run
  // failure can't leave the user with everything superseded and only a partial
  // set re-created (which the dashboard reads as 'open').
  const COMPOSITE_TYPES = ['recovery', 'sleep_debt', 'sleep_consistency', 'training_load', 'strain', 'fitness'];
  const { withTransaction } = require('../db');
  await withTransaction(async (client) => {
    const tx = (text, params) => client.query(text, params);
    await findingsStore.supersedeAuto(['trend', 'correlation', 'anomaly', 'leverage', 'forecast', 'habit_consistency', 'habit_split', 'sleep_impact', 'activity_impact', 'daytime_cardio', 'wellbeing_gap', ...COMPOSITE_TYPES], tx);
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
    habitConsistency: habitConsistency.length,
    habitHealthSplits: habitHealthSplits.length,
    sleepImpact: sleepImpact.length,
    activityImpact: activityImpact.length,
    daytimeCardio: daytimeCardio.length,
  };
}

module.exports = { analyze, computeTrends, computeCorrelations, computeAnomalies, computeHabitConsistency, computeHabitHealthSplits, computeSleepImpact, computeActivityImpact, computeDaytimeCardio, computeWellbeingGap, DEFAULTS };

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
