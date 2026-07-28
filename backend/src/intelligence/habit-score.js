// Recompute today's habit_score (0-100) from whatever binary habits are
// logged for today, so a partial save can't leave the composite disagreeing
// with its components. Best-effort; never throws into the request path.
//
// Promoted out of server.js's habits routes to a shared module — several
// other call sites (the voice-command habit-logging paths) also need it, and
// a helper used by more than one caller shouldn't live inside a route file.
const db = require('../db');
const metricsStore = require('../store/metrics');

const BINARY_HABITS = ['morning_tm', 'afternoon_tm', 'gratitude', 'exercise'];

async function recomputeHabitScore(tz) {
  try {
    const { rows } = await db.query(
      `SELECT metric, value FROM metrics
        WHERE domain = 'habits' AND source = 'habits'
          AND metric = ANY($1)
          AND (ts AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
      [BINARY_HABITS, tz]
    );
    if (!rows.length) return;
    const done = rows.reduce((s, r) => s + (Number(r.value) ? 1 : 0), 0);
    const score = Math.round((done / rows.length) * 100);
    const when = require('../util/date').dayAnchorTs(tz);
    await metricsStore.insertMetrics([
      { ts: when, domain: 'habits', metric: 'habit_score', value: score, unit: 'percent', source: 'habits' },
    ]);
  } catch (err) {
    console.error('[habit_score] recompute failed:', err.message);
  }
}

module.exports = { recomputeHabitScore, BINARY_HABITS };
