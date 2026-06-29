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

/** Today's movement load (steps + active energy) vs a 14-day baseline. */
async function todayLoad({ tz } = {}) {
  const { from, to } = dayWindow(tz);
  const baseFrom = new Date(from.getTime() - 14 * DAY);
  // Steps/energy are stored as the day's running total (GREATEST upsert), so the
  // per-day max is the day total.
  const [stepsToday, stepsBase, energyToday] = await Promise.all([
    metricsStore.dailyAggregate({ domain: 'health', metric: 'steps', from, to, agg: 'max', excludeSource: 'seed' }),
    metricsStore.dailyAggregate({ domain: 'health', metric: 'steps', from: baseFrom, to: from, agg: 'max', excludeSource: 'seed' }),
    metricsStore.dailyAggregate({ domain: 'health', metric: 'active_energy', from, to, agg: 'max', excludeSource: 'seed' }),
  ]);
  const steps = stepsToday.length ? round(lastVal(stepsToday)) : null;
  const stepsBaseline = stepsBase.length >= 3 ? round(mean(stepsBase)) : null;
  const activeEnergy = energyToday.length ? round(lastVal(energyToday)) : null;
  return { steps, stepsBaseline, activeEnergy };
}

// Evening-coded habits — the ones it makes sense to nudge at night. Morning TM is
// excluded (the window has passed); these can still be done before bed.
const EVENING_HABITS = [
  { metric: 'gratitude', label: 'Gratitude journal' },
  { metric: 'afternoon_tm', label: 'Afternoon TM' },
  { metric: 'cold_shower', label: 'Cold shower' },
  { metric: 'exercise', label: 'Exercise' },
];

/** Which evening-coded habits are still unlogged today. */
async function openEveningHabits({ tz = process.env.TZ || 'America/New_York' } = {}) {
  const { rows } = await query(
    `SELECT metric, value FROM metrics
      WHERE domain = 'habits'
        AND (ts AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [tz]
  );
  const done = new Set(rows.filter((r) => Number(r.value) >= 0.5).map((r) => r.metric));
  return EVENING_HABITS.filter((h) => !done.has(h.metric)).map((h) => h.label);
}

/** Gather everything the evening brief composer needs. */
async function gatherEvening({ tz } = {}) {
  const [autonomic, load, openHabits] = await Promise.all([
    autonomicRead({ tz }),
    todayLoad({ tz }),
    openEveningHabits({ tz }),
  ]);
  return { autonomic, load, openHabits };
}

module.exports = { autonomicRead, todayLoad, openEveningHabits, gatherEvening, dayWindow };
