// Check-in router: daily subjective check-in (mood/energy/focus + optional
// journal note), its history, today's rehydration read, and the weekly
// review history panel (grouped here since it sits inline with checkin in
// the original file, with no section divider of its own). Eighth router
// extraction out of server.js's monolith (see the engineering review's
// #1+#6 recommendation) — a straight move, verified line-by-line against
// the original before removing it from server.js.
const express = require('express');
const db = require('../db');
const metricsStore = require('../store/metrics');
const sourcesStore = require('../store/sources');
const documentsStore = require('../store/documents');
const briefingsStore = require('../store/briefings');
const { mapCheckin, SOURCE: CHECKIN_SOURCE } = require('../ingest/checkin');
const { asyncHandler } = require('../middleware/asyncHandler');

function createCheckinRouter() {
  const router = express.Router();

  // Daily subjective check-in (mood / energy / focus + optional journal note).
  router.post('/checkin', asyncHandler(async (req, res) => {
    await sourcesStore.registerSource({
      id: CHECKIN_SOURCE,
      domain: 'wellbeing',
      displayName: 'Daily Check-in',
    });
    const tz = process.env.TZ || 'America/New_York';
    const { metrics, document } = mapCheckin(req.body, { ts: req.query.ts, tz });
    const written = await metricsStore.insertMetrics(metrics);
    if (document) await documentsStore.upsertDocument(document);
    await sourcesStore.markSync(CHECKIN_SOURCE);
    // Same-day reaction to a rough check-in (fire-and-forget, mirrors the
    // health-ingest -> runWatch pattern): a low mood/energy/focus rating gets
    // a supportive downshift nudge within the minute, instead of the system
    // sitting silent until tomorrow's brief.
    require('../intelligence/watch')
      .watchWellbeing({ mood: req.body?.mood, energy: req.body?.energy, focus: req.body?.focus })
      .catch((e) => console.error('[checkin] wellbeing watch failed:', e.message));
    res.json({ written, journaled: Boolean(document) });
  }));

  // Last N days of check-in data (mood / energy / focus per day) for the
  // history card on the Insights tab. Returns days sorted oldest-first so
  // the mobile chart can render them left-to-right without reversing.
  router.get('/checkin/history', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const days = Math.min(Number(req.query.days) || 30, 90);
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { rows } = await db.query(
      `SELECT
         (ts AT TIME ZONE $1)::date AS day,
         metric,
         AVG(value) AS value
       FROM metrics
       WHERE domain = 'wellbeing' AND source = 'checkin'
         AND metric = ANY($2)
         AND ts >= $3
       GROUP BY (ts AT TIME ZONE $1)::date, metric
       ORDER BY day ASC`,
      [tz, ['mood', 'energy', 'focus'], from]
    );
    // Pivot: [{day, mood, energy, focus}]
    const byDay = new Map();
    for (const r of rows) {
      const d = r.day.toISOString().slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, { date: d });
      byDay.get(d)[r.metric] = Math.round(Number(r.value) * 10) / 10;
    }
    res.json({ days: [...byDay.values()] });
  }));

  // Last N weekly review briefings — for the history panel on the Insights tab.
  router.get('/briefings/history', asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 8, 20);
    const kind = req.query.kind || 'weekly';
    const rows = await briefingsStore.listBriefings({ kind, limit });
    res.json({ reviews: rows.map((r) => ({ content: r.content, generatedAt: r.generated_at })) });
  }));

  // What you've already checked in *today* (your timezone), so the card can
  // rehydrate after a tab switch / reopen and reset cleanly at midnight.
  router.get('/checkin/today', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    const [metricsResult, noteResult] = await Promise.all([
      db.query(
        `SELECT metric, value FROM metrics
          WHERE domain = 'wellbeing' AND source = 'checkin'
            AND (ts AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
          ORDER BY ts ASC`,
        [tz]
      ),
      db.query(
        `SELECT content FROM documents WHERE source = 'checkin' AND external_id = $1 LIMIT 1`,
        [`note:${today}`]
      ),
    ]);
    const v = {};
    for (const r of metricsResult.rows) v[r.metric] = Number(r.value);
    res.json({
      logged: metricsResult.rows.length > 0,
      mood: Number.isFinite(v.mood) ? v.mood : null,
      energy: Number.isFinite(v.energy) ? v.energy : null,
      focus: Number.isFinite(v.focus) ? v.focus : null,
      note: noteResult.rows[0]?.content ?? null,
    });
  }));

  return router;
}

module.exports = { createCheckinRouter };
