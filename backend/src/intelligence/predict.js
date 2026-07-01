// Daily prediction — the forward-looking companion to the (backward-looking)
// recovery score. Answers "what kind of day is this, and how should I spend it?"
//
// Calendar-free by design: this user doesn't live in a personal calendar, so we
// predict from the signals that actually move — overnight recovery, sleep debt,
// and recent training load — and turn them into a capacity call + a prescription,
// plus a forward sleep-debt trajectory you control entirely.
//
// The two builders are PURE (take signals, return strings) so they're fully
// unit-testable; computeTodayForecast() is the thin DB wrapper.

/** Format decimal hours as "Xh Ym" — mirrors the mobile + recovery formatter. */
function fmtHM(hours) {
  if (hours == null || !Number.isFinite(hours)) return '—';
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Predict today's GRADE from overnight recovery + sleep debt + training load.
 * Returns { grade, band, headline, detail, prescription } or null without a score.
 *
 * The grade is the tier to PLAY AT today — your body sets the ceiling, and the
 * point is to play to it, not against it:
 *   A day — fully recovered. Full send: crush goals, hard training, every habit.
 *   B day — average. Hit your essentials: most habits, a real (not max) workout.
 *   C day — under-recovered. The goal is NOT zero — it's anything that compounds
 *           above zero (a walk, one meditation, a single habit). Keep the streak
 *           alive at minimum dose, protect tonight, and tomorrow rebounds.
 *
 * The recovery score is already a baseline-relative composite of HRV/RHR/sleep,
 * so it IS today's physiological ceiling — we grade it, name the drivers, and
 * prescribe how to play the day, modulated by sleep debt and training load.
 *
 * @param {object} s
 * @param {number} s.recoveryScore   0–100 composite (required)
 * @param {number} [s.hrvSubScore]   recovery.parts.hrv, 0–100 vs personal baseline
 * @param {number} [s.sleepHours]    last night's hours
 * @param {number} [s.sleepDebtHours] accumulated debt (Eight Sleep personalized)
 * @param {string} [s.acwrBand]      'high' | 'optimal' | 'low' (training load)
 */
function predictCapacity(s = {}) {
  const { recoveryScore, hrvSubScore, sleepHours, sleepDebtHours, acwrBand } = s;
  if (recoveryScore == null || !Number.isFinite(recoveryScore)) return null;

  // These grade cutoffs are the single source of truth for the day's recovery
  // band. recovery.js recoveryBand() mirrors them so the Health-tab workout zone
  // matches this grade exactly — keep them in sync.
  let grade, band, headline;
  if (recoveryScore >= 63)      { grade = 'A'; band = 'green';  headline = 'Full send'; }
  else if (recoveryScore >= 40) { grade = 'B'; band = 'yellow'; headline = 'Hit your essentials'; }
  else                          { grade = 'C'; band = 'red';    headline = 'Keep the streak alive'; }

  // Name the real drivers behind the grade.
  const drivers = [];
  if (hrvSubScore != null) {
    if (hrvSubScore < 40) drivers.push('HRV is down for you');
    else if (hrvSubScore >= 65) drivers.push('HRV is strong');
  }
  if (sleepHours != null && sleepHours < 6.5) drivers.push(`only ${fmtHM(sleepHours)} last night`);
  if (sleepDebtHours != null && sleepDebtHours >= 1) drivers.push(`${fmtHM(sleepDebtHours)} sleep debt`);
  const driverClause = drivers.length ? `${drivers.join(', ')}. ` : '';

  // Prescription: how to play the day at this grade.
  const rx = [];
  if (grade === 'A') {
    rx.push('Go for the full stack — your hardest work, every habit, and a hard session if you planned one. Days like this are where you bank progress.');
    if (acwrBand === 'high') rx.push('One caution: your training load is already spiking, so keep the intensity smart.');
  } else if (grade === 'B') {
    rx.push('Hit your essentials: most habits, a real (not max-effort) workout, and your important work in the morning. Consistency beats heroics.');
    if (acwrBand === 'high') rx.push('Training load is elevated — favor Zone 2 over intensity today.');
  } else {
    rx.push('Don\'t aim for zero — aim for anything that compounds: a 10-minute walk, one meditation, a single habit checked. That\'s still a win.');
    rx.push('Protect tonight\'s sleep and tomorrow rebounds.');
  }
  if (sleepDebtHours != null && sleepDebtHours >= 1 && grade !== 'C') rx.push('Protect an earlier bedtime tonight.');

  return { grade, band, headline, detail: driverClause.trim(), prescription: rx.join(' ') };
}

const WEEKDAY = (d) => d.toLocaleDateString('en-US', { weekday: 'long' });

/**
 * Tomorrow's recovery lean — a projection, not a promise. Anchors on today's
 * recovery and applies pressure from the things that carry overnight: training
 * load (ACWR), accumulated sleep debt, and today's session fatigue. Deliberately
 * modest — the biggest lever (tonight's sleep) is still unwritten, so it always
 * names that as the controllable. Returns { band, projectedScore, detail, lever,
 * confidence } or null.
 */
function forecastTomorrow({ recoveryScore, acwrBand, sleepDebtHours, hardSessionToday = false } = {}) {
  if (recoveryScore == null || !Number.isFinite(recoveryScore)) return null;
  let proj = recoveryScore;
  const drags = [];
  if (acwrBand === 'high') { proj -= 8; drags.push('training load is spiking'); }
  if (hardSessionToday)    { proj -= 6; drags.push("today's hard session adds fatigue"); }
  if (sleepDebtHours != null && sleepDebtHours >= 2) { proj -= 6; drags.push(`${fmtHM(sleepDebtHours)} of sleep debt`); }
  const easy = (acwrBand === 'low' || acwrBand == null) && (sleepDebtHours == null || sleepDebtHours < 1) && !hardSessionToday;
  if (easy) proj += 4;

  proj = Math.max(0, Math.min(100, proj));
  const band = proj >= 63 ? 'green' : proj >= 40 ? 'yellow' : 'red';
  const leans = band === 'green' ? 'green' : band === 'yellow' ? 'moderate' : 'low';
  const dragStr = drags.length <= 1 ? drags.join('')
    : `${drags.slice(0, -1).join(', ')} and ${drags[drags.length - 1]}`;
  const detail = drags.length
    ? `Leaning ${leans} — ${dragStr} carry into tomorrow.`
    : `Leaning ${leans} — nothing today is dragging on tomorrow.`;
  const lever = band === 'green'
    ? 'Protect a normal bedtime tonight and it should hold.'
    : 'The swing factor is tonight: hit your sleep need and this likely rebounds a band.';
  // More confident at the extremes; a mid projection is genuinely a coin-flip.
  const confidence = Math.round((Math.abs(proj - 51) / 51) * 40 + 45); // 45–85
  return { band, projectedScore: Math.round(proj), detail, lever, confidence };
}

/**
 * Forward sleep-debt projection — a number you control entirely. Returns
 * { debtHours, nights, detail } or null when debt is negligible (< 1h).
 *
 * Uses the recovery debt model's ~1h/night repayment cap (a great night repays
 * at most ~1h of accumulated debt), so "nights to clear" stays honest rather
 * than promising a single 10-hour night erases a week of deficit.
 */
function sleepDebtTrajectory({ debtHours, needHours, asOf = new Date(), creditPerNight = 1 } = {}) {
  if (debtHours == null || !Number.isFinite(debtHours) || debtHours < 1) return null;
  const nights = Math.max(1, Math.ceil(debtHours / creditPerNight));
  const clearDay = new Date(asOf);
  clearDay.setDate(clearDay.getDate() + nights);
  const needStr = fmtHM(needHours ?? 8);
  const clearClause = nights <= 4
    ? `Hitting your ${needStr} need each night clears it by ${WEEKDAY(clearDay)}`
    : `It'll take about ${nights} solid nights at your ${needStr} need to clear`;
  return {
    debtHours: round1(debtHours),
    nights,
    detail: `You're ${fmtHM(debtHours)} in sleep debt. ${clearClause}; another short night deepens it, and your HRV typically lags a few days behind.`,
  };
}

/**
 * Gather today's signals from the spine and build the forecast. `recovery` is the
 * liveRecovery() result (passed in to avoid a redundant call). Returns
 * { capacity, sleepDebt } — either field may be null.
 */
async function computeTodayForecast({ recovery = null, asOf = new Date() } = {}) {
  const metricsStore = require('../store/metrics');
  const rec = recovery || (await require('./recovery').liveRecovery());
  if (!rec || rec.score == null) return { capacity: null, sleepDebt: null };

  const from = new Date(Date.now() - 60 * 864e5);
  const latestOf = async (metric, sources) => {
    try {
      const rows = await metricsStore.dailyAggregatePreferSource({ domain: 'health', metric, from, agg: 'avg', sources });
      return rows.length ? Number(rows[rows.length - 1].value) : null;
    } catch { return null; }
  };

  const sleepHours = await latestOf('sleep_hours', ['eight_sleep']);
  const sleepDebtHours = await latestOf('sleep_debt', ['eight_sleep']);
  const sleepNeed = await latestOf('sleep_need', ['eight_sleep']);

  // Training-load band from the stored composite finding (computed in analyze).
  let acwrBand = null;
  try {
    const findingsStore = require('../store/findings');
    const open = await findingsStore.listFindings({ status: 'open' });
    const tl = open.find((f) => f.type === 'training_load');
    acwrBand = tl?.evidence?.band ?? null;
  } catch { /* non-critical */ }

  const capacity = predictCapacity({
    recoveryScore: rec.score,
    hrvSubScore: rec.parts?.hrv ?? null,
    sleepHours,
    sleepDebtHours,
    acwrBand,
  });

  // Self-reported (proxy) recovery is subjective — no autonomic data — so don't let
  // a green proxy greenlight maximal effort ("Full send"). Temper the call and make
  // clear the body, not the score, sets the ceiling.
  if (rec.proxy && capacity) {
    capacity.proxy = true;
    if (capacity.grade === 'A') {
      capacity.headline = 'Green-ish — your call';
      capacity.prescription =
        'You rated last night decent (self-reported, no Pod data), so train roughly as planned — but let how you actually feel set the ceiling, not the score.';
    } else {
      capacity.prescription = `${capacity.prescription} Self-reported recovery — listen to your body.`;
    }
  }

  const debt = sleepDebtTrajectory({ debtHours: sleepDebtHours, needHours: sleepNeed, asOf });

  // Did today already include a hard session? Elevated active energy vs the
  // 30-day norm is a decent proxy without needing the workout plan here.
  let hardSessionToday = false;
  try {
    const rows = await metricsStore.dailyAggregate({ domain: 'health', metric: 'active_energy', from, agg: 'sum', excludeSource: 'seed' });
    if (rows.length >= 8) {
      const today = Number(rows[rows.length - 1].value);
      const prior = rows.slice(0, -1).map((r) => Number(r.value)).filter(Number.isFinite);
      const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
      if (mean > 0 && today > mean * 1.3) hardSessionToday = true;
    }
  } catch { /* non-critical */ }

  const tomorrow = forecastTomorrow({
    recoveryScore: rec.score,
    acwrBand,
    sleepDebtHours,
    hardSessionToday,
  });

  return { capacity, sleepDebt: debt, tomorrow };
}

module.exports = { predictCapacity, sleepDebtTrajectory, forecastTomorrow, computeTodayForecast, fmtHM };
