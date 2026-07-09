// Recommendations router: per-connector pipeline-health/staleness check, and
// the recommendation ledger (surfaced leverage actions + outcome tracking).
// Twenty-fourth router extraction out of server.js's monolith (see the
// engineering review's #1+#6 recommendation) — a straight move, verified
// line-by-line against the original before removing it from server.js.
const express = require('express');
const sourcesStore = require('../store/sources');
const recommendationsStore = require('../store/recommendations');
const { asyncHandler } = require('../middleware/asyncHandler');
const { STALE_THRESHOLDS_H, sourceStaleness, getMonarchHealth } = require('../intelligence/source-health');

function createRecommendationsRouter() {
  const router = express.Router();

  // Pipeline health — per-connector freshness + staleness status. The authoritative
  // version of the stale check that also runs silently inside the briefing build
  // (both now read the same src/intelligence/source-health.js config). Useful for
  // debugging "why is my briefing citing old numbers?"
  router.get('/pipeline-health', asyncHandler(async (req, res) => {
    const sources = await sourcesStore.listSources();
    const now = Date.now();
    const connectors = sources.map((s) => {
      const { hoursAgo, isStale, thresholdHours, label } = sourceStaleness(s, now);
      return {
        id: s.id,
        displayName: s.display_name,
        domain: s.domain,
        status: s.status ?? 'unknown',
        lastSyncAt: s.last_sync_at ?? null,
        lastError: s.last_error ?? null,
        hoursAgo: hoursAgo != null ? Math.round(hoursAgo * 10) / 10 : null,
        staleThresholdHours: thresholdHours,
        isStale,
        criticalFor: label,
      };
    });
    const stale = connectors.filter((c) => c.isStale && STALE_THRESHOLDS_H[c.id]);
    res.json({
      connectors,
      anyStale: stale.length > 0,
      staleSummary: stale.length
        ? `${stale.length} source(s) stale: ${stale.map((c) => c.displayName || c.id).join(', ')}`
        : 'All monitored sources are fresh.',
      checkedAt: new Date().toISOString(),
      // The single "is wealth data healthy" signal (review's #8) — wealth data
      // can come from up to two independently-tracked connectors (monarch,
      // monarch_mcp_sync), so neither row alone answers this; healthy if
      // EITHER is fresh (mirrors the fallback relationship between them).
      monarch: getMonarchHealth(sources, now),
    });
  }));

  // Recommendation ledger — what leverage actions have been surfaced + outcome data.
  // GET /api/recommendations?limit=50&since=YYYY-MM-DD&pending=1
  router.get('/recommendations', asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const since = req.query.since ? new Date(req.query.since) : null;
    const rows = await recommendationsStore.listRecommendations({ limit, since });
    // Summary stats for the weekly review "What I Tried" view.
    const measured = rows.filter((r) => r.outcome_measured_at != null);
    const positive = measured.filter((r) => {
      if (r.outcome_delta == null) return false;
      return r.expected_direction === 'down'
        ? Number(r.outcome_delta) < 0
        : Number(r.outcome_delta) > 0;
    });
    res.json({
      recommendations: rows,
      stats: {
        total: rows.length,
        measured: measured.length,
        positive: positive.length,
        hitRate: measured.length ? Math.round((positive.length / measured.length) * 100) : null,
      },
    });
    // Background: auto-measure outcomes for any pending recs with enough elapsed time.
    recommendationsStore.measureOutcomes().catch(() => {});
  }));

  // POST /api/recommendations/:id/outcome — explicit thumbs-up/down from the user.
  router.post('/recommendations/:id/outcome', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { thumbsUp } = req.body;
    if (typeof thumbsUp !== 'boolean') return res.status(400).json({ error: 'thumbsUp required' });
    const { query: dbQuery } = require('../db');
    const { rows } = await dbQuery('SELECT expected_direction FROM recommendations WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const { expected_direction } = rows[0];
    // thumbsUp = true means "it worked as expected"; delta sign follows expected direction.
    const delta = thumbsUp
      ? (expected_direction === 'down' ? -1 : 1)
      : (expected_direction === 'down' ? 1 : -1);
    // First verdict wins — a rec resolved via a linked commitment's done/skipped
    // cascade won't be silently overwritten by a later thumbs tap (or vice versa).
    const applied = await recommendationsStore.setOutcome(id, { delta, measuredAt: new Date() });
    res.json({ ok: true, delta, applied });
  }));

  router.delete('/recommendations/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { query: dbQuery } = require('../db');
    const { rowCount } = await dbQuery('DELETE FROM recommendations WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createRecommendationsRouter };
