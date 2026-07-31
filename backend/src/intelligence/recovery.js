// Derived health constructs — the composite scores that make Oura/Whoop feel
// "world-class": readiness/recovery, sleep debt, sleep consistency, and training
// load (acute:chronic). Everything here is PURE — it takes daily series and
// returns numbers/findings, so it's fully unit-testable. The orchestrator
// (analyze.js) feeds it the same per-metric series it already loads.
const stats = require('./stats');
const { canonicalBand } = require('./recoveryThresholds');
const { recoveryPresentation, deriveRiskFlags } = require('./recoveryPresentation');

// HRV and resting HR are autonomic recovery signals read overnight from
// Eight Sleep — source-locked here (and everywhere else that reads them for
// a recovery-comparable purpose) to NIGHT_SOURCES so a daytime Apple Watch
// reading (structurally higher/lower — see recovery.js's own doc comments)
// never silently blends into a night-vs-night baseline or gets returned as
// if it were the overnight figure. Exported so every non-recovery consumer
// of these two metrics for a "recovery-equivalent" read (chat/ask.js,
// chat/realtimeTools.js) shares this SAME lock instead of re-deriving it
// (truth-and-evidence contract, audit priority #1 — source-distinct HRV).
const NIGHT_SOURCES = ['eight_sleep', 'eight_sleep_baseline'];
const RECOVERY_SOURCE_LOCK = {
  'health:hrv': NIGHT_SOURCES,
  'health:resting_hr': NIGHT_SOURCES,
};

/** Format decimal hours as "Xh Ym" — mirrors mobile's formatHM utility. */
function fmtHM(hours) {
  if (hours == null || !Number.isFinite(hours)) return '—';
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

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
 *   rank 100 → 100  (full marks on a genuinely exceptional day)
 */
function softScore(rank) {
  if (rank <= 20) return Math.round(10 + rank * 0.9);          // 0→10, 20→28
  if (rank >= 80) return Math.round(72 + (rank - 80) * 1.4);   // 80→72, 100→100
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

/** Canonical band + guidance for a recovery score, à la Whoop's red/yellow/
 *  green. The band thresholds are NOT owned here — they're the single
 *  authoritative constants in recoveryThresholds.js (GREEN_MIN=63,
 *  YELLOW_MIN=40), imported below so predict.js's predictCapacity A/B/C
 *  grade and every other consumer can never drift out of sync with this
 *  function again. This return value (band + guidance) is the CANONICAL
 *  three-band contract — it drives training logic, forecasting, validation,
 *  and historical data, and must never be redefined based on presentation
 *  concerns. For the finer user-facing presentation tier (e.g. a near-green
 *  59 reading as reassuring rather than alarming), see
 *  recoveryPresentation.js's recoveryPresentation() — additive, built on top
 *  of this function's own band, never a replacement for it. */
function recoveryBand(score) {
  const band = canonicalBand(score);
  if (band === 'green') return { band, guidance: "Green — your body's ready. Full intensity is appropriate today." };
  if (band === 'yellow') return { band, guidance: 'Moderate — solid foundation. Push if you feel good, but watch your exertion.' };
  return { band: 'red', guidance: 'Low — under-recovered. Keep it easy today: mobility or a walk, and protect tonight\'s sleep.' };
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
/**
 * 7-day net sleep balance: Σ(actual hours − need) over the last 7 nights that
 * have both values. Positive = surplus, negative = debt. Matches Eight Sleep's
 * own "Sleep balance" screen — deliberately NOT their sleep_debt API field
 * (dailySleepDebtSeconds), which only counts cumulative deficit and never goes
 * negative, so a surplus week still reads as debt. This is the single source of
 * truth for sleep debt/surplus in the app; anywhere debt is shown should call
 * this rather than reading the raw Eight Sleep field directly.
 */
function sleepBalance7(sleepSeries, sleepNeedSeries) {
  if (!sleepSeries || !sleepSeries.length) return null;
  const needMap = new Map();
  if (sleepNeedSeries) {
    for (const row of sleepNeedSeries) {
      const d = new Date(row.day).toISOString().slice(0, 10);
      needMap.set(d, Number(row.value));
    }
  }
  const eightSleepNeed = latest(sleepNeedSeries);
  const recent7 = sleepSeries.slice(-7);
  let net = 0, nights = 0;
  for (const row of recent7) {
    const h = Number(row.value);
    if (!Number.isFinite(h)) continue;
    const d = new Date(row.day).toISOString().slice(0, 10);
    const need = needMap.get(d) ?? eightSleepNeed;
    if (need == null) continue;
    net += h - need;
    nights++;
  }
  return nights >= 3 ? { net: Math.round(net * 100) / 100, nights, need: eightSleepNeed } : null;
}

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

/**
 * Sleep Regularity Index — how steady your sleep TIMING is, not just duration.
 * Onset time is derived as (wake_time − sleep_hours); we score the day-to-day
 * variability of onset and wake clock times (the two things you actually control).
 * Lower variability → higher regularity. Returns { score(0..100), onsetStdMin,
 * wakeStdMin, nights } or null. Timing regularity predicts HRV and deep sleep
 * beyond total hours, which is why it's separate from duration consistency.
 */
function sleepRegularity(sleepSeries, wakeSeries, { days = 14, minN = 5 } = {}) {
  if (!sleepSeries || !wakeSeries) return null;
  const dayKey = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  const sleepByDay = new Map(sleepSeries.map((p) => [dayKey(p.day), Number(p.value)]));
  const pairs = [];
  for (const p of wakeSeries) {
    const wake = Number(p.value);
    const sleep = sleepByDay.get(dayKey(p.day));
    if (Number.isFinite(wake) && Number.isFinite(sleep)) pairs.push({ onset: wake - sleep, wake });
  }
  const recent = pairs.slice(-days);
  if (recent.length < minN) return null;
  const onsetSd = stats.std(recent.map((p) => p.onset));
  const wakeSd = stats.std(recent.map((p) => p.wake));
  if (onsetSd == null || wakeSd == null) return null;
  const timingSd = (onsetSd + wakeSd) / 2; // hours
  const score = Math.round(Math.max(0, Math.min(100, 100 * (1 - timingSd / 2))));
  return { score, onsetStdMin: Math.round(onsetSd * 60), wakeStdMin: Math.round(wakeSd * 60), nights: recent.length };
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
  // NB: deliberately avoids claiming a validated "injury-risk threshold" — the
  // acute:chronic sweet-spot model is a useful heuristic, but the specific 1.5
  // cutoff has been substantially critiqued. Frame it as a load spike to manage,
  // not a clinical risk score.
  if (acwr > 1.5) { band = 'high'; note = 'Load has jumped sharply above your recent norm. That can be harder to absorb than a steady build; consider an easier day or two if your recovery or how you feel also points that way.'; }
  else if (acwr < 0.8) { band = 'low'; note = 'Training load is below your recent norm. That may be intentional recovery or lower activity; no change is needed if it is planned.'; }
  else { band = 'optimal'; note = 'Training load is close to your recent range.'; }

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

/**
 * Multi-signal recovery-change synthesis. Individual findings flag a low recovery
 * score, a load spike, or a sleep deficit in isolation; this one says when two or
 * more inputs changed together. It intentionally does not diagnose overreaching,
 * illness, or a mechanism: these are observational trends, not a clinical test.
 * Fires only when ≥2 signals point the same way. Returns one finding or null.
 * `load` is the already-computed trainingLoad() result (may be null).
 */
function strainSynthesis(seriesByKey, { load = null } = {}) {
  const hrv = seriesByKey['health:hrv'];
  const rhr = seriesByKey['health:resting_hr'];
  const sleep = seriesByKey['health:sleep_hours'];
  const sleepNeed = seriesByKey['health:sleep_need'];

  const signals = [];

  // 1. HRV declining week-over-week.
  const hrvT = stats.trendStats(hrv || [], 7);
  if (hrvT && hrvT.pctChange != null && hrvT.pctChange <= -0.06) {
    signals.push({ key: 'hrv', text: `HRV down ${Math.round(Math.abs(hrvT.pctChange) * 100)}% vs last week`, w: Math.min(1, Math.abs(hrvT.pctChange) / 0.2) });
  }
  // 2. Resting HR rising week-over-week.
  const rhrT = stats.trendStats(rhr || [], 7);
  if (rhrT && rhrT.pctChange != null && rhrT.pctChange >= 0.04) {
    signals.push({ key: 'rhr', text: `resting HR up ${Math.round(rhrT.pctChange * 100)}% vs last week`, w: Math.min(1, rhrT.pctChange / 0.12) });
  }
  // 3. Training-load spike (ACWR high).
  if (load && load.band === 'high') {
    signals.push({ key: 'load', text: `training load spiking (ACWR ${load.acwr})`, w: Math.min(1, (load.acwr - 1.5) + 0.5) });
  }
  // 4. Accumulated sleep debt over the week.
  const need = latest(sleepNeed) ?? 8;
  let debtH = null;
  if (sleep && sleep.length) {
    const recent = sleep.slice(-7).map((p) => Number(p.value)).filter(Number.isFinite);
    if (recent.length >= 4) {
      const net = recent.reduce((a, h) => a + (h - need), 0);
      if (net <= -3) { debtH = -net; signals.push({ key: 'sleep', text: `${fmtHM(-net)} sleep debt this week`, w: Math.min(1, -net / 8) }); }
    }
  }

  if (signals.length < 2) return null;

  // HRV down + RHR up gives a more coherent recovery-change observation than
  // either metric alone, but it still does not identify a cause.
  const autonomicPair = signals.some((s) => s.key === 'hrv') && signals.some((s) => s.key === 'rhr');
  const severity = Math.min(1, (signals.length / 4) * 0.6 + (autonomicPair ? 0.3 : 0) + Math.max(...signals.map((s) => s.w)) * 0.1);
  const lead = autonomicPair
    ? 'HRV is trending down while resting HR is trending up. Together, that is a change from your recent baseline — not a diagnosis.'
    : 'Several recovery inputs have moved in a less favorable direction. This is a change from your recent baseline — not a diagnosis.';

  return {
    type: 'strain',
    domains: ['health'],
    title: `Recovery signals worth watching — ${signals.length} changes`,
    detail: `${lead} Right now: ${signals.map((s) => s.text).join(', ')}. Keep today’s plan flexible; if you feel off, choosing easier work and protecting sleep is reasonable.`,
    confidence: Math.min(0.75, 0.45 + 0.08 * signals.length),
    evidence: {
      auto: true, kind: 'strain', signals: signals.map((s) => s.key),
      evidenceTier: 'direct_observation',
      uncertainty: 'The combined trend does not identify a cause or diagnose overreaching.',
      severity: Math.round(severity * 100) / 100,
      hrvPct: hrvT?.pctChange != null ? Math.round(hrvT.pctChange * 1000) / 1000 : null,
      rhrPct: rhrT?.pctChange != null ? Math.round(rhrT.pctChange * 1000) / 1000 : null,
      acwr: load?.band === 'high' ? load.acwr : null,
      sleepDebtH: debtH != null ? Math.round(debtH * 10) / 10 : null,
    },
  };
}

/**
 * VO₂ max — cardiorespiratory fitness is the single strongest MODIFIABLE predictor
 * of all-cause mortality and healthspan (Mandsager, JAMA 2018), yet it's easy to
 * ignore because it barely moves day to day. Feature it as a longevity metric:
 * current estimate + multi-week trajectory + the lever that moves it. Returns one
 * 'fitness' finding or null.
 */
/** Pure: render the fitness finding's title/detail from a current VO₂ value +
 *  its quarterly trend. Shared by fitnessFinding() (the nightly analyze() path)
 *  and briefing.js's live-freshen step (see the product review's "same metric,
 *  two numbers on the same tab" finding — this is what keeps them in sync
 *  without duplicating the prose template in two places). */
function formatFitnessFinding(current, per90) {
  const round1 = (n) => Math.round(n * 10) / 10;
  const c = round1(current);
  const moving = per90 != null && Math.abs(per90) >= 0.5;
  const dir = moving ? (per90 > 0 ? 'rising' : 'declining') : 'steady';
  const trajTitle = moving ? ` — ${dir} ~${Math.abs(round1(per90))} pts/quarter` : '';
  const trajDetail = moving
    ? `and ${dir} (~${Math.abs(round1(per90))} pts/quarter)`
    : 'and holding steady';
  return {
    title: `VO₂ max ${c}${trajTitle}`,
    detail: `VO₂ max — your cardiorespiratory fitness — is among the strongest predictors of long-term health and lifespan. Yours is ${c} ${trajDetail}. What moves it: a base of Zone 2 (conversational-pace) cardio for volume, plus one weekly dose of harder intervals to lift the ceiling.`,
  };
}

function fitnessFinding(seriesByKey) {
  const vo2 = seriesByKey['health:vo2_max'];
  if (!vo2 || vo2.length < 2) return null;
  const current = latest(vo2);
  if (current == null) return null;
  const round1 = (n) => Math.round(n * 10) / 10;
  // Apple's VO₂ max estimate moves slowly, so express the slope over a quarter
  // (per-day slope is noise). Only call a direction when the quarter-move clears
  // ~0.5 pts — below that it's holding steady.
  const fit = stats.fitByDay(vo2);
  const per90 = fit && fit.slope != null ? fit.slope * 90 : null;
  const { title, detail } = formatFitnessFinding(current, per90);

  const lastDay = vo2[vo2.length - 1]?.day;
  return {
    type: 'fitness',
    domains: ['health'],
    title,
    detail,
    confidence: 0.8,
    evidence: {
      auto: true, kind: 'fitness', metric: 'health:vo2_max',
      current: round1(current), per90: per90 == null ? null : round1(per90), n: vo2.length,
      // asOf lets every reader of this SAME fact (Health screen, Ask
      // context, briefing) agree on when "current" was actually measured,
      // not just what the number is (truth-and-evidence contract).
      asOf: lastDay ? new Date(lastDay).toISOString() : null,
    },
  };
}

/** Build health-composite findings from the loaded series. Pure. */
function computeHealthComposites(seriesByKey, opts = {}) {
  const findings = [];
  const round1 = (n) => Math.round(n * 10) / 10;

  // Training load is computed once here — used both for its own finding below AND
  // to temper the recovery headline. A green readiness score is a ceiling, not a
  // license: stacked on a spiking load it still warrants a controlled day, because
  // autonomic recovery (HRV) can read "ready" while muscle/connective tissue is
  // still catching up.
  const load = trainingLoad(seriesByKey, opts);
  const sleep = seriesByKey['health:sleep_hours'];

  // Recovery score. The caveat/caution language a recovery finding may carry
  // is generalized behind recoveryPresentation()'s riskFlags mechanism (this
  // was previously a single green+high-load special case inline here) — any
  // of the task's allowed independent canonical signals can add caution to
  // an otherwise-reassuring solid_near_green read, but a bare score never
  // does on its own.
  const rec = recoveryScore(seriesByKey, opts);
  if (rec) {
    const { band } = recoveryBand(rec.score);
    const debtCheck = sleepDebt(sleep, opts);
    const riskFlags = deriveRiskFlags({
      sleepDebtHours: debtCheck?.debtHours ?? null,
      loadBand: load?.band ?? null,
      hrvSubScore: rec.parts.hrv,
      restingHrSubScore: rec.parts.restingHr,
    });
    const presentation = recoveryPresentation(rec.score, { band, riskFlags });
    findings.push({
      type: 'recovery',
      domains: ['health'],
      title: `Recovery ${rec.score}/100 — ${presentation.label}`,
      detail: presentation.guidance,
      confidence: rec.inputs >= 3 ? 0.9 : 0.7,
      evidence: { auto: true, kind: 'recovery', score: rec.score, band, parts: rec.parts, acwr: load ? load.acwr : null, presentation },
    });
  }

  // Sleep balance — see sleepBalance7() for why this is used instead of Eight
  // Sleep's raw sleep_debt API field.
  const sleepNeedSeries = seriesByKey['health:sleep_need'];
  const eightSleepNeed = latest(sleepNeedSeries);
  const lastNight = sleep ? latest(sleep) : null;
  const MIN = 0.08; // ~5 min threshold
  const balance7 = sleepBalance7(sleep, sleepNeedSeries);

  // How many of the last 7 sleep-hours points came from a self-report
  // (approximate, ~8h) rather than a device measurement — see
  // opts.selfReportedSleepNights, threaded in by analyze.js. When any did,
  // the 7-day net can't honestly claim minute-level precision (truth-and-
  // evidence contract, audit priority #1: never manufacture minute-level
  // sleep debt from an approximate self-reported input) — round to the
  // nearest QUARTER HOUR instead of the nearest minute, and say so.
  const hasSelfReportNight = Number(opts.selfReportedSleepNights) > 0;
  const roundDebt = (h) => (hasSelfReportNight ? Math.round(h * 4) / 4 : h);
  const approxNote = hasSelfReportNight ? ' Includes a self-reported (approximate) night, so this is a rounded estimate.' : '';

  if (balance7 != null) {
    const { net, nights } = balance7;
    const nightCtx = lastNight != null && eightSleepNeed != null
      ? ` Last night: ${fmtHM(lastNight)} vs your ${fmtHM(eightSleepNeed)} need.`
      : '';
    if (net <= -MIN) {
      const debtFmt = fmtHM(roundDebt(-net));
      findings.push({
        type: 'sleep_debt',
        domains: ['health'],
        title: `Sleep debt: ${debtFmt}`,
        detail: `Seven-day net sleep is ${debtFmt} below your need.${nightCtx}${approxNote}`,
        confidence: hasSelfReportNight ? 0.6 : 0.9,
        evidence: { auto: true, kind: 'sleep_debt', debtHours: roundDebt(-net), lastNight, need: eightSleepNeed, source: 'seven_day_balance', approximate: hasSelfReportNight },
      });
    } else if (net >= MIN) {
      const surplusFmt = fmtHM(roundDebt(net));
      findings.push({
        type: 'sleep_debt',
        domains: ['health'],
        title: `Sleep surplus: ${surplusFmt}`,
        detail: `Seven-day net sleep is ${surplusFmt} above your need — well rested this week.${nightCtx}${approxNote}`,
        confidence: hasSelfReportNight ? 0.6 : 0.9,
        evidence: { auto: true, kind: 'sleep_surplus', surplusHours: roundDebt(net), lastNight, need: eightSleepNeed, source: 'seven_day_balance', approximate: hasSelfReportNight },
      });
    }
  } else if (lastNight != null && eightSleepNeed != null) {
    // Not enough nights for a weekly balance — fall back to single-night delta.
    const need = eightSleepNeed;
    const delta = lastNight - need;
    const nightFmt = fmtHM(lastNight);
    const needFmt = fmtHM(need);
    if (delta >= MIN) {
      const surplusFmt = fmtHM(delta);
      findings.push({
        type: 'sleep_debt',
        domains: ['health'],
        title: `Sleep surplus: ${surplusFmt}`,
        detail: `Last night you slept ${nightFmt} vs your ${needFmt} need — ${surplusFmt} above. Well rested.`,
        confidence: 0.85,
        evidence: { auto: true, kind: 'sleep_surplus', surplusHours: Math.round(delta * 100) / 100, lastNight, need, source: 'eight_sleep' },
      });
    } else if (delta <= -MIN) {
      const debtFmt = fmtHM(-delta);
      findings.push({
        type: 'sleep_debt',
        domains: ['health'],
        title: `Sleep debt: ${debtFmt}`,
        detail: `Last night you slept ${nightFmt} vs your ${needFmt} need — ${debtFmt} short.`,
        confidence: 0.85,
        evidence: { auto: true, kind: 'sleep_debt', debtHours: Math.round(-delta * 100) / 100, lastNight, need, source: 'eight_sleep' },
      });
    }
  } else {
    // No Eight Sleep data — fall back to generic 7-day cumulative model.
    const debt = sleepDebt(sleep, opts);
    if (debt && debt.debtHours >= 1) {
      findings.push({
        type: 'sleep_debt',
        domains: ['health'],
        title: `Sleep debt: ${debt.debtHours}h over ${debt.nights} nights`,
        detail: `Averaging ${fmtHM(debt.avgHours)} vs an ${debt.need}h need — about ${debt.debtHours}h accumulated this week.`,
        confidence: 0.8,
        evidence: { auto: true, kind: 'sleep_debt', debtHours: debt.debtHours, avgHours: debt.avgHours, nights: debt.nights },
      });
    }
  }

  // Sleep consistency
  const cons = sleepConsistency(sleep, opts);
  if (cons && cons.score < 70) {
    findings.push({
      type: 'sleep_consistency',
      domains: ['health'],
      title: `Irregular sleep (${cons.score}/100 consistency)`,
      detail: `Your nightly sleep duration swings by ±${round1(cons.stdHours)}h. Consistent sleep — a steady duration, and even more so a steady bed and wake time — supports recovery and HRV more than total hours alone.`,
      confidence: 0.75,
      evidence: { auto: true, kind: 'sleep_consistency', score: cons.score, stdHours: cons.stdHours },
    });
  }

  // Sleep regularity (timing) — the science-backed companion to duration consistency.
  const reg = sleepRegularity(sleep, seriesByKey['health:wake_time'], opts);
  if (reg && reg.score < 80) {
    findings.push({
      type: 'sleep_regularity',
      domains: ['health'],
      title: `Sleep regularity ${reg.score}/100`,
      detail: `Your sleep timing drifts by ±${reg.onsetStdMin}m at bedtime and ±${reg.wakeStdMin}m at wake over ${reg.nights} nights. A steady schedule — same bed and wake time daily — is one of the strongest controllable levers for HRV and deep sleep, independent of how many hours you get.`,
      confidence: 0.75,
      evidence: { auto: true, kind: 'sleep_regularity', score: reg.score, onsetStdMin: reg.onsetStdMin, wakeStdMin: reg.wakeStdMin, nights: reg.nights },
    });
  }

  // Training load (ACWR) — `load` computed above, reused here for its own finding.
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

  // Under-recovery synthesis — the multi-signal overreaching warning (uses `load`).
  const strain = strainSynthesis(seriesByKey, { load });
  if (strain) findings.push(strain);

  // VO₂ max — featured longevity / cardiorespiratory-fitness metric.
  const fitness = fitnessFinding(seriesByKey);
  if (fitness) findings.push(fitness);

  return findings;
}

/**
 * Subjective recovery proxy from a self-reported night — used on mornings with no
 * Eight Sleep reading. Sleep quality (1–5) is a validated readiness signal, so we
 * blend it (quality-weighted) with duration adequacy vs the user's need to get a
 * single coarse `score` on the same 0-100 scale recoveryBand() expects, purely so
 * this proxy can share the SAME green/yellow/red banding as a real device-derived
 * reading elsewhere in the codebase. Pure; returns null on bad input.
 *
 * Deliberately does NOT return `parts` (truth-and-evidence contract, audit
 * priority #1 — precision rules): a real device-derived recovery reading's
 * `parts` are genuine percentiles vs a 30-day baseline (see
 * formatRecoveryComposite/computeHealthComposites), and RecoveryCard.tsx
 * renders them captioned "percentile vs your 30-day baseline". qScore/dScore
 * here are NOT that — they're just this one estimate's internal weighting —
 * so exposing them as `parts.quality`/`parts.duration` produced the exact
 * false-precision bug this fixes: a bare "4/5, ~8h" self-report rendering as
 * "Recovery 80, Quality 75, Duration 88" — three confident-looking numbers
 * from one coarse rating. `category` is the honest, categorical summary the
 * task's own wording asks for ("Good · provisional"), derived directly from
 * the self-report, not manufactured.
 */
function selfReportRecovery({ quality, hours, need = 7.5 } = {}) {
  const q = Number(quality);
  if (!Number.isFinite(q) || q < 1 || q > 5) return null;
  const category = q >= 4 ? 'Good' : q >= 3 ? 'Fair' : 'Poor';
  // Quality 1..5 → soft 0..100 (never a literal 0/100). Interpolate non-integers.
  const QMAP = { 1: 20, 2: 38, 3: 55, 4: 75, 5: 92 };
  const lo = Math.max(1, Math.floor(q));
  const hi = Math.min(5, Math.ceil(q));
  const qScore = lo === hi ? QMAP[lo] : QMAP[lo] + (QMAP[hi] - QMAP[lo]) * (q - lo);
  // Duration adequacy vs need: at/above need ~88, docking ~12/hr short, small
  // bonus for extra, clamped so neither dimension can peg the score.
  const nd = Number.isFinite(need) && need > 0 ? need : 7.5;
  const h = Number(hours);
  let dScore = 88;
  if (Number.isFinite(h) && h > 0) {
    dScore = 88 - Math.max(0, nd - h) * 12 + Math.max(0, h - nd) * 3;
    dScore = Math.max(10, Math.min(95, dScore));
  }
  const score = Math.max(5, Math.min(98, Math.round(0.6 * qScore + 0.4 * dScore)));
  return { score, category };
}

/** Load today's self-reported sleep and build a proxy recovery, or null. */
async function liveSelfReport(metricsStore, from60, todayLocal) {
  const q = await metricsStore.dailyAggregatePreferSource({
    domain: 'health', metric: 'sleep_quality', from: from60, agg: 'avg', sources: ['self_report'],
  });
  if (!q.length) return null;
  const qDayKey = new Date(q[q.length - 1].day).toISOString().slice(0, 10);
  if (qDayKey < todayLocal) return null; // self-report isn't from today
  const quality = Number(q[q.length - 1].value);

  const hRows = await metricsStore.dailyAggregatePreferSource({
    domain: 'health', metric: 'sleep_hours', from: from60, agg: 'avg', sources: ['self_report'],
  });
  const hours = hRows.length ? Number(hRows[hRows.length - 1].value) : null;

  // Personalize the duration target from the Eight Sleep baseline need if present.
  let need = 7.5;
  try {
    const needRows = await metricsStore.dailyAggregatePreferSource({
      domain: 'health', metric: 'sleep_need', from: from60, agg: 'avg', sources: ['eight_sleep'],
    });
    if (needRows.length) need = Number(needRows[needRows.length - 1].value) || 7.5;
  } catch { /* fall back to 7.5 */ }

  const proxy = selfReportRecovery({ quality, hours, need });
  if (!proxy) return null;
  const { band } = recoveryBand(proxy.score);
  // Temper the guidance: this is a SUBJECTIVE proxy (no autonomic data), so even a
  // green score shouldn't greenlight maximal effort the way an objective read does.
  const proxyGuidance =
    band === 'green'
      ? 'Looks like a decent night — train roughly as planned, but this is self-reported, so let how you actually feel be the final call.'
      : band === 'yellow'
        ? 'A so-so night by your own rating — keep intensity sensible and don’t force a hard session.'
        : 'You rated it a rough night — keep today easy (mobility or a walk) and protect tonight’s sleep.';
  const hStr = Number.isFinite(hours) && hours > 0 ? `, ~${fmtHM(hours)}` : '';
  // Presentation tier/label/color for cross-surface agreement (Health card,
  // Today, brief, Ask, voice) — the proxy's OWN hedged detail text above
  // stays authoritative for this reading (it already reflects the data being
  // self-reported rather than device-measured), this is additive.
  const presentation = recoveryPresentation(proxy.score, { band });
  return {
    // parts intentionally omitted — see selfReportRecovery's doc comment;
    // `category` (+ `proxy: true`) is the honest categorical summary a
    // consumer should render ("Good · provisional"), never split into
    // manufactured "quality"/"duration" percentile-looking sub-scores.
    score: proxy.score, band, category: proxy.category, presentation,
    detail: `${proxyGuidance} Based on your self-reported sleep (${Math.round(quality)}/5${hStr}) — no Eight Sleep reading last night.`,
    source: 'self_report', proxy: true, rawHrv: null, rawRhr: null,
    quality: Math.round(quality), hours: Number.isFinite(hours) ? hours : null,
  };
}

/**
 * Does the user need a sleep check-in prompt right now? True when they normally
 * use Eight Sleep (have HRV history) but there's no Pod reading for today AND no
 * self-report logged today. Lets the mobile card show exactly when there's a gap.
 */
async function needsSleepCheckIn() {
  const metricsStore = require('../store/metrics');
  const from = new Date(Date.now() - 7 * 864e5);
  const tz = process.env.TZ || 'America/New_York';
  const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const hrv = await metricsStore.dailyAggregatePreferSource({
    domain: 'health', metric: 'hrv', from, agg: 'avg', sources: ['eight_sleep', 'eight_sleep_baseline'],
  });
  if (!hrv.length) return false; // not an Eight Sleep user — don't prompt
  const lastHrv = new Date(hrv[hrv.length - 1].day).toISOString().slice(0, 10);
  if (lastHrv >= todayLocal) return false; // fresh Pod reading today
  const sr = await metricsStore.dailyAggregatePreferSource({
    domain: 'health', metric: 'sleep_quality', from, agg: 'avg', sources: ['self_report'],
  });
  if (sr.length && new Date(sr[sr.length - 1].day).toISOString().slice(0, 10) >= todayLocal) return false;
  return true; // no Pod reading + no self-report today → prompt
}

/**
 * Compute the live recovery score directly from the metrics spine — a handful
 * of fast aggregate queries, no LLM and no briefing build. Used by the
 * briefing AND by GET /api/recovery so the Health tab can refresh the card
 * in under a second. Returns { score, band, parts, detail } or null.
 */
async function liveRecoveryUncached() {
  const metricsStore = require('../store/metrics');
  const from60 = new Date(Date.now() - 60 * 864e5);
  // HRV and RHR are the autonomic recovery signals the user enters manually each
  // morning from Eight Sleep (overnight). Sleep can use any source (eight_sleep
  // preferred). See module-level RECOVERY_SOURCE_LOCK for why HRV/RHR are locked.
  const KEYS = ['health:hrv', 'health:resting_hr', 'health:sleep_hours', 'health:sleep_score'];
  // Each key's fetch is independent — parallelize instead of one round trip at
  // a time (this function is called from several unrelated request paths, so
  // the round trips added up across a session even though there are only 4).
  const results = await Promise.all(KEYS.map(async (key) => {
    const [dm, mt] = key.split(':');
    const rows = await metricsStore.dailyAggregatePreferSource({
      domain: dm, metric: mt, from: from60, agg: 'avg', sources: RECOVERY_SOURCE_LOCK[key] ?? null,
    });
    return [key, rows];
  }));
  const seriesByKey = {};
  for (const [key, rows] of results) {
    if (rows.length) seriesByKey[key] = rows;
  }

  // Staleness guard: Eight Sleep dates each reading by the WAKE morning, so a
  // session for LAST NIGHT carries today's date. If the most recent reading
  // predates today, there was no Pod session last night (slept elsewhere, device
  // unplugged, vacation) — fall back to a self-reported sleep check-in if the user
  // logged one for today, otherwise return null (the caller then prompts the
  // check-in). The old 2-day window let a 2-nights-ago reading through.
  const tz = process.env.TZ || 'America/New_York';
  const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const hrvSeries = seriesByKey['health:hrv'];
  const hrvFresh =
    hrvSeries && hrvSeries.length &&
    new Date(hrvSeries[hrvSeries.length - 1].day).toISOString().slice(0, 10) >= todayLocal;
  if (!hrvFresh) return await liveSelfReport(metricsStore, from60, todayLocal);

  const rawHrv = latest(hrvSeries);
  const rawRhr = seriesByKey['health:resting_hr'] ? latest(seriesByKey['health:resting_hr']) : null;

  const rec = recoveryScore(seriesByKey);
  if (!rec) return null;
  const { band } = recoveryBand(rec.score);
  // Risk flags on the LIVE path — previously this computed none at all, the
  // one gap in the "same subset everywhere" contract that mattered most:
  // this is the exact function the Health card, Ask (chat/ask.js's
  // recoveryContext), and realtime voice (get_current_recovery) all read
  // through, so a near-green score's one legitimate caution mechanism
  // (recoveryPresentation.js's riskFlags) never had a chance to fire for any
  // of those surfaces before now. load_spike is intentionally NOT computed
  // here — ACWR/training-load banding needs data this fast, live-only path
  // deliberately doesn't fetch (see this function's own doc comment); it IS
  // covered by computeHealthComposites (the nightly findings path) above.
  const debtCheck = sleepDebt(seriesByKey['health:sleep_hours']);
  const riskFlags = deriveRiskFlags({
    sleepDebtHours: debtCheck?.debtHours ?? null,
    hrvSubScore: rec.parts.hrv,
    restingHrSubScore: rec.parts.restingHr,
  });
  const presentation = recoveryPresentation(rec.score, { band, riskFlags });

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

  // `detail` now reads the CENTRALIZED presentation guidance (with the
  // riskFlags just computed above), not the plain 3-band recoveryBand()
  // text — this is the field Ask (chat/ask.js's recoveryContext) and voice
  // (chat/realtimeTools.js's getCurrentRecovery) actually surface, so a
  // near-green score now gets the same "no automatic need to scale back"
  // framing there that the Health card already showed via `presentation`.
  return { score: rec.score, band, parts: rec.parts, detail: presentation.guidance + workoutNote, rawHrv, rawRhr, presentation };
}

// liveRecovery() is called from several independent request paths in one
// briefing build (the chief-brief prompt context, the composites/insights
// section — already deduped against each other within a single build via the
// `if (!recovery)` guard in briefing.js) AND across separate requests entirely
// (every pull-to-refresh re-checks it on the cache-serve path; the scoped
// chief-brief-only rebuild has its own copy). None of those need
// millisecond-fresh data — recovery only changes when a new Eight Sleep
// reading lands, at most once per night. Cache the PROMISE (not just the
// resolved value) so truly concurrent callers share one in-flight
// computation too, same pattern as services/monarch-wealth.js.
const RECOVERY_CACHE_MS = Number(process.env.RECOVERY_CACHE_MS || 2 * 60 * 1000);
let _recoveryCache = null; // { at, promise }
async function liveRecovery() {
  const hit = _recoveryCache;
  if (hit && Date.now() - hit.at < RECOVERY_CACHE_MS) return hit.promise;
  const promise = liveRecoveryUncached().catch((err) => { _recoveryCache = null; throw err; });
  _recoveryCache = { at: Date.now(), promise };
  return promise;
}

// Callers that just wrote recovery-relevant metrics (a self-reported sleep
// check-in, a fresh Eight Sleep sync) and immediately re-call liveRecovery()
// expecting the new data reflected MUST invalidate first — otherwise a
// same-process request from moments earlier (e.g. the Health tab's initial
// load, which caches a "no data yet" null) silently serves that stale result
// straight through the write. Hit this exact way: POST /api/recovery/self-report
// wrote the check-in then re-read a stale cached null, so the recovery score
// never appeared to have been created at all.
function invalidateRecoveryCache() {
  _recoveryCache = null;
}

/** When the currently-cached liveRecovery() promise was COMPUTED (not when it
 *  was last read) — null if nothing is cached right now. Lets a caller (the
 *  BrainSnapshot's provenance, the cache-hit staleness check) tell a truly
 *  fresh compute from a value served out of the RECOVERY_CACHE_MS window,
 *  instead of treating "present" and "fresh" as the same thing. */
function recoveryComputedAt() {
  return _recoveryCache?.at ?? null;
}

/** The registry's declared TTL for the recovery field (ms) — recomputed here
 *  so recovery.js doesn't need to import brain/registry.js (which documents
 *  this value, not owns it) just to answer "is my cached copy past its TTL?" */
const RECOVERY_TTL_MS = RECOVERY_CACHE_MS;

// The metrics.js metric keys a write to which can move the recovery score —
// the exact set liveRecoveryUncached() reads. Exported so store/metrics.js
// can gate its post-write "did recovery change?" check to ONLY these writes,
// instead of running a recovery recompute after every metric of any kind.
const RECOVERY_INPUT_METRICS = Object.freeze(new Set(['hrv', 'resting_hr', 'sleep_hours', 'sleep_score']));
const RECOVERY_INPUT_DOMAIN = 'health';

/** Pure: did live recovery change enough since a previously-derived value that
 *  a dependent field (todayForecast, effective workout, recovery composite)
 *  is now inconsistent with it? A band change always matters; a small score
 *  wobble within the same band doesn't move the grade or the workout, so
 *  ignore it (avoids invalidating on every trivial sensor jitter). A
 *  present→absent or absent→present transition also counts. Used both by the
 *  ingestion path (decides whether a new metric write is worth a
 *  recovery_change bump) and the briefing cache-hit path (decides whether to
 *  recompute the recovery-dependent cached fields). */
function recoveryMateriallyChanged(prior, fresh) {
  const pScore = prior?.score ?? null, fScore = fresh?.score ?? null;
  const pBand = prior?.band ?? null, fBand = fresh?.band ?? null;
  if ((pScore == null) !== (fScore == null)) return true;
  if (pBand !== fBand) return true;
  if (pScore != null && fScore != null && Math.abs(pScore - fScore) >= 3) return true;
  // A proxy↔real transition changes how the forecast tempers the grade.
  if (Boolean(prior?.proxy) !== Boolean(fresh?.proxy)) return true;
  return false;
}

/**
 * Recovery score for each of the last `days` days — replays recoveryScore() over
 * the source-locked overnight series truncated to each day, so the trend uses the
 * exact same math as the live card. Returns [{ ts, value }] (oldest→newest),
 * matching /api/metrics/history so the client charts it the same way. Days
 * without an overnight HRV reading are skipped (recovery is a night signal).
 */
async function recoveryHistory({ days = 30 } = {}) {
  const metricsStore = require('../store/metrics');
  // Pull extra lead-in days so early points in the window still have a baseline.
  const from = new Date(Date.now() - (days + 40) * 864e5);
  const seriesByKey = {};
  for (const key of ['health:hrv', 'health:resting_hr', 'health:sleep_hours', 'health:sleep_score']) {
    const [dm, mt] = key.split(':');
    const rows = await metricsStore.dailyAggregatePreferSource({
      domain: dm, metric: mt, from, agg: 'avg', sources: RECOVERY_SOURCE_LOCK[key] ?? null,
    });
    if (rows.length) seriesByKey[key] = rows;
  }

  // Self-reported sleep (no-Pod nights) → the same proxy recovery the live orb
  // uses, so the trend INCLUDES those days and never contradicts the orb (a green
  // self-report day no longer shows a stale red Eight Sleep night as "latest").
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  const [srQ, srH] = await Promise.all([
    metricsStore.dailyAggregatePreferSource({ domain: 'health', metric: 'sleep_quality', from, agg: 'avg', sources: ['self_report'] }),
    metricsStore.dailyAggregatePreferSource({ domain: 'health', metric: 'sleep_hours', from, agg: 'avg', sources: ['self_report'] }),
  ]);
  const srHByDay = new Map(srH.map((r) => [dayKey(r.day), Number(r.value)]));
  const selfByDay = new Map(srQ.map((r) => [dayKey(r.day), { quality: Number(r.value), hours: srHByDay.get(dayKey(r.day)) }]));

  const hrv = seriesByKey['health:hrv'] || [];
  const hrvDays = new Set(hrv.map((r) => dayKey(r.day)));
  const cutoff = new Date(Date.now() - days * 864e5).getTime();
  const dayTs = (d) => new Date(`${d}T12:00:00Z`).getTime();

  // Union of objective overnight days and self-report days within the window.
  const allDays = new Set();
  for (const r of hrv) if (new Date(r.day).getTime() >= cutoff) allDays.add(dayKey(r.day));
  for (const d of selfByDay.keys()) if (dayTs(d) >= cutoff && !hrvDays.has(d)) allDays.add(d);

  const out = [];
  for (const d of [...allDays].sort()) {
    let score = null;
    if (hrvDays.has(d)) {
      const trunc = {};
      for (const k of Object.keys(seriesByKey)) {
        trunc[k] = seriesByKey[k].filter((x) => new Date(x.day).getTime() <= dayTs(d));
      }
      const rec = recoveryScore(trunc);
      if (rec) score = Math.round(rec.score);
    } else {
      const sr = selfByDay.get(d);
      const proxy = sr && selfReportRecovery({ quality: sr.quality, hours: sr.hours });
      if (proxy) score = proxy.score;
    }
    if (score != null) out.push({ ts: new Date(`${d}T12:00:00Z`).toISOString(), value: score, proxy: !hrvDays.has(d) });
  }
  return out;
}

module.exports = {
  recoveryScore,
  recoveryBand,
  recoveryPresentation,
  sleepDebt,
  sleepBalance7,
  sleepConsistency,
  trainingLoad,
  computeHealthComposites,
  strainSynthesis,
  fitnessFinding,
  formatFitnessFinding,
  baselineScore,
  trendScore,
  liveRecovery,
  invalidateRecoveryCache,
  recoveryComputedAt,
  recoveryMateriallyChanged,
  RECOVERY_TTL_MS,
  RECOVERY_INPUT_METRICS,
  RECOVERY_INPUT_DOMAIN,
  recoveryHistory,
  selfReportRecovery,
  needsSleepCheckIn,
  NIGHT_SOURCES,
  RECOVERY_SOURCE_LOCK,
};
