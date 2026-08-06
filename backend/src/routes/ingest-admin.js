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

  // /admin/reset-demo (deletes data), /admin/recompute-wealth, /admin/review-run,
  // and /ingest/run are powerful enough to warrant a separate admin token from
  // the general app token — /weather, /ingest/metrics, and /import/monarch stay
  // on the normal gate since they're routine data flow, not admin actions. See
  // src/middleware/adminAuth.js.
  router.use(['/admin/reset-demo', '/admin/recompute-wealth', '/admin/review-run', '/admin/cleanup-duplicate-transactions', '/ingest/run'], requireAdminToken);

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
    // Fire-and-forget: analyze() scans across every domain (not scoped by
    // `days`), so awaiting it here risked the SAME statement-timeout this
    // `days` scoping was added to avoid. The response no longer waits on it —
    // Insights picks up the refreshed numbers whenever it finishes.
    analyze().catch((e) => console.error('[recompute-wealth] analyze() failed:', e.message));
    res.json({ ...result, sinceDate: sinceDate || null, analyzed: 'started (async, not awaited)' });
  }));

  // Admin-gated alias for the weekly review generator (the general-token
  // POST /api/review/run already exists in routes/scheduling.js) — lets an
  // admin-token holder regenerate this week's review on demand, e.g. to
  // retry after a run landed on the parse-failure fallback, without needing
  // the general app token.
  router.post('/admin/review-run', asyncHandler(async (req, res) => {
    const { runReview } = require('../intelligence/review');
    res.json(await runReview());
  }));

  // One-time remediation for the Wealth double-counting production incident:
  // the SAME real transaction ended up stored as TWO `documents` rows under
  // different external_id schemes — one written by the current Monarch MCP
  // sync (`monarch:<numeric-id>`, the canonical/current scheme) and one
  // stale row from an older write path (a bare content-hash or legacy id,
  // no "monarch:" prefix) that reconcile/prune should have removed but
  // didn't. discretionarySpend.js's aggregation deliberately never
  // deduplicates by day/merchant/amount (a prior fix protects two
  // genuinely separate same-day purchases at the same merchant from being
  // collapsed), so every such pair silently doubled its category's spend.
  //
  // Deliberately narrow: only deletes a NON-canonical row when a canonical
  // `monarch:<digits>` sibling exists with the IDENTICAL occurred_at date,
  // category, amount, merchant, and account — a standalone transaction
  // that merely shares those fields with nothing else is never touched,
  // and a genuine same-day/same-amount duplicate purchase is only removed
  // if it also happens to collide with a canonical-scheme id (vanishingly
  // unlikely for anything that isn't actually the same transaction).
  // Defaults to a dry run (reports what WOULD be deleted); pass
  // ?apply=1 to actually delete.
  router.post('/admin/cleanup-duplicate-transactions', asyncHandler(async (req, res) => {
    const apply = req.query.apply === '1' || req.query.apply === 'true';
    const findDuplicatesSql = `
      WITH tagged AS (
        SELECT id, external_id, occurred_at::date::text AS day,
               metadata->>'category' AS category,
               (metadata->>'amount')::numeric AS amount,
               lower(coalesce(metadata->>'merchant', '')) AS merchant,
               lower(coalesce(metadata->>'account', '')) AS account,
               (external_id ~ '^monarch:[0-9]+$') AS is_canonical
          FROM documents
         WHERE source = 'monarch' AND external_id IS NOT NULL
      ),
      dupe_keys AS (
        SELECT day, category, amount, merchant, account
          FROM tagged
         GROUP BY day, category, amount, merchant, account
        HAVING count(*) FILTER (WHERE is_canonical) >= 1
           AND count(*) FILTER (WHERE NOT is_canonical) >= 1
      )
      SELECT t.id, t.external_id, t.day, t.category, t.amount, t.merchant, t.account
        FROM tagged t
        JOIN dupe_keys k USING (day, category, amount, merchant, account)
       WHERE NOT t.is_canonical
       ORDER BY t.day, t.category`;
    const { rows: toDelete } = await db.query(findDuplicatesSql);
    const totalAmount = Math.round(toDelete.reduce((a, r) => a - Number(r.amount), 0) * 100) / 100;

    let deleted = 0;
    if (apply && toDelete.length) {
      const { rowCount } = await db.query(
        `DELETE FROM documents WHERE id = ANY($1::uuid[])`,
        [toDelete.map((r) => r.id)]
      );
      deleted = rowCount;
    }
    res.json({
      apply,
      candidateCount: toDelete.length,
      candidateTotalAmount: totalAmount,
      deleted,
      candidates: toDelete,
    });
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

    // A Monarch CSV export carries no transaction id, so mapTransactions
    // falls back to a content hash — an external_id that can never collide
    // with the `monarch:<id>` rows the API sync already wrote. Re-importing a
    // period therefore inserted a SECOND copy of every transaction already
    // held, and unlike the API sync this path runs no reconcile/prune to undo
    // it. That is exactly how 203 duplicate rows appeared in one batch and
    // doubled every Wealth category total. Skip any hash-id document whose
    // transaction is already stored canonically; rows genuinely new to us
    // still import normally.
    let skippedDuplicates = 0;
    let toWrite = documents;
    const days = documents.map((d) => String(d.occurredAt ?? '').slice(0, 10)).filter(Boolean).sort();
    if (days.length) {
      try {
        const canonical = await documentsStore.canonicalMonarchFingerprints({
          fromYmd: days[0], toYmd: days[days.length - 1],
        });
        ({ kept: toWrite, skipped: skippedDuplicates } = documentsStore.withoutAlreadyCanonical(documents, canonical));
      } catch (err) {
        // Best-effort: on a lookup failure import everything rather than drop
        // data — the read-time guard still keeps totals correct.
        console.error('[import/monarch] duplicate pre-check failed, importing all rows:', err.message);
      }
    }

    let docs = 0;
    for (const doc of toWrite) {
      if (await documentsStore.upsertDocument(doc)) docs++;
    }
    await sourcesStore.markSync('monarch');
    const summary = await analyze();
    res.json({ kind, rows, metrics: written, documents: docs, skippedDuplicates, analyzed: summary || null });
  }));

  return router;
}

module.exports = { createIngestAdminRouter };
