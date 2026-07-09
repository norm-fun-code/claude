// Activity logs router: what you ACTUALLY did when it differs from the plan
// (e.g. scheduled Pull but you walked instead). Free-form, multiple per day
// allowed. Seventh router extraction out of server.js's monolith (see the
// engineering review's #1+#6 recommendation) — a straight move, verified
// line-by-line against the original before removing it from server.js.
const express = require('express');
const db = require('../db');
const metricsStore = require('../store/metrics');
const { estimateActivity } = require('../intelligence/activity-estimates');
const { syncActivityMinutes } = require('../intelligence/activity-sync');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireFields } = require('../middleware/validate');

function createActivityRouter() {
  const router = express.Router();

  // GET /api/activity?date=YYYY-MM-DD — list activities logged for a day.
  router.get('/activity', asyncHandler(async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const { rows } = await db.query(
      `SELECT id, activity_type, label, duration_min, note, planned_type, no_watch, created_at
       FROM activity_logs WHERE log_date = $1
       ORDER BY created_at ASC`, [date]
    );
    // Attach the estimated steps/energy for watch-off activities (the only ones
    // that contribute an estimate to the day's totals).
    const weightRow = await metricsStore.latest({ domain: 'health', metric: 'weight' }).catch(() => null);
    const weightLb = weightRow ? Number(weightRow.value) : undefined;
    const activities = rows.map((r) => ({
      ...r,
      estimate: r.no_watch ? estimateActivity({ type: r.activity_type, minutes: r.duration_min, weightLb }) : null,
    }));
    res.json({ activities });
  }));

  // POST /api/activity — log an activity. Body: { date, activity_type, label?,
  // duration_min?, note?, planned_type? }. Returns the inserted row.
  router.post('/activity', asyncHandler(async (req, res) => {
    const { date, activity_type, label = null, duration_min = null, note = null, planned_type = null, no_watch = false } = req.body || {};
    if (!requireFields(req.body, ['date', 'activity_type'], res)) return;
    const { rows } = await db.query(
      `INSERT INTO activity_logs (log_date, activity_type, label, duration_min, note, planned_type, no_watch)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, activity_type, label, duration_min, note, planned_type, no_watch, created_at`,
      [date, activity_type, label, duration_min == null ? null : Number(duration_min), note, planned_type, !!no_watch]
    );
    await syncActivityMinutes(date);
    // Per-activity estimate so the client can show "≈ 1,240 steps · 540 kcal".
    // Only meaningful for watch-off activities (otherwise the watch already counted it).
    const weightRow = await metricsStore.latest({ domain: 'health', metric: 'weight' }).catch(() => null);
    const estimate = no_watch
      ? estimateActivity({ type: activity_type, minutes: duration_min, weightLb: weightRow ? Number(weightRow.value) : undefined })
      : null;
    res.json({ activity: rows[0], estimate });
  }));

  // DELETE /api/activity/:id — remove a logged activity (mis-entry / undo).
  router.delete('/activity/:id', asyncHandler(async (req, res) => {
    const { rows } = await db.query('DELETE FROM activity_logs WHERE id = $1 RETURNING log_date', [req.params.id]);
    if (rows[0]) {
      const d = rows[0].log_date;
      const ds = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
      await syncActivityMinutes(ds);
    }
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createActivityRouter };
