// Workout router: per-exercise checkmarks, manual day-swap overrides,
// strength progression, and per-set workout logs. Sixth router extraction
// out of server.js's monolith (see the engineering review's #1+#6
// recommendation) — a straight move, verified line-by-line against the
// original before removing it from server.js.
const express = require('express');
const db = require('../db');
const workoutChecks = require('../store/workoutChecks');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireFields } = require('../middleware/validate');
const { VALID_WORKOUT_IDS, setWorkoutOverride, setWorkoutCompletion } = require('../services/workout');

// Manual per-day workout swaps. GET returns a date→workoutId map across a range
// (so the week strip can show swapped days); POST sets one day (empty/null
// workoutId reverts that day to the scheduled split).

function createWorkoutRouter() {
  const router = express.Router();

  // Per-exercise / non-negotiable workout checkmarks. Like the check-in, each tap
  // saves immediately and the app rehydrates the day's checks on mount. The client
  // owns the local date (?date=YYYY-MM-DD, ET) so it matches the workout strip.
  router.get('/workout/checks', asyncHandler(async (req, res) => {
    const date = req.query.date;
    if (!requireFields(req.query, ['date'], res)) return;
    res.json({ date, checks: await workoutChecks.getChecks(date) });
  }));

  router.post('/workout/checks', asyncHandler(async (req, res) => {
    const { date, itemKey, itemType, done } = req.body || {};
    if (!requireFields(req.body, ['date', 'itemKey'], res)) return;
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
    if (!requireFields(req.body, ['date'], res)) return;
    if (workoutId && !VALID_WORKOUT_IDS.has(workoutId)) return res.status(400).json({ error: 'invalid workoutId' });
    // Transactional Brain Invalidation (audit recommendation #2), item 4: the
    // write + invalidation both live in services/workout.js's
    // setWorkoutOverride now — the SAME function Ask/realtime voice
    // (chat/executeAction.js) and the rest-day-commitment helper call, so
    // every workout-override write path is identical instead of three
    // near-duplicate upsert+invalidate implementations.
    const result = await setWorkoutOverride({ date, workoutId: workoutId || null });
    res.json({ ok: true, ...result });
  }));

  // Explicit workout-level completion — distinct from the generic Exercise
  // habit (POST /api/habits), which only proves SOME exercise occurred, never
  // WHICH workout. GET returns a date→completion map across a range (so the
  // week strip's checkmarks hydrate from explicit records, never from
  // /api/habits/today's bare exercise boolean); POST sets/clears the day's
  // record. See services/workout.js's setWorkoutCompletion/
  // resolveTrainingOutcome for the full authority these routes front.
  router.get('/workout/completions', asyncHandler(async (req, res) => {
    const { from = null, to = null } = req.query;
    const { rows } = await db.query(
      `SELECT to_char(log_date, 'YYYY-MM-DD') AS day, workout_id, source, completed_at
         FROM workout_completions
        WHERE ($1::date IS NULL OR log_date >= $1)
          AND ($2::date IS NULL OR log_date <= $2)`,
      [from, to]
    );
    const completions = {};
    for (const r of rows) {
      completions[r.day] = { workoutId: r.workout_id, source: r.source, completedAt: r.completed_at };
    }
    res.json({ completions });
  }));

  // POST /api/workout/completion — body: { date, workoutId }. `workoutId`
  // null/falsy CLEARS the explicit completion record for that date (the
  // "unmark" path) rather than completing it. "Mark as complete" on the
  // client sends the workout currently displayed (workout.id) — the same
  // effective workout getEffectiveWorkout resolves for that date — so this
  // always writes/removes completion for THE workout on screen, never an
  // arbitrary id.
  router.post('/workout/completion', asyncHandler(async (req, res) => {
    const { date, workoutId } = req.body || {};
    if (!requireFields(req.body, ['date'], res)) return;
    if (workoutId && !VALID_WORKOUT_IDS.has(workoutId)) return res.status(400).json({ error: 'invalid workoutId' });
    const result = await setWorkoutCompletion({ date, workoutId: workoutId || null, source: 'manual' });
    res.json({ ok: true, ...result });
  }));

  // GET /api/workout/progression?exercise=A&exercise=B&limit=10 — per-exercise
  // progression over recent sessions. For each session it computes estimated 1RM
  // (Epley: w × (1 + reps/30), best set) and total volume (Σ reps × weight), then
  // the trend across the window. Powers the post-session "Strength progression"
  // card. Bodyweight-only exercises fall back to total reps as the trend metric.
  router.get('/workout/progression', asyncHandler(async (req, res) => {
    const { exercise, limit = 10 } = req.query;
    if (!requireFields(req.query, ['exercise'], res)) return;
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
    if (!requireFields(req.body, ['day', 'exercise', 'set_number'], res)) return;
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
    if (!requireFields(req.query, ['exercise'], res)) return;
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

module.exports = { createWorkoutRouter };
