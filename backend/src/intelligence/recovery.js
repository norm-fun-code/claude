// Derived health constructs — the composite scores that make Oura/Whoop feel
// "world-class": readiness/recovery, sleep debt, sleep consistency, and training
// load (acute:chronic). Everything here is PURE — it takes daily series and
// returns numbers/findings, so it's fully unit-testable. The orchestrator
// (analyze.js) feeds it the same per-metric series it already loads.
const stats = require('./stats');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Latest numeric value of a [{day,value}] series, or null. */
function latest(series) {
  if (!series || !series.length) return null;
  const v = Number(series[series.length - 1].value);
  return Number.isFinite(v) ? v : null;
}

/** Rank-based percentile: what fraction of the last `baselineDays` days does
 *  today's value beat? No distribution assumption — self-calibrates to actual
 *  variance automatically. `invert` for lower-is-better metrics (resting HR).
 *  Returns null without enough history (minN baseline days required). */
function rankPercentile(series, { baselineDays = 30, minN = 8, invert = false } = {}) {
  const values = series.map((p) => Number(p.value)).filter(Number.isFinite);
  if (values.length < minN + 1) return null;
  const today = values[values.length - 1];
  const baseline = values.slice(-(baselineDays + 1), -1);
  if (baseline.length < minN) return null;
  const n = baseline.length;
  const beats = invert
    ? baseline.filter((v) => v > today).length
    : baseline.filter((v) => v < today).length;
  const ties  = baseline.filter((v) => v === today).length;
  return Math.round(((beats + ties * 0.5) / n) * 100);
}

/**
 * Compress extreme rank percentiles so your single worst day ≠ 0% recovered
 * and your single best day ≠ 100%. The middle range (20–80) is nearly linear;
 * only the tails are softened. Whoop's score likewise never truly bottoms out.
 *
 *   rank   0 →  10  (floor: worst day still means something)
 *   rank  20 →  28
 *   rank  50 →  50  (median day = 50)
 *   rank  80 →  72
 *   rank 100 →  92  (ceiling: best day still has room to grow)
 */
function softScore(rank) {
  if (rank <= 20) return Math.round(10 + rank * 0.9);          // 0→10, 20→28
  if (rank >= 80) return Math.round(72 + (rank - 80) * 1.0);   // 80→72, 100→92
  return Math.round(28 + (rank - 20) * (44 / 60));             // 20→28, 80→72 linear
}

/** Rank percentile then soft-scored. Used for HRV and RHR components. */
function baselineScore(series, opts = {}) {
  const rank = rankPercentile(series, opts);
  return rank == null ? null : softScore(rank);
}

/**
 * Last-night value vs the mean of the prior `baselineDays` days — a TREND
 * (direction) signal, not an absolute rank. This is Oura's "HRV balance" idea:
 * a declining trajectory is an early overreach/strain warning even when today's
 * absolute value still ranks okay against the longer baseline.
 *
 * Returns a 0..100 score (50 = flat vs last week), or null without enough
 * history. ~2 points per 1% change, clamped to 5..95 so one outlier night can't
 * pin the term at an extreme.
 */
function trendScore(series, { baselineDays = 7, minN = 4 } = {}) {
  const values = (series || []).map((p) => Number(p.value)).filter(Number.isFinite);
  if (values.length < minN + 1) return null;
  const today = values[values.length - 1];
  const baseline = values.slice(-(baselineDays + 1), -1);
  if (baseline.length < minN) return null;
  const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  if (!(mean > 0)) return null;
  const pct = (today - mean) / mean; // +0.15 = 15% above last week's average
  return Math.round(Math.max(5, Math.min(95, 50 + pct * 100 * 2)));
}

/** Sum the last `n` present values of a series. */
function sumLast(series, n) {
  return series.slice(-n).reduce((s, p) => s + (Number(p.value) || 0), 0);
}

// ---------------------------------------------------------------------------
// Readiness / Recovery
// ---------------------------------------------------------------------------

/**
 * A composite recovery score (0–100), normalized to the user's OWN baselines.
 * Weights follow the autonomic-dominant hierarchy Whoop/Oura use, with two
 * refinements beyond a plain HRV/RHR/sleep average:
 *
 *   HRV level   45% — primary autonomic signal (rank vs personal baseline)
 *   HRV trend   10% — Oura "HRV balance": last night vs the 7-day mean. Catches
 *                      a declining trajectory the absolute rank misses (early
 *                      overreach), and rewards a recovering one.
 *   Resting HR  20% — secondary cardiovascular (rank, inverted)
 *   Sleep       25% — sleep_score (which already encodes deep/REM/total, so we
 *                      DON'T add those as separate terms — that would double-count
 *                      sleep and dilute the autonomic signal); falls back to
 *                      sleep_hours rank if no score is present.
 *
 * Autonomic inputs (HRV level + trend + RHR) total 75%. Weights re-normalize over
 * whatever inputs are actually present, so a missing signal doesn't skew the
 * result. Each rank-based percentile is soft-scored so single-day extremes don't
 * dominate. Returns { score, parts } or null.
 */
function recoveryScore(seriesByKey, opts = {}) {
  const o = { baselineDays: 30, minN: 8, ...opts };
  const parts = {};
  const weights = {};

  const hrv = seriesByKey['health:hrv'];
  const rhr = seriesByKey['health:resting_hr'];
  const sleep = seriesByKey['health:sleep_hours'];
  const sleepScore = seriesByKey['health:sleep_score'];

  if (hrv) {
    const s = baselineScore(hrv, o);
    if (s != null) { parts.hrv = s; weights.hrv = 0.45; }
    // HRV trend (direction vs last week) — distinct from the absolute-level rank.
    const t = trendScore(hrv, { baselineDays: 7, minN: 4 });
    if (t != null) { parts.hrvTrend = t; weights.hrvTrend = 0.10; }
  }
  if (rhr) {
    const s = baselineScore(rhr, { ...o, invert: true });
    if (s != null) { parts.restingHr = s; weights.restingHr = 0.2; }
  }
  // Prefer an explicit sleep score (already includes deep/REM/total), else hours.
  if (sleepScore && latest(sleepScore) != null) {
    parts.sleep = Math.round(Math.max(0, Math.min(100, latest(sleepScore))));
    weights.sleep = 0.25;
  } else if (sleep) {
    const s = baselineScore(sleep, o);
    if (s != null) { parts.sleep = s; weights.sleep = 0.25; }
  }

  const keys = Object.keys(parts);
  if (!keys.length) return null;

  // Recovery is a baseline-relative construct. HRV/RHR only contribute once
  // there's a personal baseline (>=8 days, enforced in baselineScore). Don't
  // surface a "recovery score" built ONLY from a single night's sleep number —
  // that would be a confident headline with no baseline behind it. Require at
  // least one baseline-derived autonomic input (hrv or restingHr).
  const hasBaselineInput = parts.hrv != null || parts.restingHr != null;
  if (!hasBaselineInput) return null;

  // Re-normalize weights over whatever inputs we actually have.
  const wsum = keys.reduce((a, k) => a + weights[k], 0);
  const score = Math.round(keys.reduce((a, k) => a + parts[k] * (weights[k] / wsum), 0));

  return { score, parts, inputs: keys.length };
}

/** Band + guidance for a recovery score, à la Whoop's red/yellow/green. */
function recoveryBand(score) {
  if (score >= 67) return { band: 'green',  guidance: "Green — your body's ready. Full intensity is appropriate today." };
  if (score >= 50) return { band: 'yellow', guidance: 'Moderate — solid foundation. Push if you feel good, but watch your exertion.' };
  if (score >= 34) return { band: 'yellow', guidance: 'Below baseline — train at moderate intensity and prioritize recovery tonight.' };
  return { band: 'red', guidance: 'Low — your nervous system is strained. Keep it easy today; let the adaptation happen.' };
}

// ---------------------------------------------------------------------------
// Sleep debt & consistency
// ---------------------------------------------------------------------------

/**
 * Cumulative sleep debt over the last `days`: total shortfall vs a nightly need
 * (default 8h), in hours. Only counts nights below need (surplus nights don't
 * fully "repay" debt in the physiological model, but we let a good night offset
 * the rolling sum partially by capping per-night credit). Returns { debtHours,
 * nights, avgHours } or null.
 */
function sleepDebt(sleepSeries, { need = 8, days = 7, maxCreditPerNight = 1 } = {}) {
  if (!sleepSeries || !sleepSeries.length) return null;
  const recent = sleepSeries.slice(-days).map((p) => Number(p.value)).filter(Number.isFinite);
  if (!recent.length) return null;
  let debt = 0;
  for (const h of recent) {
    const delta = need - h;
    if (delta > 0) debt += delta;            // shortfall adds debt
    else debt -= Math.min(maxCreditPerNight, -delta); // surplus repays a little
  }
  debt = Math.max(0, debt);
  const avgHours = recent.reduce((a, b) => a + b, 0) / recent.length;
  return { debtHours: Math.round(debt * 10) / 10, nights: recent.length, avgHours: Math.round(avgHours * 10) / 10, need };
}

/**
 * Sleep-timing consistency: the standard deviation of nightly sleep DURATION
 * over the window (a proxy for regularity when we only store hours, not clock
 * times). Lower is steadier. Returns { stdHours, score } where score is 0..100
 * (100 = perfectly regular). Returns null without enough nights.
 */
function sleepConsistency(sleepSeries, { days = 14, minN = 5 } = {}) {
  if (!sleepSeries) return null;
  const recent = sleepSeries.slice(-days).map((p) => Number(p.value)).filter(Number.isFinite);
  if (recent.length < minN) return null;
  const sd = stats.std(recent);
  if (sd == null) return null;
  // Map SD (hours) to a 0..100 score: 0h SD → 100, ~2h SD → ~0.
  const score = Math.round(Math.max(0, Math.min(100, 100 * (1 - sd / 2))));
  return { stdHours: Math.round(sd * 100) / 100, score, nights: recent.length };
}

// ---------------------------------------------------------------------------
// Training load — acute:chronic workload ratio (ACWR)
// ---------------------------------------------------------------------------

/**
 * Acute:chronic workload ratio — the standard overtraining/injury-risk signal.
 * Acute = mean daily load over the last 7 days; chronic = mean daily load over
 * the last 28. Ratio ~0.8–1.3 is the "sweet spot"; >1.5 is a spike (elevated
 * risk); <0.8 is detraining. Load = active_energy (kcal) or exercise_minutes.
 * Returns { acwr, acute, chronic, load, band, note } or null.
 */
function trainingLoad(seriesByKey, { acuteDays = 7, chronicDays = 28, minChronicDays = 21 } = {}) {
  const energy = seriesByKey['health:active_energy'];
  const minutes = seriesByKey['health:exercise_minutes'];
  const series = (energy && energy.length ? energy : minutes);
  const load = energy && energy.length ? 'active_energy' : 'exercise_minutes';
  // ACWR is acute load vs a CHRONIC baseline. With < ~3 weeks of data the
  // "chronic" mean is really just a short window, so a couple of harder days
  // would flag a bogus "load spiking / injury risk". Wait for a real baseline.
  if (!series || series.length < minChronicDays) return null;

  const acute = sumLast(series, acuteDays) / acuteDays;
  const chronic = sumLast(series, chronicDays) / Math.min(chronicDays, series.length);
  if (chronic <= 0) return null;
  const acwr = acute / chronic;

  let band, note;
  if (acwr > 1.5) { band = 'high'; note = 'Load is spiking well above your recent norm — elevated strain/injury risk. Consider an easier day.'; }
  else if (acwr < 0.8) { band = 'low'; note = 'Training load has dropped below your norm — fine for recovery, but fitness may erode if sustained.'; }
  else { band = 'optimal'; note = 'Training load is in the productive sweet spot relative to your recent norm.'; }

  return {
    acwr: Math.round(acwr * 100) / 100,
    acute: Math.round(acute),
    chronic: Math.round(chronic),
    load,
    band,
    note,
  };
}

// ---------------------------------------------------------------------------
// Findings: turn the constructs into dashboard findings
// ---------------------------------------------------------------------------

/** Build health-composite findings from the loaded series. Pure. */
function computeHealthComposites(seriesByKey, opts = {}) {
  const findings = [];
  const round1 = (n) => Math.round(n * 10) / 10;

  // Recovery score
  const rec = recoveryScore(seriesByKey, opts);
  if (rec) {
    const { band, guidance } = recoveryBand(rec.score);
    findings.push({
      type: 'recovery',
      domains: ['health'],
      title: `Recovery ${rec.score}/100 — ${band}`,
      detail: guidance,
      confidence: rec.inputs >= 3 ? 0.9 : 0.7,
      evidence: { auto: true, kind: 'recovery', score: rec.score, band, parts: rec.parts },
    });
  }

  // Sleep debt
  const sleep = seriesByKey['health:sleep_hours'];
  const debt = sleepDebt(sleep, opts);
  if (debt && debt.debtHours >= 1) {
    findings.push({
      type: 'sleep_debt',
      domains: ['health'],
      title: `Sleep debt: ${debt.debtHours}h over ${debt.nights} nights`,
      detail: `You're averaging ${debt.avgHours}h vs an ${debt.need}h need — about ${debt.debtHours}h of accumulated debt this week. A couple of earlier nights would clear it.`,
      confidence: 0.8,
      evidence: { auto: true, kind: 'sleep_debt', debtHours: debt.debtHours, avgHours: debt.avgHours, nights: debt.nights },
    });
  }

  // Sleep consistency
  const cons = sleepConsistency(sleep, opts);
  if (cons && cons.score < 70) {
    findings.push({
      type: 'sleep_consistency',
      domains: ['health'],
      title: `Irregular sleep (${cons.score}/100 consistency)`,
      detail: `Your nightly sleep varies by ±${round1(cons.stdHours)}h. Steadier sleep timing improves recovery and HRV more than total hours alone.`,
      confidence: 0.75,
      evidence: { auto: true, kind: 'sleep_consistency', score: cons.score, stdHours: cons.stdHours },
    });
  }

  // Training load (ACWR)
  const load = trainingLoad(seriesByKey, opts);
  if (load && load.band !== 'optimal') {
    findings.push({
      type: 'training_load',
      domains: ['health'],
      title: `Training load ${load.band} (ACWR ${load.acwr})`,
      detail: load.note,
      confidence: 0.75,
      evidence: { auto: true, kind: 'training_load', acwr: load.acwr, acute: load.acute, chronic: load.chronic, band: load.band },
    });
  }

  return findings;
}

/**
 * Compute the live recovery score directly from the metrics spine — a handful
 * of fast aggregate queries, no LLM and no briefing build. Used by the
 * briefing AND by GET /api/recovery so the Health tab can refresh the card
 * in under a second. Returns { score, band, parts, detail } or null.
 */
async function liveRecovery() {
  const metricsStore = require('../store/metrics');
  const seriesByKey = {};
  const from60 = new Date(Date.now() - 60 * 864e5);
  // HRV and RHR are the autonomic recovery signals the user enters manually each
  // morning from Eight Sleep (overnight). Source-lock them to eight_sleep (+ the
  // seeded eight_sleep_baseline) so the night-vs-night baseline is consistent —
  // daytime Apple Watch readings run higher and would make a normal overnight
  // value look like a dip. Sleep can use any source (eight_sleep preferred).
  const NIGHT_SOURCES = ['eight_sleep', 'eight_sleep_baseline'];
  const SOURCE_LOCK = {
    'health:hrv': NIGHT_SOURCES,
    'health:resting_hr': NIGHT_SOURCES,
  };
  for (const key of ['health:hrv', 'health:resting_hr', 'health:sleep_hours', 'health:sleep_score']) {
    const [dm, mt] = key.split(':');
    const rows = await metricsStore.dailyAggregatePreferSource({
      domain: dm, metric: mt, from: from60, agg: 'avg', sources: SOURCE_LOCK[key] ?? null,
    });
    if (rows.length) seriesByKey[key] = rows;
  }
  const rawHrv = seriesByKey['health:hrv'] ? latest(seriesByKey['health:hrv']) : null;
  const rawRhr = seriesByKey['health:resting_hr'] ? latest(seriesByKey['health:resting_hr']) : null;

  const rec = recoveryScore(seriesByKey);
  if (!rec) return null;
  const { band, guidance } = recoveryBand(rec.score);

  // If the user trained meaningfully in the last 2 days, note that suppressed
  // recovery is expected — avoids alarming a healthy athlete. Counts both logged
  // strength sets and logged alternate activities (Zone 2 walks, runs, etc.).
  let workoutNote = '';
  try {
    const db = require('../db');
    const today = new Date().toDateString();
    const dayLabelOf = (d) => new Date(d).toDateString() === today ? 'today' : 'yesterday';

    const { rows: setRows } = await db.query(
      `SELECT log_date, COUNT(*) AS sets
       FROM workout_logs
       WHERE log_date >= CURRENT_DATE - 1
       GROUP BY log_date ORDER BY log_date DESC`
    );
    const totalSets = setRows.reduce((s, r) => s + Number(r.sets), 0);

    let activityNote = '';
    try {
      const { rows: actRows } = await db.query(
        `SELECT activity_type, duration_min, log_date FROM activity_logs
         WHERE log_date >= CURRENT_DATE - 1
         ORDER BY log_date DESC, id`
      );
      if (actRows.length) {
        const parts = actRows.slice(0, 3).map((a) => {
          const dur = a.duration_min ? `${a.duration_min}min ` : '';
          return `${dur}${a.activity_type} ${dayLabelOf(a.log_date)}`;
        });
        activityNote = ` Logged ${parts.join(', ')}.`;
      }
    } catch { /* activity_logs may not exist yet — non-critical */ }

    if (totalSets >= 6) {
      workoutNote = ` Training load: ${totalSets} sets ${dayLabelOf(setRows[0].log_date)} — some suppression is expected.${activityNote}`;
    } else if (activityNote) {
      workoutNote = `${activityNote} Some suppression after training is expected.`;
    }
  } catch { /* non-critical */ }

  return { score: rec.score, band, parts: rec.parts, detail: guidance + workoutNote, rawHrv, rawRhr };
}

module.exports = {
  recoveryScore,
  recoveryBand,
  sleepDebt,
  sleepConsistency,
  trainingLoad,
  computeHealthComposites,
  baselineScore,
  trendScore,
  liveRecovery,
};
