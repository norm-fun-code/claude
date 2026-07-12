// Ingest/admin router: standalone weather (with its own short-TTL cache),
// generic metric ingestion, the connector-trigger endpoint, demo-data reset,
// wealth-flow recompute, and Monarch CSV upload. Sixteenth router extraction
// out of server.js's monolith (see the engineering review's #1+#6
// recommendation) — a straight move, verified line-by-line against the
// original before removing it from server.js.
const express = require('express');
const db = require('../db');
const metricsStore = require('../store/metrics');
const sourcesStore = require('../store/sources');
const documentsStore = require('../store/documents');
const monarch = require('../connectors/monarch');
const { fetchWeather } = require('../services/weather');
const { runIngest } = require('../ingest/run');
const { analyze } = require('../intelligence/analyze');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAdminToken } = require('../middleware/adminAuth');

function createIngestAdminRouter() {
  const router = express.Router();

  // /admin/reset-demo (deletes data), /admin/recompute-wealth, and /ingest/run
  // are powerful enough to warrant a separate admin token from the general app
  // token — /weather, /ingest/metrics, and /import/monarch stay on the normal
  // gate since they're routine data flow, not admin actions. See
  // src/middleware/adminAuth.js.
  router.use(['/admin/reset-demo', '/admin/recompute-wealth', '/ingest/run'], requireAdminToken);

  // Standalone weather — so the Today card can show/refresh weather on its own,
  // fast, without waiting on the full LLM briefing. Cached briefly in-memory so
  // repeated loads (and the briefing) don't hammer the provider; ?refresh=1
  // forces a fresh pull.
  let weatherCache = { at: 0, data: null };
  const WEATHER_TTL_MS = Number(process.env.WEATHER_CACHE_MS || 10 * 60 * 1000);
  router.get('/weather', asyncHandler(async (req, res) => {
    try {
      const force = req.query.refresh === '1';
      const fresh = Date.now() - weatherCache.at < WEATHER_TTL_MS;
      if (!force && fresh && weatherCache.data) {
        return res.json({ weather: weatherCache.data, cached: true });
      }
      const weather = await fetchWeather();
      weatherCache = { at: Date.now(), data: weather };
      res.json({ weather, cached: false });
    } catch (err) {
      // Fall back to a stale cached value rather than failing the card outright.
      if (weatherCache.data) return res.json({ weather: weatherCache.data, cached: true, stale: true });
      throw err;
    }
  }));

  // Generic canonical metric ingestion for any future source.
  router.post('/ingest/metrics', asyncHandler(async (req, res) => {
    const written = await metricsStore.insertMetrics(req.body);
    res.json({ written });
  }));

  // Trigger all server-side connectors on demand. ?full=1 forces a complete
  // re-sync (ignores each source's last-sync timestamp).
  router.post('/ingest/run', asyncHandler(async (req, res) => {
    const full = req.query.full === '1' || req.query.full === 'true';
    const only = req.query.only || null;
    res.json({ results: await runIngest({ full, only }) });
  }));

  // Retire the demo data once real sources are flowing — deletes exactly what the
  // seeder created (source='seed' metrics + seed-tagged goals) and re-analyzes.
  router.post('/admin/reset-demo', asyncHandler(async (req, res) => {
    const m = await db.query(`DELETE FROM metrics WHERE source = 'seed'`);
    const g = await db.query(`DELETE FROM goals WHERE metadata->>'seed' = 'true'`);
    await db.query(`DELETE FROM sources WHERE id = 'seed'`);
    const summary = await analyze();
    res.json({ deletedMetrics: m.rowCount, deletedGoals: g.rowCount, analyzed: summary || null });
  }));

  // Rebuild the daily wealth flow metrics from stored Monarch transactions with
  // the current rules (excludes internal transfers / card payments). The sync
  // skips unchanged CSVs, so this is how historical spending gets corrected
  // without re-uploading. Re-runs analyze() so Insights reflect the new numbers.
  // ?days=N scopes the rebuild to the last N days (both the document read and
  // the metric delete) instead of the full stored history — an unbounded scan
  // of a long-lived documents table can exceed the DB's statement timeout;
  // bound it when only recent drift needs correcting.
  router.post('/admin/recompute-wealth', asyncHandler(async (req, res) => {
    const { recomputeWealthFlows } = require('../services/recompute-wealth');
    const days = req.query.days ? Math.min(Number(req.query.days) || 0, 3650) : null;
    const tz = process.env.TZ || 'America/New_York';
    const sinceDate = days
      ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: tz })
      : undefined;
    const result = await recomputeWealthFlows({ sinceDate });
    const analyzed = await analyze().catch((e) => ({ error: e.message }));
    res.json({ ...result, sinceDate: sinceDate || null, analyzed: analyzed || null });
  }));

  // Monarch CSV upload: POST the raw CSV body (transactions OR balances export).
  // The cloud can't see files on your Mac, so this is how the monthly export
  // reaches it — `curl --data-binary @export.csv`. Idempotent: re-uploading the
  // same month overwrites the same daily metrics rather than double-counting.
  router.post('/import/monarch', express.text({ type: '*/*', limit: '25mb' }), asyncHandler(async (req, res) => {
    const text = typeof req.body === 'string' ? req.body : '';
    if (!text.trim()) return res.status(400).json({ error: 'send the CSV as the request body' });
    const { kind, rows, metrics, documents } = monarch.importText(text);
    if (kind === 'unknown') {
      return res.status(422).json({ error: 'could not recognize this as a Monarch transactions or balances export', rows });
    }
    await sourcesStore.registerSource({ id: 'monarch', domain: 'wealth', displayName: 'Monarch (CSV import)' });
    const written = await metricsStore.insertMetrics(metrics);
    let docs = 0;
    for (const doc of documents) {
      if (await documentsStore.upsertDocument(doc)) docs++;
    }
    await sourcesStore.markSync('monarch');
    const summary = await analyze();
    res.json({ kind, rows, metrics: written, documents: docs, analyzed: summary || null });
  }));

  return router;
}

module.exports = { createIngestAdminRouter };
