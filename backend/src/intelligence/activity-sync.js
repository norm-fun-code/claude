// Rolls a day's logged activity minutes into the metrics spine as
// health:exercise_minutes (source 'activity'), so logged Zone 2 walks etc.
// feed training-load (ACWR), trends, and correlations like any other health
// metric. ALSO estimates the steps + active energy those activities burned
// (from type × duration × body weight) and writes them under source
// 'activity_est', so days you didn't wear the watch still get credited. Both
// writes recompute the day's full total each call (idempotent via the
// (ts,domain,metric,source) upsert).
//
// Promoted out of server.js's activity routes to a shared module — the
// voice-command "log an activity" path (routed.action === 'log_activity')
// also calls it after its own direct activity_logs insert, so a helper used
// by more than one caller shouldn't live inside a route file.
const db = require('../db');
const metricsStore = require('../store/metrics');
const { estimateActivity } = require('./activity-estimates');

async function syncActivityMinutes(date) {
  try {
    const ts = new Date(`${date}T12:00:00`);

    const { rows } = await db.query(
      `SELECT activity_type, duration_min, no_watch FROM activity_logs
       WHERE log_date = $1 AND duration_min IS NOT NULL`, [date]
    );
    const mins = rows.reduce((s, r) => s + Number(r.duration_min || 0), 0);

    // Latest logged body weight (lbs) for the energy formula; estimator falls back
    // to a default if none is on record.
    const weightRow = await metricsStore.latest({ domain: 'health', metric: 'weight' }).catch(() => null);
    const weightLb = weightRow ? Number(weightRow.value) : undefined;

    // Only watch-off activities contribute an estimate — otherwise the watch
    // already measured the movement and adding it would double-count.
    let estSteps = 0, estKcal = 0;
    for (const r of rows) {
      if (!r.no_watch) continue;
      const e = estimateActivity({ type: r.activity_type, minutes: r.duration_min, weightLb });
      estSteps += e.steps;
      estKcal += e.kcal;
    }

    await metricsStore.insertMetrics([
      { ts, domain: 'health', metric: 'exercise_minutes', value: mins, unit: 'min', source: 'activity' },
      { ts, domain: 'health', metric: 'steps', value: estSteps, unit: 'count', source: 'activity_est' },
      { ts, domain: 'health', metric: 'active_energy', value: estKcal, unit: 'kcal', source: 'activity_est' },
    ]);
  } catch (err) {
    console.error('[syncActivityMinutes] failed:', err.message);
  }
}

module.exports = { syncActivityMinutes };
