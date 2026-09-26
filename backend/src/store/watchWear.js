// Which days the Apple Watch was actually worn.
//
// Wearing it is the DEFAULT, and that asymmetry is the whole design: only
// not-worn days get a row, so the common case costs nothing to maintain and
// "worn" can never drift out of date through neglect. Toggling a day back to
// worn deletes its row rather than storing a second state.
//
// Nothing here deletes or edits a metric. The exclusion happens at read time
// in store/metrics.js, so the raw HealthKit rows stay intact and the toggle is
// reversible in both directions — the same "gate it, never destroy it"
// discipline the context layer uses for retracted statements.
const { query } = require('../db');

/** Metrics that depend on the watch being ON THE WRIST.
 *
 *  Deliberately the same four the spine already treats as cumulative daily
 *  activity (store/metrics.js's GREATEST upsert, analyze.js's CUMULATIVE set)
 *  — one definition of "wrist-sensed", not a second list to drift from it.
 *
 *  Body metrics (weight, body fat) are absent on purpose: they come from a
 *  scale, not the watch, and must keep counting on a no-watch day. So are
 *  HRV/resting HR/sleep, which this app source-locks to the overnight Eight
 *  Sleep reading (see recovery.js's NIGHT_SOURCES) — the watch not being worn
 *  says nothing about those. */
const WRIST_METRICS = Object.freeze(['steps', 'active_energy', 'exercise_minutes', 'mindful_minutes']);

/** Sources whose wrist readings are void when the watch is off.
 *
 *  `activity_est` is NOT here, and that is the point: it is the estimate
 *  written when you log a workout the watch never saw (see
 *  intelligence/activity-sync.js, and the no-watch basketball session its
 *  comment describes). On a no-watch day the watch's own near-zero reading is
 *  dropped while a deliberately logged activity still counts — which is the
 *  only combination that leaves the day's total honest. */
const WATCH_SOURCES = Object.freeze(['apple_health']);

/** Normalize to a YYYY-MM-DD local day key. Accepts a Date (Postgres `date`
 *  columns arrive as one) or a string; returns null for anything else, so a
 *  bad input is refused rather than silently keyed as "Invalid Date". */
function toDayKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** Record that the watch was NOT worn on `day`. Idempotent. */
async function markNotWorn(day, note = null) {
  const key = toDayKey(day);
  if (!key) throw new Error('watchWear.markNotWorn: day must be YYYY-MM-DD');
  await query(
    `INSERT INTO watch_off_days (local_day, note) VALUES ($1, $2)
       ON CONFLICT (local_day) DO UPDATE SET note = EXCLUDED.note`,
    [key, note]
  );
  return key;
}

/** Record that the watch WAS worn on `day` — i.e. remove the exception. */
async function markWorn(day) {
  const key = toDayKey(day);
  if (!key) throw new Error('watchWear.markWorn: day must be YYYY-MM-DD');
  await query(`DELETE FROM watch_off_days WHERE local_day = $1`, [key]);
  return key;
}

/** Was the watch worn on `day`? True unless explicitly marked otherwise.
 *  Fail-safe: on a store error, report WORN — the default — so a database
 *  hiccup can never silently erase a day of real activity from every trend. */
async function wasWorn(day) {
  const key = toDayKey(day);
  if (!key) return true;
  try {
    const { rows } = await query(`SELECT 1 FROM watch_off_days WHERE local_day = $1`, [key]);
    return rows.length === 0;
  } catch {
    return true;
  }
}

/** Not-worn days as YYYY-MM-DD strings, newest first. */
async function notWornDays({ from = null, to = null, limit = 400 } = {}) {
  try {
    const { rows } = await query(
      `SELECT local_day, note FROM watch_off_days
        WHERE ($1::date IS NULL OR local_day >= $1)
          AND ($2::date IS NULL OR local_day <= $2)
        ORDER BY local_day DESC
        LIMIT $3`,
      [toDayKey(from), toDayKey(to), limit]
    );
    return rows.map((r) => ({ day: toDayKey(r.local_day), note: r.note ?? null }));
  } catch {
    return [];
  }
}

module.exports = { markWorn, markNotWorn, wasWorn, notWornDays, toDayKey, WRIST_METRICS, WATCH_SOURCES };
