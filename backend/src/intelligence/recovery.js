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

/** Map a value to 0..100 by where it sits in the user's own recent baseline,
 *  using a z-score squashed through the normal CDF. `invert` for metrics where
 *  lower is better (e.g. resting HR). Returns null without enough history.
 *
 *  `minStd` floors the baseline std so a metric with naturally tiny day-to-day
 *  variance (RHR often varies by only ~2bpm) can't turn a small absolute
 *  deviation into an extreme percentile — without it, +4bpm could score 5/100.
 *  `zDamp` softens the CDF mapping so ±1 baseline-std lands near 25/75 instead
 *  of 16/84: this is a wellness gauge, not a hypothesis test. */
function baselineScore(series, { baselineDays = 30, minN = 8, invert = false, minStd = 0, zDamp = 1.5 } = {}) {
  const a = stats.baselineAnomaly(series, { baselineDays, minN });
  if (!a) return null;
  const std = Math.max(a.baselineStd, minStd);
  let z = (a.latest - a.baselineMean) / std;
  if (invert) z = -z;
  // Φ(z) maps the deviation to a percentile of the user's own distribution.
  return Math.round(stats.normalCdf(z / zDamp) * 100);
}

/** Sum the last `n` present values of a series. */
function sumLast(series, n) {
  return series.slice(-n).reduce((s, p) => s + (Number(p.value) || 0), 0);
}

// ---------------------------------------------------------------------------
// Readiness / Recovery
// ---------------------------------------------------------------------------

/**
 * A composite recovery score (0–100), normalized to the user's OWN baselines —
 * the headline "how recovered am I" number. Blends:
 *   HRV (higher better), resting HR (lower better), and last night's sleep.
 * Each input is scored as a percentile of the user's recent history, then
 * weighted. Returns { score, parts, missing } or null if nothing's available.
 *
 * Weights reflect the consensus that HRV is the strongest single recovery
 * signal, RHR second, sleep a meaningful modifier.
 */
function recoveryScore(seriesByKey, opts = {}) {
  const o = { baselineDays: 30, minN: 8, ...opts };
  const parts = {};
  const weights = {};

  const hrv = seriesByKey['health:hrv'];
  const rhr = seriesByKey['health:resting_hr'];
  const sleep = seriesByKey['health:sleep_hours'];
  const sleepScore = seriesByKey['health:sleep_score'];

  // Std floors per metric (in the metric's own units) keep naturally
  // low-variance baselines from blowing small deviations into extreme scores:
  // HRV day-to-day std is rarely meaningfully below ~10% of its mean, RHR
  // below ~3bpm, sleep below ~30min.
  if (hrv) {
    const mean = stats.mean(hrv.map((p) => Number(p.value)).filter(Number.isFinite)) || 0;
    const s = baselineScore(hrv, { ...o, minStd: Math.max(4, mean * 0.1) });
    if (s != null) { parts.hrv = s; weights.hrv = 0.5; }
  }
  if (rhr) {
    const s = baselineScore(rhr, { ...o, invert: true, minStd: 3 });
    if (s != null) { parts.restingHr = s; weights.restingHr = 0.3; }
  }
  // Prefer an explicit sleep score if present, else sleep hours.
  if (sleepScore && latest(sleepScore) != null) {
    parts.sleep = Math.round(Math.max(0, Math.min(100, latest(sleepScore))));
    weights.sleep = 0.2;
  } else if (sleep) {
    const s = baselineScore(sleep, { ...o, minStd: 0.5 });
    if (s != null) { parts.sleep = s; weights.sleep = 0.2; }
  }

  const keys = Object.keys(parts);
  if (!keys.length) return null;

  // Recovery is a baseline-relative construct. HRV/RHR only contribute once
  // there's a personal baseline (>=8 days, enforced in baselineScore). Don't
  // surface a "recovery score" built ONLY from a single night's sleep number —
  // that would be a confident headline with no baseline behind it. Require at
  // least one baseline-derived input (hrv or restingHr).
  const hasBaselineInput = parts.hrv != null || parts.restingHr != null;
  if (!hasBaselineInput) return null;

  // Re-normalize weights over whatever inputs we actually have.
  const wsum = keys.reduce((a, k) => a + weights[k], 0);
  const score = Math.round(keys.reduce((a, k) => a + parts[k] * (weights[k] / wsum), 0));

  return { score, parts, inputs: keys.length };
}

/** Band + guidance for a recovery score, à la Whoop's red/yellow/green. */
function recoveryBand(score) {
  if (score >= 67) return { band: 'green', guidance: 'Recovered — green light for a hard session.' };
  if (score >= 34) return { band: 'yellow', guidance: 'Moderate — train, but hold something back.' };
  return { band: 'red', guidance: 'Low recovery — prioritize rest, easy movement only.' };
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
  for (const key of ['health:hrv', 'health:resting_hr', 'health:sleep_hours', 'health:sleep_score']) {
    const [dm, mt] = key.split(':');
    const rows = await metricsStore.dailyAggregate({ domain: dm, metric: mt, from: from60, agg: 'avg', excludeSource: 'seed' });
    if (rows.length) seriesByKey[key] = rows;
  }
  const rec = recoveryScore(seriesByKey);
  if (!rec) return null;
  const { band, guidance } = recoveryBand(rec.score);

  // If the user logged a meaningful workout in the last 2 days, note that
  // suppressed recovery is expected — avoids alarming a healthy athlete.
  let workoutNote = '';
  try {
    const db = require('../db');
    const { rows } = await db.query(
      `SELECT log_date, COUNT(*) AS sets
       FROM workout_logs
       WHERE log_date >= CURRENT_DATE - 1
       GROUP BY log_date ORDER BY log_date DESC`
    );
    if (rows.length) {
      const totalSets = rows.reduce((s, r) => s + Number(r.sets), 0);
      const dayLabel = new Date(rows[0].log_date).toDateString() === new Date().toDateString()
        ? 'today' : 'yesterday';
      if (totalSets >= 6) {
        workoutNote = ` Training load: ${totalSets} sets logged ${dayLabel} — some suppression is expected.`;
      }
    }
  } catch { /* workout_logs table may not exist yet — non-critical */ }

  return { score: rec.score, band, parts: rec.parts, detail: guidance + workoutNote };
}

module.exports = {
  recoveryScore,
  recoveryBand,
  sleepDebt,
  sleepConsistency,
  trainingLoad,
  computeHealthComposites,
  baselineScore,
  liveRecovery,
};
