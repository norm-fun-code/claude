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

// ── Context-adjusted forecast ─────────────────────────────────────────────────
// forecastTomorrow() only sees NUMBERS (recovery, training load, sleep debt) —
// it has no way to know you mentioned a stressful launch today, that you're
// traveling tomorrow, or that tomorrow's a planned rest day. Free-text day
// context (voice/typed) carries exactly that. This layer reads it and can
// ADD a cautionary note or push the lean down one band — never up: the body's
// physiological signals are still the hard ceiling (same rule predictCapacity
// already applies to "full send" days), context can only counsel caution, not
// invent capacity the numbers don't show.

const CONTEXT_ADJUST_SYSTEM =
  'You are a careful sports-science assistant reviewing a recovery forecast. ' +
  'You get the DETERMINISTIC forecast (already computed from HRV/sleep/training-load data) ' +
  'plus free-text notes the person gave about today and tomorrow. ' +
  'Decide ONLY whether the note changes anything the numbers could not already see — ' +
  'travel, illness, a big stressful day, poor sleep they described, a planned easy/rest day, etc. ' +
  'Return ONLY compact JSON, no prose: {"relevant":true|false,"downgrade":true|false,"note":"<=18 words or empty"}. ' +
  'relevant=false (and downgrade=false, note="") for anything that is not clearly about tomorrow\'s ' +
  'capacity or load — most notes ARE irrelevant here, so default to false. ' +
  'downgrade=true ONLY when the note describes something that would plausibly hurt tomorrow further ' +
  'than the numbers already project (added stress, illness, travel fatigue, a demanding day ahead). ' +
  'NEVER set downgrade based on something positive (a rest day planned, good news) — describe it in ' +
  'the note if worth mentioning, but do not change the lean upward; the physiological data is the ceiling.';

function buildContextAdjustPrompt(tomorrow, contextLines) {
  const prompt =
    `DETERMINISTIC FORECAST: leaning ${tomorrow.band} (projected score ${tomorrow.projectedScore}/100). ${tomorrow.detail}\n\n` +
    `NOTES:\n${contextLines.map((l) => `- ${l}`).join('\n')}`;
  return { system: CONTEXT_ADJUST_SYSTEM, prompt };
}

/** Parse + validate the model's JSON reply. Strict: anything malformed → null
 *  (caller keeps the untouched deterministic forecast). */
function parseContextAdjustment(text) {
  return require('../llm/parseJson').parseAndValidate(text, {
    label: 'context-adjust',
    validate: (p) => {
      if (p.relevant !== true) return null; // false/missing/garbage → no adjustment
      return {
        downgrade: p.downgrade === true,
        note: typeof p.note === 'string' ? p.note.trim().slice(0, 200) : '',
      };
    },
  });
}

const BAND_ORDER = ['green', 'yellow', 'red'];

/**
 * Let free-text context adjust tomorrow's forecast. Skips the LLM call entirely
 * when there's no context to consider (the common case — most days have none).
 * On any failure, returns the deterministic forecast unchanged.
 */
async function applyContextToForecast(tomorrow, { dayContext = [], annotations = [] } = {}) {
  if (!tomorrow) return tomorrow;
  const contextLines = [
    ...dayContext.map((e) => `About today: ${e.text}`),
    ...annotations.map((a) => `Noted for today/tomorrow: ${a.label}${a.note ? ` (${a.note})` : ''}`),
  ].filter(Boolean);
  if (!contextLines.length) return tomorrow;

  try {
    const llm = require('../llm');
    const { system, prompt } = buildContextAdjustPrompt(tomorrow, contextLines);
    const raw = await llm.generateText({ system, prompt, temperature: 0.2, maxTokens: 200, jsonMode: true });
    const adj = parseContextAdjustment(raw);
    if (!adj) return tomorrow;

    let next = { ...tomorrow };
    if (adj.note) next.contextNote = adj.note;
    if (adj.downgrade) {
      const idx = BAND_ORDER.indexOf(tomorrow.band);
      if (idx >= 0 && idx < BAND_ORDER.length - 1) {
        next.band = BAND_ORDER[idx + 1];
        next.projectedScore = Math.max(0, tomorrow.projectedScore - 10);
      }
    }
    return next;
  } catch (err) {
    console.error('[forecast] context adjustment failed, using deterministic forecast:', err.message);
    return tomorrow;
  }
}

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
  const sleepNeed = await latestOf('sleep_need', ['eight_sleep']);

  // Sleep debt: use the corrected 7-day balance (recovery.sleepBalance7) instead
  // of Eight Sleep's raw sleep_debt field, which only counts cumulative deficit
  // and never goes negative — so a genuinely well-rested week still showed
  // phantom debt here (this forecast predates recovery.js's fix and was never
  // updated to use it). null when there isn't enough history to judge (< 3
  // paired nights); 0 on a surplus week; positive hours on a real deficit.
  let sleepDebtHours = null;
  try {
    const seriesFrom = new Date(Date.now() - 14 * 864e5); // enough history for 7 paired nights
    const [sleepSeries, sleepNeedSeries] = await Promise.all([
      metricsStore.dailyAggregatePreferSource({ domain: 'health', metric: 'sleep_hours', from: seriesFrom, agg: 'avg', sources: ['eight_sleep'] }),
      metricsStore.dailyAggregatePreferSource({ domain: 'health', metric: 'sleep_need', from: seriesFrom, agg: 'avg', sources: ['eight_sleep'] }),
    ]);
    const balance = require('./recovery').sleepBalance7(sleepSeries, sleepNeedSeries);
    sleepDebtHours = balance ? Math.max(0, -balance.net) : null;
  } catch { /* non-critical */ }

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

  let tomorrow = forecastTomorrow({
    recoveryScore: rec.score,
    acwrBand,
    sleepDebtHours,
    hardSessionToday,
  });

  // Read whatever context the user gave for today/tomorrow (voice or typed) in
  // case it says something the numbers can't see yet — a stressful day ahead,
  // travel, illness, a planned rest day.
  if (tomorrow) {
    const tz = process.env.TZ || 'America/New_York';
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const startOfToday = new Date(`${todayStr}T00:00:00`);
    const [dayContext, rawAnnotations] = await Promise.all([
      require('../store/dayJournal').forDay(todayStr).catch(() => []),
      require('../store/annotations').overlapping(asOf, asOf).catch(() => []),
    ]);
    // A "one question" answer explaining something PAST (e.g. "No Eight Sleep
    // reading last night" -> "Didn't sleep home") is backdated to yesterday by
    // POST /api/briefing/context specifically so it reads as retrospective —
    // exclude those here so a note about a night that's already over doesn't
    // get framed as "noted for today/tomorrow" and adjust a FORWARD-looking
    // forecast it was never meant to speak to.
    const annotations = rawAnnotations.filter((a) => new Date(a.start_ts) >= startOfToday);
    tomorrow = await applyContextToForecast(tomorrow, { dayContext, annotations });
  }

  return { capacity, sleepDebt: debt, tomorrow };
}

module.exports = {
  predictCapacity, sleepDebtTrajectory, forecastTomorrow, computeTodayForecast, fmtHM,
  buildContextAdjustPrompt, parseContextAdjustment, applyContextToForecast,
};
