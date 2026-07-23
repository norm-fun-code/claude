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
function forecastTomorrow({ recoveryScore, acwrBand, sleepDebtHours, hardSessionStatus = 'none' } = {}) {
  if (recoveryScore == null || !Number.isFinite(recoveryScore)) return null;
  let proj = recoveryScore;
  const drags = [];
  if (acwrBand === 'high') { proj -= 8; drags.push('training load is spiking'); }
  // 'completed' = explicit same-local-day evidence a hard workout actually
  // happened (activity log / exercise habit). 'planned' = the effective plan
  // (workout_overrides first, else the scheduled split) calls for a hard
  // session today but there's no completion evidence yet — still a plausible
  // drag on tomorrow, but worded as provisional, not asserted fact. 'none'
  // (rest, Recovery + Mobility, Zone 2, or an explicit rest override) never
  // drags, regardless of unrelated activity like elevated active energy.
  if (hardSessionStatus === 'completed') { proj -= 6; drags.push("today's hard session adds fatigue"); }
  else if (hardSessionStatus === 'planned') { proj -= 6; drags.push("today's planned hard session may add fatigue"); }
  if (sleepDebtHours != null && sleepDebtHours >= 2) { proj -= 6; drags.push(`${fmtHM(sleepDebtHours)} of sleep debt`); }
  const easy = (acwrBand === 'low' || acwrBand == null) && (sleepDebtHours == null || sleepDebtHours < 1) && hardSessionStatus === 'none';
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
 * liveRecovery() result (passed in to avoid a redundant call). `effectiveWorkout`
 * is the already-resolved getEffectiveWorkout() result, and `trainingOutcome` is
 * the already-resolved resolveTrainingOutcome() result — pass both (as
 * BrainSnapshot does) so a single snapshot resolves each ONCE instead of this
 * function re-resolving them (a second override lookup, a second recovery-band
 * read, a second set of activity/habit/completion queries). Omit either and this
 * falls back to resolving it itself, so standalone callers still work. Returns
 * { capacity, sleepDebt } — either field may be null.
 */
async function computeTodayForecast({ recovery = null, asOf = new Date(), effectiveWorkout = undefined, trainingOutcome = undefined } = {}) {
  const metricsStore = require('../store/metrics');
  const rec = recovery || (await require('./recovery').liveRecovery());
  if (!rec || rec.score == null) return { capacity: null, sleepDebt: null };

  const from = new Date(asOf.getTime() - 60 * 864e5);
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
    const seriesFrom = new Date(asOf.getTime() - 14 * 864e5); // enough history for 7 paired nights
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

  // Did today already include (or call for) a hard session? Used to be
  // inferred from active_energy > 1.3x the 30-day mean, taking whatever row
  // happened to be LAST in the window without ever proving that row was
  // actually today in the configured timezone — a Monday hard session could
  // get misread as "today's" fatigue on a Tuesday Recovery + Mobility day,
  // and active energy is nonspecific anyway (ordinary movement moves it too).
  // Replaced with the authoritative data model: the effective plan
  // (workout_overrides first, else the scheduled split — see
  // services/workout.js's getEffectiveWorkout) tells us whether today is
  // SUPPOSED to be hard; the canonical trainingOutcome (services/workout.js's
  // resolveTrainingOutcome — hardSessionCompleted specifically) tells us
  // whether a hard session actually HAPPENED. This function no longer queries
  // activity_logs/metrics itself at all — that used to make the exercise
  // habit alone (proving only that SOME exercise occurred) corroborate a hard
  // session whenever the plan itself was hard, so logging an unrelated walk
  // on a scheduled Intervals day got read as completing the Intervals session.
  // resolveTrainingOutcome fixes that at the source; this just reads its
  // verdict. Active energy is no longer consulted at all.
  const tz = process.env.TZ || 'America/New_York';
  const todayStr = asOf.toLocaleDateString('en-CA', { timeZone: tz });
  let hardSessionStatus = 'none'; // 'none' | 'planned' | 'completed'
  try {
    const workoutSvc = require('../services/workout');
    // Use the snapshot's already-resolved effective workout/trainingOutcome
    // when provided — this is the ONE authority read per snapshot. Only
    // resolve either here when a standalone caller didn't supply it. The
    // effective plan may itself be an automatic recovery-based downgrade
    // (e.g. red recovery swaps a scheduled Push to Mobility), which is
    // exactly the case this function exists to get right: a downgraded,
    // non-hard session must not carry a "hard session" drag into tomorrow's
    // forecast.
    const effective = effectiveWorkout !== undefined
      ? effectiveWorkout
      : await workoutSvc.getEffectiveWorkout({ asOf, tz, band: rec.band ?? null });
    const outcome = trainingOutcome !== undefined
      ? trainingOutcome
      : await workoutSvc.resolveTrainingOutcome({ asOf, tz, effectiveWorkout: effective });
    if (outcome?.hardSessionCompleted) hardSessionStatus = 'completed';
    else if (effective?.isHard) hardSessionStatus = 'planned';
  } catch { /* non-critical — no drag when we can't determine it */ }

  let tomorrow = forecastTomorrow({
    recoveryScore: rec.score,
    acwrBand,
    sleepDebtHours,
    hardSessionStatus,
  });

  // Read whatever context the user gave for today/tomorrow (voice or typed) in
  // case it says something the numbers can't see yet — a stressful day ahead,
  // travel, illness, a planned rest day.
  if (tomorrow) {
    // Reuse the same tz/todayStr computed above (from `asOf`, not `new Date()`)
    // — this whole function must stay deterministic under an injected asOf.
    // The day boundary MUST be timezone-safe: `new Date(\`${todayStr}T00:00:00\`)`
    // parses in the SERVER process's local zone (util/date.js's whole reason to
    // exist), which is wrong whenever the server isn't running in `tz`.
    // localDayBoundsUtc(tz, asOf) gives the correct UTC instant for local
    // midnight, deterministic under the injected asOf.
    const { localDayBoundsUtc } = require('../util/date');
    const { start: startOfToday } = localDayBoundsUtc(tz, asOf);
    const [dayContext, rawAnnotations] = await Promise.all([
      require('../store/dayJournal').forDay(todayStr).catch(() => []),
      require('../store/annotations').overlapping(asOf, asOf).catch(() => []),
    ]);
    // Route life-context through the SHARED eligibility layer instead of an
    // ad-hoc filter — a retracted, retired, negated, or financial annotation
    // must not be able to move a forward-looking forecast (see
    // context-semantics.js's 'forecast' purpose). Then keep only notes about
    // today/forward: a "one question" answer explaining something PAST (e.g.
    // "No Eight Sleep reading last night" -> "Didn't sleep home") is backdated
    // to yesterday by POST /api/briefing/context specifically so it reads as
    // retrospective — a note about a night that's already over must not get
    // framed as "noted for today/tomorrow" and adjust a forecast it was never
    // meant to speak to.
    const { filterEligible } = require('./context-semantics');
    const annotations = filterEligible(rawAnnotations, { purpose: 'forecast' })
      .filter((a) => new Date(a.start_ts) >= startOfToday);
    tomorrow = await applyContextToForecast(tomorrow, { dayContext, annotations });

    // Empirical confidence cap: forecastTomorrow()'s 45-85% figure is a shape
    // heuristic (distance from the band boundary), not a measured probability —
    // and the calibration ledger now records how these calls actually land.
    // With enough history, never CLAIM more confidence than the forecasts have
    // empirically earned. Deliberately one-directional: a hot streak doesn't
    // inflate a mid-band coin-flip call, it only reins in overconfidence.
    try {
      const track = await require('../store/forecastCalibration').hitRate({ days: 30 });
      if (track.rate != null && track.n >= 10 && tomorrow?.confidence != null) {
        const empirical = Math.round(track.rate * 100);
        if (empirical < tomorrow.confidence) tomorrow = { ...tomorrow, confidence: empirical, confidenceCapped: true };
        tomorrow.trackRecord = { n: track.n, hits: track.hits };
      }
    } catch { /* non-critical — uncapped heuristic confidence */ }
  }

  return { capacity, sleepDebt: debt, tomorrow };
}

module.exports = {
  predictCapacity, sleepDebtTrajectory, forecastTomorrow, computeTodayForecast, fmtHM,
  buildContextAdjustPrompt, parseContextAdjustment, applyContextToForecast,
};
