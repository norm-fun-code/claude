// Evening readiness — the signal layer behind the 9:30pm wind-down brief.
//
// This is deliberately NOT a second recovery score. The morning recovery score is
// built on OVERNIGHT HRV/RHR (Eight Sleep), which is a stable night-vs-night
// readiness signal. What we have in the evening is Apple Watch's *daytime* HRV/RHR
// — an average of intraday samples that swings with posture, caffeine, stress, and
// the workout you just did. So we read it as autonomic TONE ("where's your nervous
// system heading into tonight") and compare it daytime-to-daytime against the
// user's own Apple-Health baseline — never against the overnight number.
const metricsStore = require('../store/metrics');
const { query } = require('../db');

const DAY = 24 * 60 * 60 * 1000;
const APPLE = ['apple_health'];
const round = (n, d = 0) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

// Today's UTC-day window. Health metrics anchor at noon-UTC of the local date, so
// a [today 00:00Z, tomorrow 00:00Z] window cleanly captures today's single row and
// a baseline window ending at `from` excludes it.
function dayWindow(tz = process.env.TZ || 'America/New_York') {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const from = new Date(`${today}T00:00:00Z`);
  const to = new Date(from.getTime() + DAY);
  return { today, from, to };
}

function mean(rows) {
  const v = (rows || []).map((r) => Number(r.value)).filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function lastVal(rows) {
  return rows && rows.length ? Number(rows[rows.length - 1].value) : null;
}

/**
 * Daytime autonomic read from Apple Health: today's HRV & RHR vs the user's own
 * trailing daytime baseline. Returns deltas + a coarse tone band the brief and
 * card both key off. Pure aside from the metrics queries — easy to unit-test by
 * stubbing metricsStore.
 */
async function autonomicRead({ tz, baselineDays = 21 } = {}) {
  const { from, to } = dayWindow(tz);
  const baseFrom = new Date(from.getTime() - baselineDays * DAY);
  const q = (metric, f, t) =>
    metricsStore.dailyAggregatePreferSource({ domain: 'health', metric, from: f, to: t, agg: 'avg', sources: APPLE });

  const [hrvToday, hrvBase, rhrToday, rhrBase] = await Promise.all([
    q('hrv', from, to),
    q('hrv', baseFrom, from), // ends at today 00:00Z → excludes today's noon row
    q('resting_hr', from, to),
    q('resting_hr', baseFrom, from),
  ]);

  const hrv = hrvToday.length ? round(lastVal(hrvToday)) : null;
  const rhr = rhrToday.length ? round(lastVal(rhrToday)) : null;
  // Require a few days of baseline before we'll judge a delta as meaningful.
  const hrvBaseline = hrvBase.length >= 5 ? round(mean(hrvBase)) : null;
  const rhrBaseline = rhrBase.length >= 5 ? round(mean(rhrBase)) : null;

  const hrvDeltaPct = hrv != null && hrvBaseline ? (hrv - hrvBaseline) / hrvBaseline : null;
  const rhrDelta = rhr != null && rhrBaseline != null ? rhr - rhrBaseline : null;

  // "Thin" when we can't form any baseline comparison — the brief then soft-pedals
  // rather than over-reading one noisy daytime number.
  const sampleThin =
    (hrv == null && rhr == null) || (hrvBaseline == null && rhrBaseline == null);

  // Tone = combined autonomic load. HRV below baseline and/or RHR above it both
  // point to sympathetic load; either above-baseline HRV or below-baseline RHR
  // relieve it. Thresholds are intentionally forgiving — daytime data is noisy.
  let tone = 'unknown';
  if (!sampleThin) {
    let load = 0;
    if (hrvDeltaPct != null) {
      if (hrvDeltaPct <= -0.15) load += 2;
      else if (hrvDeltaPct <= -0.05) load += 1;
      else if (hrvDeltaPct >= 0.05) load -= 1;
    }
    if (rhrDelta != null) {
      if (rhrDelta >= 5) load += 2;
      else if (rhrDelta >= 2) load += 1;
      else if (rhrDelta <= -2) load -= 1;
    }
    tone = load >= 3 ? 'elevated' : load >= 1 ? 'mild' : 'settled';
  }

  return {
    hrv, hrvBaseline, hrvDeltaPct,
    rhr, rhrBaseline, rhrDelta,
    tone, sampleThin,
    baselineDays,
    hrvBaselineN: hrvBase.length,
    rhrBaselineN: rhrBase.length,
  };
}

// Bug bash finding: watch/device-synced steps (source 'apple_health', etc.)
// are stored as the day's running total (GREATEST upsert) — MAX is correct
// WITHIN that source. But activity-sync.js's 'activity_est' source is a
// DIFFERENT, DISJOINT contribution: an estimate for movement the watch never
// saw at all (an activity logged with "I didn't wear my watch"). Taking a
// single MAX() across every source silently picks whichever one happens to
// be larger and drops the other entirely — on a day with real watch-tracked
// steps AND a logged off-watch activity, the true total is neither number
// alone, it's the SUM of both. (Caught via a live report: a 70-min no-watch
// basketball session estimated at ~9,100 steps never moved the day's step
// count at all, because the day also had ~4,279 watch-tracked steps and the
// old query took MAX(4279, 9100) — losing the smaller contribution instead
// of adding it.)
async function combinedDailyTotal(metric, from, to, tz) {
  const [watchRows, estRows] = await Promise.all([
    metricsStore.dailyAggregate({ domain: 'health', metric, from, to, agg: 'max', excludeSource: ['seed', 'activity_est'], tz }),
    metricsStore.dailyAggregate({ domain: 'health', metric, from, to, agg: 'sum', onlySource: 'activity_est', tz }),
  ]);
  const byDay = new Map();
  for (const r of watchRows) byDay.set(String(r.day), Number(r.value) || 0);
  for (const r of estRows) {
    const key = String(r.day);
    byDay.set(key, (byDay.get(key) || 0) + (Number(r.value) || 0));
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, value]) => ({ day, value }));
}

/** Today's movement load (steps + active energy) vs a 14-day baseline. */
async function todayLoad({ tz } = {}) {
  const { from, to } = dayWindow(tz);
  const baseFrom = new Date(from.getTime() - 14 * DAY);
  const [stepsToday, stepsBase, energyToday, energyBase] = await Promise.all([
    combinedDailyTotal('steps', from, to, tz),
    combinedDailyTotal('steps', baseFrom, from, tz),
    combinedDailyTotal('active_energy', from, to, tz),
    combinedDailyTotal('active_energy', baseFrom, from, tz),
  ]);
  const steps = stepsToday.length ? round(lastVal(stepsToday)) : null;
  const stepsBaseline = stepsBase.length >= 3 ? round(mean(stepsBase)) : null;
  const activeEnergy = energyToday.length ? round(lastVal(energyToday)) : null;
  const activeEnergyBaseline = energyBase.length >= 3 ? round(mean(energyBase)) : null;
  return { steps, stepsBaseline, activeEnergy, activeEnergyBaseline };
}

// A dead/unworn watch loses ALL sensors at once, so both steps and active
// energy collapse together — a genuinely quiet day (sick, WFH, travel) still
// racks up phone-tracked steps even with low deliberate exercise. Requiring
// BOTH to collapse is what tells a device gap apart from a real quiet day.
const DEVICE_GAP_RATIO = 0.25;

/**
 * Pure: flag when today's device-derived movement collapsed together far below
 * the user's own baseline — most likely a dead/unworn Apple Watch, not a real
 * behavior change. Skipped on a scheduled rest day (already explains low
 * activity) and requires a real baseline on both metrics to compare against.
 * Returns a short, human-phrased flag string, or null when nothing's off.
 */
function detectDeviceDataGap({ load, isRestDay }) {
  if (isRestDay) return null;
  const { steps, stepsBaseline, activeEnergy, activeEnergyBaseline } = load || {};
  if (steps == null || stepsBaseline == null || !stepsBaseline) return null;
  if (activeEnergy == null || activeEnergyBaseline == null || !activeEnergyBaseline) return null;
  const stepsRatio = steps / stepsBaseline;
  const energyRatio = activeEnergy / activeEnergyBaseline;
  if (stepsRatio >= DEVICE_GAP_RATIO || energyRatio >= DEVICE_GAP_RATIO) return null;
  return `Steps and active energy both came in far under your norm today ` +
    `(${Math.round(steps)} vs ~${Math.round(stepsBaseline)} steps, ${Math.round(activeEnergy)} vs ~${Math.round(activeEnergyBaseline)} kcal active energy) ` +
    `— looks like a Watch gap (dead/not worn) rather than a real change.`;
}

// Evening-coded habits — the ones it makes sense to nudge at night. Morning TM is
// excluded (the window has passed); these can still be done before bed.
const EVENING_HABITS = [
  { metric: 'gratitude', label: 'Gratitude journal' },
  { metric: 'afternoon_tm', label: 'Afternoon TM' },
  { metric: 'exercise', label: 'Exercise' },
];

// A dayContext note like "not feeling well, getting sick" means exercise isn't
// a quiet win to nag about tonight — it's actively bad advice.
// Careful with ambiguous roots: "chills" (symptom) vs "chill" (relaxed/cold-out),
// "flu" must be a whole word (not "influence"/"fluffy"), "ill" only as its own
// word (not "chill"/"skill"/"still") — same lesson as MOOD_KEYWORDS.
const SICK_KEYWORDS = /\bnot feeling well\b|\bgetting sick\b|\bcoming down with\b|\bfeeling (?:sick|ill|unwell)\b|\bunwell\b|\bunder the weather\b|\bfever\b|\bnause|\bflu\b|\bchills\b|\bachy\b|sore throat|congest|\bill\b|illness/i;

/** Pure: does today's context (the user's own words) read as a sick day? */
function isSickDay(dayContext) {
  return SICK_KEYWORDS.test(String(dayContext || ''));
}

/** Pure: the evening-coded habits actually worth nudging tonight. On a rest day,
 *  "Exercise" isn't really open — there's no planned session to have done, so
 *  nagging about it is the same class of bug as grading steps against a
 *  training-day norm. On a sick day, exercise gets the same treatment — it's
 *  not a "quick win before bed" while unwell. Split out from openEveningHabits
 *  so this rule is unit-testable without a DB. */
function eveningHabitsToTrack(isRestDay, isSick = false) {
  const skip = new Set();
  if (isRestDay) skip.add('exercise');
  if (isSick) skip.add('exercise');
  return EVENING_HABITS.filter((h) => !skip.has(h.metric));
}

// Evening-brief redesign: a genuine bedtime/wind-down cutoff concept — an
// explicit, testable time check rather than an assumption baked silently
// into habit classification. The evening brief's own schedule (9:30pm,
// see scheduler.js) always runs past this, but a manually-triggered rebuild
// earlier in the evening should reason about "still worth doing tonight"
// differently than the standard run.
const WINDDOWN_CUTOFF_MINUTES = 21 * 60; // 9:00pm local

function minutesSinceMidnightLocal(date, tz) {
  const local = date.toLocaleTimeString('en-US', { timeZone: tz, hour12: false });
  const [h, m] = local.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Pure: is `asOf` at or past the wind-down cutoff in `tz`? */
function isPastWindDownCutoff(asOf = new Date(), tz = process.env.TZ || 'America/New_York') {
  return minutesSinceMidnightLocal(asOf, tz) >= WINDDOWN_CUTOFF_MINUTES;
}

// Calm, restorative, genuinely compatible with winding down — worth a gentle
// optional nudge even late. Everything else still open this late has either
// missed its natural window (a meditation session meant for the afternoon)
// or actively competes with winding down (exercise) — nagging about those at
// night reads as pressure, not help, so they're released instead.
const NIGHT_COMPATIBLE_HABITS = new Set(['gratitude']);

/**
 * Split still-open evening habits into what's genuinely worth doing tonight
 * (night-compatible, or simply not yet past the wind-down cutoff) vs. what's
 * better let go until tomorrow rather than framed as an urgent "quick win."
 * Pure — unit-testable without a DB or a real clock.
 */
function classifyOpenHabits(openHabits, { pastCutoff }) {
  const tonight = [];
  const letGo = [];
  for (const h of openHabits) {
    if (NIGHT_COMPATIBLE_HABITS.has(h.metric) || !pastCutoff) tonight.push(h.label);
    else letGo.push(h.label);
  }
  return { tonight, letGo };
}

/** Which evening-coded habits are still unlogged today, split into
 *  {tonight, letGo} — see classifyOpenHabits above. */
async function openEveningHabits({ tz = process.env.TZ || 'America/New_York', isRestDay = false, isSick = false, asOf = new Date() } = {}) {
  const { rows } = await query(
    `SELECT metric, value FROM metrics
      WHERE domain = 'habits'
        AND (ts AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [tz]
  );
  const done = new Set(rows.filter((r) => Number(r.value) >= 0.5).map((r) => r.metric));
  const stillOpen = eveningHabitsToTrack(isRestDay, isSick).filter((h) => !done.has(h.metric));
  return classifyOpenHabits(stillOpen, { pastCutoff: isPastWindDownCutoff(asOf, tz) });
}

/** Today's self-reported check-in (mood/energy/focus), if logged — the evening
 *  brief otherwise only ever sees body metrics (HRV/RHR/steps), never how the
 *  user actually said they were doing. dayAnchorTs keys one clean row per
 *  metric per day, so a plain same-day average is exactly today's value. */
async function todayCheckin({ tz } = {}) {
  const { from, to } = dayWindow(tz);
  const q = (metric) => metricsStore.dailyAggregate({ domain: 'wellbeing', metric, from, to, agg: 'avg' });
  const [mood, energy, focus] = await Promise.all([q('mood'), q('energy'), q('focus')]);
  return {
    mood: mood.length ? round(mean(mood), 1) : null,
    energy: energy.length ? round(mean(energy), 1) : null,
    focus: focus.length ? round(mean(focus), 1) : null,
  };
}

/**
 * Last `days` nights of sleep_hours + sleep_need — the two raw series
 * recovery.js's sleepBalance7() needs. That's the single canonical sleep
 * debt/surplus calculation in the app (see its own doc comment: "anywhere
 * debt is shown should call this rather than reading the raw Eight Sleep
 * field directly") — evening-brief.js's wind-down advice must be grounded in
 * it, not in whether tomorrow happens to be a day off. gatherEvening()
 * otherwise never touches sleep data at all (recovery.js's own callers
 * compute this as a side effect of a much bigger seriesByKey fetch this
 * module has no reason to duplicate).
 */
async function recentSleepSeries({ tz, days = 10 } = {}) {
  const { to } = dayWindow(tz);
  const from = new Date(to.getTime() - days * DAY);
  const [sleepHours, sleepNeed] = await Promise.all([
    metricsStore.dailyAggregate({ domain: 'health', metric: 'sleep_hours', from, to, agg: 'avg' }),
    metricsStore.dailyAggregate({ domain: 'health', metric: 'sleep_need', from, to, agg: 'avg' }),
  ]);
  return { sleepHours, sleepNeed };
}

/** Gather everything the evening brief composer needs. */
async function gatherEvening({ tz, isRestDay = false, isSick = false, asOf = new Date() } = {}) {
  const [autonomic, load, habitsSplit, checkin, sleepSeries] = await Promise.all([
    autonomicRead({ tz }),
    todayLoad({ tz }),
    openEveningHabits({ tz, isRestDay, isSick, asOf }),
    todayCheckin({ tz }),
    recentSleepSeries({ tz }),
  ]);
  const { sleepBalance7 } = require('./recovery');
  const sleepBalance = sleepBalance7(sleepSeries.sleepHours, sleepSeries.sleepNeed);
  // openHabits = genuinely worth doing tonight (calm/restorative, or simply
  // not yet past the wind-down cutoff); letGoHabits = better released than
  // nagged about this late — see classifyOpenHabits's doc comment.
  return { autonomic, load, openHabits: habitsSplit.tonight, letGoHabits: habitsSplit.letGo, checkin, sleepBalance };
}

module.exports = {
  autonomicRead, todayLoad, todayCheckin, openEveningHabits, eveningHabitsToTrack,
  isPastWindDownCutoff, classifyOpenHabits,
  gatherEvening, dayWindow, detectDeviceDataGap, isSickDay, recentSleepSeries,
  // Exported for direct, date-parameterized regression testing — todayLoad()
  // itself is hard-wired to literal wall-clock "today" (dayWindow() reads
  // `new Date()`), so a test exercising it can't pick an isolated historical
  // date and inevitably collides with any other test writing to the same
  // real 'activity_est' source for the same real day.
  combinedDailyTotal,
};
