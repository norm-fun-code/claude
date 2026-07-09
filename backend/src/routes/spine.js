// "Querying the spine" router: raw metric series/history, source freshness,
// findings, daily Readwise highlights, and the on-demand analyze/consolidate/
// embed triggers. Thirteenth router extraction out of server.js's monolith
// (see the engineering review's #1+#6 recommendation) — a straight move,
// verified line-by-line against the original before removing it from
// server.js.
const express = require('express');
const db = require('../db');
const metricsStore = require('../store/metrics');
const findingsStore = require('../store/findings');
const documentsStore = require('../store/documents');
const surfacedStore = require('../store/surfaced');
const dailyPicksStore = require('../store/dailyPicks');
const sourcesStore = require('../store/sources');
const { analyze } = require('../intelligence/analyze');
const { embedPending } = require('../intelligence/embeddings');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireFields } = require('../middleware/validate');

function createSpineRouter() {
  const router = express.Router();

  router.get('/sources', asyncHandler(async (req, res) => {
    res.json({ sources: await sourcesStore.listSources() });
  }));

  // GET /api/metrics?domain=health&metric=hrv&from=...&to=...&agg=avg
  router.get('/metrics', asyncHandler(async (req, res) => {
    const { domain, metric, from, to, agg } = req.query;
    if (!requireFields(req.query, ['domain', 'metric'], res)) return;
    const series = agg
      ? await metricsStore.dailyAggregate({ domain, metric, from, to, agg })
      : await metricsStore.getSeries({ domain, metric, from, to });
    res.json({ domain, metric, series });
  }));

  // GET /api/sources/freshness — most recent DATA date per key source, so the app
  // can show "Eight Sleep: last night / 3 days behind" and catch a missed sync.
  // Metrics are anchored at noon-UTC of their data date, so the UTC date of the
  // latest row IS the day the data covers (not the sync clock time).
  router.get('/sources/freshness', asyncHandler(async (req, res) => {
    const LABELS = { eight_sleep: 'Eight Sleep', apple_health: 'Apple Watch', monarch: 'Finances' };
    const { rows } = await db.query(
      `SELECT source, to_char(max(ts) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date
         FROM metrics WHERE source = ANY($1) GROUP BY source`,
      [Object.keys(LABELS)]
    );
    const todayUtc = new Date().toISOString().slice(0, 10);
    const ageDays = (d) => Math.round((new Date(todayUtc + 'T00:00:00Z') - new Date(d + 'T00:00:00Z')) / 86400000);
    const sources = rows
      .map((r) => ({ source: r.source, label: LABELS[r.source], date: r.date, ageDays: ageDays(r.date) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    res.json({ sources });
  }));

  // GET /api/metrics/history?metric=hrv&days=60
  // Returns the last N days of raw readings for a single metric, ordered oldest
  // to newest. Used by charts that need the full time-series (not aggregated).
  router.get('/metrics/history', asyncHandler(async (req, res) => {
    const { metric, days, source } = req.query;
    if (!requireFields(req.query, ['metric'], res)) return;
    const numDays = Math.max(1, Number(days) || 60);
    const params = [metric, String(numDays)];
    let sourceClause = '';
    if (source) { params.push(source); sourceClause = `AND source = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT ts, value FROM metrics
       WHERE metric = $1
         AND ts >= now() - ($2 || ' days')::interval
         ${sourceClause}
       ORDER BY ts ASC`,
      params
    );
    res.json({ rows: rows.map((r) => ({ ts: r.ts, value: Number(r.value) })) });
  }));

  router.get('/findings', asyncHandler(async (req, res) => {
    res.json({ findings: await findingsStore.listFindings({ status: req.query.status }) });
  }));

  // Daily Readwise highlights for the Wisdom tab card. Favorites-first, filling
  // with random ones if you've hearted few. Won't repeat a highlight shown in the
  // last 30 days (tracked in `surfaced`). DAY-LOCKED: the first request of the day
  // picks the set and caches it (daily_picks), so it stays identical all day
  // across devices and pull-to-refresh — like the Notion page / daily quote.
  // `?refresh=1` forces a fresh set (the "New set" button).
  router.get('/highlights', asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 5, 20));
    const favoritesOnly = req.query.favoritesOnly === '1' || req.query.favoritesOnly === 'true';
    const force = req.query.refresh === '1' || req.query.refresh === 'true';

    // Return today's locked set unless an explicit refresh was requested.
    if (!force) {
      const cached = await dailyPicksStore.get('highlights').catch(() => null);
      if (cached && Array.isArray(cached) && cached.length) {
        return res.json({ highlights: cached });
      }
    }

    const seen = await surfacedStore.recentRefs('highlight', 30);
    const rows = await documentsStore.randomHighlights({ limit, favoritesOnly, exclude: [...seen] });
    if (rows.length) await surfacedStore.record('highlight', rows.map((r) => r.id));
    const highlights = rows.map((r) => ({
      id: r.id,
      text: r.content,
      title: r.title,
      author: r.author,
      url: r.url,
      favorite: !!(r.metadata && r.metadata.favorite),
    }));

    // Lock this set as today's pick (force → replace; otherwise set-if-absent so
    // two same-day first-hits don't diverge).
    if (highlights.length) {
      const stored = force
        ? await dailyPicksStore.replace('highlights', highlights).catch(() => highlights)
        : await dailyPicksStore.set('highlights', highlights).catch(() => highlights);
      return res.json({ highlights: stored });
    }
    res.json({ highlights });
  }));

  // Run the intelligence layer (trends + correlations) on demand.
  router.post('/analyze', asyncHandler(async (req, res) => {
    const result = await analyze();
    // Regenerate cross-context insights from the fresh findings so "Re-run analysis"
    // immediately reflects updated correlations (not just the nightly scheduler run).
    require('../intelligence/crossContext').generateCrossContext()
      .catch((e) => console.error('[analyze] crossContext regen failed:', e.message));
    res.json(result);
  }));

  // Rebuild the self-model from today's data — normally runs nightly at 9:30pm,
  // but POST here to regenerate on demand (after a check-in, post-backfill, etc.).
  router.post('/consolidate', asyncHandler(async (req, res) => {
    const { consolidate } = require('../intelligence/consolidate');
    const content = await consolidate({ kind: 'manual' });
    res.json({ ok: true, length: content.length, preview: content.slice(0, 200) });
  }));

  // Read the current self-model back — the full portrait NormOS injects into every
  // voice surface. Returns the latest consolidated model (content + when + snapshot).
  router.get('/consolidate', asyncHandler(async (req, res) => {
    const row = await require('../store/selfModel').latestModel();
    if (!row) return res.json({ ok: true, model: null, message: 'No self-model yet — POST /api/consolidate to build one.' });
    res.json({ ok: true, generatedAt: row.generated_at, kind: row.kind, content: row.content, snapshot: row.snapshot });
  }));

  // Backfill embeddings for the knowledge graph / chat retrieval.
  router.post('/embed', asyncHandler(async (req, res) => {
    res.json(await embedPending());
  }));

  return router;
}

module.exports = { createSpineRouter };
