// Habits router: the end-of-day habit stack (5 binary habits + eat-healthy
// 1-5 score), the eat-healthy AI-rating helper, gratitude reflections,
// streaks, and history. Ninth router extraction out of server.js's monolith
// (see the engineering review's #1+#6 recommendation) — a straight move,
// verified line-by-line against the original before removing it from
// server.js.
const express = require('express');
const db = require('../db');
const metricsStore = require('../store/metrics');
const sourcesStore = require('../store/sources');
const llm = require('../llm');
const { mapHabits, SOURCE: HABITS_SOURCE } = require('../ingest/habits');
const { recomputeHabitScore } = require('../intelligence/habit-score');
const mealLogsStore = require('../store/mealLogs');
const gratitudeLogsStore = require('../store/gratitudeLogs');
const { asyncHandler } = require('../middleware/asyncHandler');

function mealLogDateStr(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

function createHabitsRouter() {
  const router = express.Router();

  // End-of-day habit stack (5 binary habits + eat-healthy 1–5 → daily metrics).
  router.post('/habits', asyncHandler(async (req, res) => {
    await sourcesStore.registerSource({
      id: HABITS_SOURCE,
      domain: 'habits',
      displayName: 'Habit Stack',
    });
    const tz = process.env.TZ || 'America/New_York';
    const { metrics } = mapHabits(req.body, { ts: req.query.ts, tz });
    const written = await metricsStore.insertMetrics(metrics);
    // Recompute habit_score from ALL of today's persisted binary habits, so a
    // partial save (e.g. the workout panel toggling just `exercise`) keeps the
    // composite consistent with its components instead of leaving it stale.
    await recomputeHabitScore(tz);
    await sourcesStore.markSync(HABITS_SOURCE);
    // Unchecking the gratitude box must also clear today's reflection text —
    // otherwise a written-then-unchecked reflection survives in gratitude_logs
    // and the evening brief keeps echoing gratitude for a day marked incomplete.
    if (req.body?.gratitude === false) {
      await gratitudeLogsStore.upsert({ logDate: mealLogDateStr(tz), text: '' }).catch(() => {});
    }
    res.json({ written });
  }));

  // What you've already logged *today* (in your timezone), so the app can
  // pre-fill the habit stack instead of starting blank each time you open it.
  router.get('/habits/today', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const { rows } = await db.query(
      `SELECT metric, value FROM metrics
       WHERE domain = 'habits'
         AND (ts AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
       ORDER BY ts ASC`,
      [tz]
    );
    const v = {};
    for (const r of rows) v[r.metric] = Number(r.value); // latest wins
    res.json({
      logged: rows.length > 0,
      morningTM: v.morning_tm === 1,
      afternoonTM: v.afternoon_tm === 1,
      gratitude: v.gratitude === 1,
      coldShower: v.cold_shower === 1,
      exercise: v.exercise === 1,
      eatHealthy: Number.isFinite(v.eat_healthy) ? v.eat_healthy : null,
    });
  }));

  // Eating Healthy helper — "not sure how to rate today?" Log free-text of what
  // you ate/drank and get an AI-suggested 1-5 score + rationale. Applying the
  // suggestion still goes through the normal POST /api/habits eatHealthy field;
  // this only produces the suggestion and keeps the raw log for reference.
  router.get('/habits/eat-healthy/today', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const row = await mealLogsStore.getByDate(mealLogDateStr(tz));
    res.json({
      text: row?.text ?? '',
      score: row?.score ?? null,
      rationale: row?.rationale ?? null,
    });
  }));

  router.post('/habits/eat-healthy/score', asyncHandler(async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });

    const prompt = `Rate how healthy this day of eating was, on a 1-5 scale (1 = poor, 5 = excellent), based on what they logged eating and drinking:

"${text.slice(0, 2000)}"

Consider: whole/minimally-processed foods vs. ultra-processed or fast food, vegetables/fruit/fiber, protein adequacy, added sugar and alcohol, hydration, and portion reasonableness. This is about long-term health, not calorie-counting or weight loss.

Return ONLY valid JSON — no markdown, no explanation:
{"score": <integer 1-5>, "rationale": "<1-2 sentences, specific to what they actually logged, honest but encouraging>"}`;

    const raw = await llm.generateText({
      system: 'You help someone honestly assess how healthy a day of eating was, from their own free-text log. Return only valid JSON.',
      prompt,
      maxTokens: 250,
    });

    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'parse failed', raw: cleaned.slice(0, 300) });
    }

    const score = Math.max(1, Math.min(5, Math.round(Number(result.score))));
    const rationale = String(result.rationale || '').slice(0, 500);
    if (!Number.isFinite(score)) return res.status(500).json({ error: 'invalid score from model' });

    const tz = process.env.TZ || 'America/New_York';
    await mealLogsStore.upsert({ logDate: mealLogDateStr(tz), text, score, rationale });
    res.json({ score, rationale });
  }));

  // Gratitude reflection — turns the binary gratitude checkbox into an actual
  // practice: log one line of what you're grateful for. Saving a reflection also
  // marks the gratitude habit done (writing it IS doing it). The text is reflected
  // back in the evening wind-down brief so it isn't write-only.
  router.get('/habits/gratitude/today', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const row = await gratitudeLogsStore.getByDate(mealLogDateStr(tz));
    res.json({ text: row?.text ?? '' });
  }));

  router.post('/habits/gratitude', asyncHandler(async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    const tz = process.env.TZ || 'America/New_York';
    await gratitudeLogsStore.upsert({ logDate: mealLogDateStr(tz), text: text.slice(0, 1000) });

    // Writing a reflection counts as doing gratitude — mark the binary habit so
    // the two never drift out of sync (a saved reflection with an unchecked box).
    await sourcesStore.registerSource({ id: HABITS_SOURCE, domain: 'habits', displayName: 'Habit Stack' });
    const { metrics } = mapHabits({ gratitude: true }, { ts: req.query.ts, tz });
    await metricsStore.insertMetrics(metrics);
    await recomputeHabitScore(tz);
    await sourcesStore.markSync(HABITS_SOURCE);

    res.json({ ok: true });
  }));

  // Habit streaks — consecutive days (ending today or yesterday) where each habit
  // was logged with value >= 0.5. Covers the last 90 days.
  router.get('/habits/streaks', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const HABIT_METRICS = ['morning_tm', 'afternoon_tm', 'cold_shower', 'gratitude', 'exercise'];
    const { rows } = await db.query(
      // to_char → a 'YYYY-MM-DD' STRING; a bare ::date came back as a JS Date
      // whose String() ("Thu Jul 02 2026 …") never matched today/yesterday, so
      // every streak silently computed to 0 and no badge ever showed.
      `SELECT
         metric,
         to_char(date_trunc('day', ts AT TIME ZONE COALESCE($1, 'America/New_York'))::date, 'YYYY-MM-DD') AS day,
         AVG(value) AS val
       FROM metrics
       WHERE domain = 'habits'
         AND metric = ANY($2)
         AND source != 'seed'
         AND ts >= NOW() - INTERVAL '90 days'
       GROUP BY metric, date_trunc('day', ts AT TIME ZONE COALESCE($1, 'America/New_York'))::date
       ORDER BY metric, day DESC`,
      [tz, HABIT_METRICS]
    );

    // Group rows by metric (already newest-first from the ORDER BY).
    const byMetric = {};
    for (const r of rows) {
      (byMetric[r.metric] ||= []).push({ day: r.day, val: Number(r.val) });
    }

    // Today / yesterday in the SAME tz as the SQL day, as 'YYYY-MM-DD'.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const yesterday = require('../util/streak').prevDay(today);
    const { computeStreak } = require('../util/streak');

    res.json({
      streaks: {
        morningTM:    computeStreak(byMetric['morning_tm'], { today, yesterday }),
        afternoonTM:  computeStreak(byMetric['afternoon_tm'], { today, yesterday }),
        coldShower:   computeStreak(byMetric['cold_shower'], { today, yesterday }),
        gratitude:    computeStreak(byMetric['gratitude'], { today, yesterday }),
        exercise:     computeStreak(byMetric['exercise'], { today, yesterday }),
      },
    });
  }));

  // Per-habit adherence for the last N days as boolean arrays (oldest→newest), with
  // gaps filled false — drives the habit dot-rows. One round trip for all habits.
  router.get('/habits/history', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const days = Math.max(7, Math.min(Number(req.query.days) || 14, 60));
    const HABIT_METRICS = ['morning_tm', 'afternoon_tm', 'cold_shower', 'gratitude', 'exercise'];
    const { rows } = await db.query(
      // to_char → a guaranteed 'YYYY-MM-DD' STRING. node-postgres parses a bare
      // ::date into a JS Date, whose String() is "Thu Jul 02 2026 …" — slicing
      // that never matched the YYYY-MM-DD day axis, so every day read as a miss
      // and the adherence dots were always empty.
      `SELECT metric,
              to_char((ts AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day,
              AVG(value) AS val
         FROM metrics
        WHERE domain = 'habits' AND metric = ANY($2) AND source != 'seed'
          AND (ts AT TIME ZONE $1)::date > (now() AT TIME ZONE $1)::date - $3::int
        GROUP BY metric, (ts AT TIME ZONE $1)::date`,
      [tz, HABIT_METRICS, days]
    );
    const done = {}; // metric -> Set(YYYY-MM-DD where val>=0.5)
    for (const r of rows) {
      if (Number(r.val) >= 0.5) (done[r.metric] ||= new Set()).add(r.day);
    }
    // Build the contiguous day axis (oldest→newest) in the configured tz.
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const axis = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(`${todayStr}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - i);
      axis.push(d.toISOString().slice(0, 10));
    }
    const series = (metric) => axis.map((day) => done[metric]?.has(day) || false);
    res.json({
      days, axis,
      history: {
        morningTM: series('morning_tm'),
        afternoonTM: series('afternoon_tm'),
        coldShower: series('cold_shower'),
        gratitude: series('gratitude'),
        exercise: series('exercise'),
      },
    });
  }));

  return router;
}

module.exports = { createHabitsRouter };
