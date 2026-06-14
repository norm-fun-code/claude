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

  let grade, band, headline;
  if (recoveryScore >= 67)      { grade = 'A'; band = 'green';  headline = 'Full send'; }
  else if (recoveryScore >= 50) { grade = 'B'; band = 'yellow'; headline = 'Hit your essentials'; }
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
  const debt = sleepDebtTrajectory({ debtHours: sleepDebtHours, needHours: sleepNeed, asOf });

  return { capacity, sleepDebt: debt };
}

module.exports = { predictCapacity, sleepDebtTrajectory, computeTodayForecast, fmtHM };
