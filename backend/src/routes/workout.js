// Workout router: per-exercise checkmarks, manual day-swap overrides,
// strength progression, and per-set workout logs. Sixth router extraction
// out of server.js's monolith (see the engineering review's #1+#6
// recommendation) — a straight move, verified line-by-line against the
// original before removing it from server.js.
const express = require('express');
const db = require('../db');
const workoutChecks = require('../store/workoutChecks');
const { asyncHandler } = require('../middleware/asyncHandler');

// Manual per-day workout swaps. GET returns a date→workoutId map across a range
// (so the week strip can show swapped days); POST sets one day (empty/null
// workoutId reverts that day to the scheduled split).
const VALID_WORKOUT_IDS = new Set(['push', 'pull', 'zone2', 'mobility', 'intervals', 'rest']);

function createWorkoutRouter() {
  const router = express.Router();

  // Per-exercise / non-negotiable workout checkmarks. Like the check-in, each tap
  // saves immediately and the app rehydrates the day's checks on mount. The client
  // owns the local date (?date=YYYY-MM-DD, ET) so it matches the workout strip.
  router.get('/workout/checks', asyncHandler(async (req, res) => {
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
    res.json({ date, checks: await workoutChecks.getChecks(date) });
  }));

  router.post('/workout/checks', asyncHandler(async (req, res) => {
    const { date, itemKey, itemType, done } = req.body || {};
    if (!date || !itemKey) return res.status(400).json({ error: 'date and itemKey are required' });
    await workoutChecks.setCheck({ date, itemKey, itemType, done: done !== false });
    res.json({ ok: true });
  }));

  router.get('/workout/overrides', asyncHandler(async (req, res) => {
    const { from = null, to = null } = req.query;
    const { rows } = await db.query(
      `SELECT to_char(log_date, 'YYYY-MM-DD') AS day, workout_id FROM workout_overrides
        WHERE ($1::date IS NULL OR log_date >= $1)
          AND ($2::date IS NULL OR log_date <= $2)`,
      [from, to]
    );
    const overrides = {};
    for (const r of rows) overrides[r.day] = r.workout_id;
    res.json({ overrides });
  }));

  router.post('/workout/override', asyncHandler(async (req, res) => {
    const { date, workoutId } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!workoutId) {
      await db.query('DELETE FROM workout_overrides WHERE log_date = $1', [date]);
      return res.json({ ok: true, date, workoutId: null });
    }
    if (!VALID_WORKOUT_IDS.has(workoutId)) return res.status(400).json({ error: 'invalid workoutId' });
    await db.query(
      `INSERT INTO workout_overrides (log_date, workout_id) VALUES ($1, $2)
       ON CONFLICT (log_date) DO UPDATE SET workout_id = EXCLUDED.workout_id, created_at = now()`,
      [date, workoutId]
    );
    res.json({ ok: true, date, workoutId });
  }));

  // GET /api/workout/progression?exercise=A&exercise=B&limit=10 — per-exercise
  // progression over recent sessions. For each session it computes estimated 1RM
  // (Epley: w × (1 + reps/30), best set) and total volume (Σ reps × weight), then
  // the trend across the window. Powers the post-session "Strength progression"
  // card. Bodyweight-only exercises fall back to total reps as the trend metric.
  router.get('/workout/progression', asyncHandler(async (req, res) => {
    const { exercise, limit = 10 } = req.query;
    if (!exercise) return res.status(400).json({ error: 'exercise required' });
    const names = Array.isArray(exercise) ? exercise : [exercise];
    const lim = Math.min(Math.max(Number(limit) || 10, 2), 30);
    const { fetchProgression } = require('../intelligence/strength-progression');
    res.json({ progression: await fetchProgression(names, lim) });
  }));

  // Per-set workout logs — actual reps and weight performed, for progressive
  // overload tracking and auto-population of "last session" data.

  // GET /api/workout/log?day=YYYY-MM-DD — fetch all logged sets for a given day.
  router.get('/workout/log', asyncHandler(async (req, res) => {
    const day = req.query.day || new Date().toISOString().slice(0, 10);
    const { rows } = await db.query(
      `SELECT exercise, set_number, reps, weight_lbs, note
       FROM workout_logs WHERE log_date = $1
       ORDER BY exercise, set_number`, [day]
    );
    res.json({ logs: rows });
  }));

  // POST /api/workout/log — upsert a single set.
  router.post('/workout/log', asyncHandler(async (req, res) => {
    const { day, exercise, set_number, reps, weight_lbs, note = null } = req.body;
    if (!day || !exercise || set_number == null) return res.status(400).json({ error: 'day, exercise, set_number required' });
    await db.query(
      `INSERT INTO workout_logs (log_date, exercise, set_number, reps, weight_lbs, note, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (log_date, exercise, set_number) DO UPDATE
         SET reps = EXCLUDED.reps, weight_lbs = EXCLUDED.weight_lbs,
             note = EXCLUDED.note, updated_at = now()`,
      [day, exercise, set_number, reps ?? null, weight_lbs ?? null, note]
    );
    res.json({ ok: true });
  }));

  // GET /api/workout/log/history?exercise=NAME&limit=5 — last N sessions for an
  // exercise, each with all its sets. Powers the "Last time: 3×12 @ 45 lbs" display.
  router.get('/workout/log/history', asyncHandler(async (req, res) => {
    const { exercise, limit = 5 } = req.query;
    if (!exercise) return res.status(400).json({ error: 'exercise required' });
    const { rows } = await db.query(
      `SELECT log_date, json_agg(
         json_build_object('set_number', set_number, 'reps', reps, 'weight_lbs', weight_lbs)
         ORDER BY set_number
       ) AS sets
       FROM workout_logs
       WHERE exercise = $1
       GROUP BY log_date
       ORDER BY log_date DESC
       LIMIT $2`,
      [exercise, parseInt(limit)]
    );
    res.json({ history: rows });
  }));

  return router;
}

module.exports = { createWorkoutRouter, VALID_WORKOUT_IDS };
