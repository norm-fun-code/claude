// Derived health constructs — the composite scores that make Oura/Whoop feel
// "world-class": readiness/recovery, sleep debt, sleep consistency, and training
// load (acute:chronic). Everything here is PURE — it takes daily series and
// returns numbers/findings, so it's fully unit-testable. The orchestrator
// (analyze.js) feeds it the same per-metric series it already loads.
const stats = require('./stats');

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

/** Band + guidance for a recovery score, à la Whoop's red/yellow/green.
 *  Thresholds are kept IDENTICAL to predict.js predictCapacity's A/B/C grade
 *  (A ≥67 = green, B ≥50 = yellow, C <50 = red) so the Today-tab day grade and
 *  the Health-tab workout zone never disagree. Keep these in sync. */
function recoveryBand(score) {
  if (score >= 63) return { band: 'green',  guidance: "Green — your body's ready. Full intensity is appropriate today." };
  if (score >= 40) return { band: 'yellow', guidance: 'Moderate — solid foundation. Push if you feel good, but watch your exertion.' };
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
  // NB: deliberately avoids claiming a validated "injury-risk threshold" — the
  // acute:chronic sweet-spot model is a useful heuristic, but the specific 1.5
  // cutoff has been substantially critiqued. Frame it as a load spike to manage,
  // not a clinical risk score.
  if (acwr > 1.5) { band = 'high'; note = 'Load has jumped sharply above your recent norm. Big week-over-week spikes tend to outpace tissue adaptation, so favor an easier day or two before loading up again.'; }
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

/**
 * Multi-signal under-recovery (overreaching) synthesis — the gestalt a coach
 * actually watches, which no single card captures. Individual findings flag a low
 * recovery score, a load spike, or a sleep deficit in ISOLATION; the meaningful
 * pattern is when they stack. The strongest single marker is parasympathetic
 * withdrawal — HRV falling AND resting HR rising together — and when that sits on
 * top of a training-load spike and a sleep deficit, it's early non-functional
 * overreaching: the moment to deload before it turns into injury, illness, or
 * burnout. Fires only when ≥2 signals point the same way. Returns one finding or
 * null. `load` is the already-computed trainingLoad() result (may be null).
 */
function strainSynthesis(seriesByKey, { load = null } = {}) {
  const hrv = seriesByKey['health:hrv'];
  const rhr = seriesByKey['health:resting_hr'];
  const sleep = seriesByKey['health:sleep_hours'];
  const sleepNeed = seriesByKey['health:sleep_need'];

  const signals = [];

  // 1. HRV declining week-over-week — parasympathetic withdrawal.
  const hrvT = stats.trendStats(hrv || [], 7);
  if (hrvT && hrvT.pctChange != null && hrvT.pctChange <= -0.06) {
    signals.push({ key: 'hrv', text: `HRV down ${Math.round(Math.abs(hrvT.pctChange) * 100)}% vs last week`, w: Math.min(1, Math.abs(hrvT.pctChange) / 0.2) });
  }
  // 2. Resting HR rising week-over-week — sympathetic dominance / strain / illness.
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

  // HRV down + RHR up together is the strongest single indicator — call it out.
  const autonomicPair = signals.some((s) => s.key === 'hrv') && signals.some((s) => s.key === 'rhr');
  const severity = Math.min(1, (signals.length / 4) * 0.6 + (autonomicPair ? 0.3 : 0) + Math.max(...signals.map((s) => s.w)) * 0.1);
  const lead = autonomicPair
    ? 'HRV is falling while resting HR climbs — the classic parasympathetic-withdrawal signature of accumulating fatigue.'
    : 'Several recovery signals are trending the wrong way at once.';

  return {
    type: 'strain',
    domains: ['health'],
    title: `Under-recovery building — ${signals.length} signals trending down`,
    detail: `${lead} Right now: ${signals.map((s) => s.text).join(', ')}. This is what early overreaching looks like. Take 1–2 deliberately easy days (Zone 2 or mobility, not intensity), protect sleep, and let HRV climb back to baseline before loading up again.`,
    confidence: Math.min(0.9, 0.55 + 0.1 * signals.length),
    evidence: {
      auto: true, kind: 'strain', signals: signals.map((s) => s.key),
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
  const moving = per90 != null && Math.abs(per90) >= 0.5;
  const dir = moving ? (per90 > 0 ? 'rising' : 'declining') : 'steady';
  const trajTitle = moving ? ` — ${dir} ~${Math.abs(round1(per90))} pts/quarter` : '';
  const trajDetail = moving
    ? `and ${dir} (~${Math.abs(round1(per90))} pts/quarter)`
    : 'and holding steady';

  return {
    type: 'fitness',
    domains: ['health'],
    title: `VO₂ max ${round1(current)}${trajTitle}`,
    detail: `VO₂ max — your cardiorespiratory fitness — is among the strongest predictors of long-term health and lifespan. Yours is ${round1(current)} ${trajDetail}. What moves it: a base of Zone 2 (conversational-pace) cardio for volume, plus one weekly dose of harder intervals to lift the ceiling.`,
    confidence: 0.8,
    evidence: { auto: true, kind: 'fitness', metric: 'health:vo2_max', current: round1(current), per90: per90 == null ? null : round1(per90), n: vo2.length },
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

  // Recovery score
  const rec = recoveryScore(seriesByKey, opts);
  if (rec) {
    const { band, guidance } = recoveryBand(rec.score);
    let detail = guidance;
    if (band === 'green' && load && load.band === 'high') {
      detail += ` One caveat: your training load is spiking (ACWR ${load.acwr}) — keep today controlled rather than all-out, so recovery keeps pace with the load.`;
    }
    findings.push({
      type: 'recovery',
      domains: ['health'],
      title: `Recovery ${rec.score}/100 — ${band}`,
      detail,
      confidence: rec.inputs >= 3 ? 0.9 : 0.7,
      evidence: { auto: true, kind: 'recovery', score: rec.score, band, parts: rec.parts, acwr: load ? load.acwr : null },
    });
  }

  // Sleep balance — computed as the 7-day net of (sleep_hours - sleep_need).
  // Positive = surplus, negative = debt. We use this instead of Eight Sleep's
  // sleep_debt API field (dailySleepDebtSeconds) because that field only counts
  // cumulative deficit and never goes negative, so a surplus week still shows as
  // debt. This approach matches what Eight Sleep's own "Sleep balance" screen shows.
  const sleep = seriesByKey['health:sleep_hours'];
  const sleepNeedSeries = seriesByKey['health:sleep_need'];
  const eightSleepNeed = latest(sleepNeedSeries);
  const lastNight = sleep ? latest(sleep) : null;
  const MIN = 0.08; // ~5 min threshold

  // Build 7-day net balance from paired daily values.
  let balance7 = null;
  if (sleep && sleep.length) {
    const needMap = new Map();
    if (sleepNeedSeries) {
      for (const row of sleepNeedSeries) {
        const d = new Date(row.day).toISOString().slice(0, 10);
        needMap.set(d, Number(row.value));
      }
    }
    const recent7 = sleep.slice(-7);
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
    if (nights >= 3) balance7 = { net: Math.round(net * 100) / 100, nights };
  }

  if (balance7 != null) {
    const { net, nights } = balance7;
    const nightCtx = lastNight != null && eightSleepNeed != null
      ? ` Last night: ${fmtHM(lastNight)} vs your ${fmtHM(eightSleepNeed)} need.`
      : '';
    if (net <= -MIN) {
      const debtFmt = fmtHM(-net);
      findings.push({
        type: 'sleep_debt',
        domains: ['health'],
        title: `Sleep debt: ${debtFmt}`,
        detail: `Seven-day net sleep is ${debtFmt} below your need.${nightCtx}`,
        confidence: 0.9,
        evidence: { auto: true, kind: 'sleep_debt', debtHours: -net, lastNight, need: eightSleepNeed, source: 'seven_day_balance' },
      });
    } else if (net >= MIN) {
      const surplusFmt = fmtHM(net);
      findings.push({
        type: 'sleep_debt',
        domains: ['health'],
        title: `Sleep surplus: ${surplusFmt}`,
        detail: `Seven-day net sleep is ${surplusFmt} above your need — well rested this week.${nightCtx}`,
        confidence: 0.9,
        evidence: { auto: true, kind: 'sleep_surplus', surplusHours: net, lastNight, need: eightSleepNeed, source: 'seven_day_balance' },
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
 * blend it (quality-weighted) with duration adequacy vs the user's need. Pure;
 * returns { score, parts } on the same 0–100 scale as recoveryBand, or null on
 * bad input.
 */
function selfReportRecovery({ quality, hours, need = 7.5 } = {}) {
  const q = Number(quality);
  if (!Number.isFinite(q) || q < 1 || q > 5) return null;
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
  return { score, parts: { quality: Math.round(qScore), duration: Math.round(dScore) } };
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
  return {
    score: proxy.score, band, parts: proxy.parts,
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
  strainSynthesis,
  fitnessFinding,
  baselineScore,
  trendScore,
  liveRecovery,
  selfReportRecovery,
  needsSleepCheckIn,
};
