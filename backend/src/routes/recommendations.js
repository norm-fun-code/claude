// Recommendations router: per-connector pipeline-health/staleness check, and
// the recommendation ledger (surfaced leverage actions + outcome tracking).
// Twenty-fourth router extraction out of server.js's monolith (see the
// engineering review's #1+#6 recommendation) — a straight move, verified
// line-by-line against the original before removing it from server.js.
const express = require('express');
const sourcesStore = require('../store/sources');
const recommendationsStore = require('../store/recommendations');
const { asyncHandler } = require('../middleware/asyncHandler');

// Pipeline health — per-connector freshness + staleness status. The authoritative
// version of the stale check that also runs silently inside the briefing build.
// Useful for debugging "why is my briefing citing old numbers?"
const PIPELINE_STALE_THRESHOLDS = {
  eight_sleep_api:  { hours: 26, criticalFor: 'recovery/sleep' },
  monarch_mcp_sync: { hours: 26, criticalFor: 'wealth/spending' },
  monarch:          { hours: 48, criticalFor: 'wealth' },
  health:           { hours: 6,  criticalFor: 'activity/steps' },
  checkin:          { hours: 36, criticalFor: 'mood/energy/focus' },
  habits:           { hours: 36, criticalFor: 'habits' },
  readwise:         { hours: 72, criticalFor: 'highlights' },
};
const PIPELINE_DEFAULT_STALE_H = 72;

function createRecommendationsRouter() {
  const router = express.Router();

  router.get('/pipeline-health', asyncHandler(async (req, res) => {
    const sources = await sourcesStore.listSources();
    const now = Date.now();
    const connectors = sources.map((s) => {
      const thresh = PIPELINE_STALE_THRESHOLDS[s.id] ?? { hours: PIPELINE_DEFAULT_STALE_H, criticalFor: null };
      const hoursAgo = s.last_sync_at
        ? (now - new Date(s.last_sync_at).getTime()) / 3_600_000
        : null;
      const isStale = hoursAgo == null || hoursAgo > thresh.hours;
      return {
        id: s.id,
        displayName: s.display_name,
        domain: s.domain,
        status: s.status ?? 'unknown',
        lastSyncAt: s.last_sync_at ?? null,
        lastError: s.last_error ?? null,
        hoursAgo: hoursAgo != null ? Math.round(hoursAgo * 10) / 10 : null,
        staleThresholdHours: thresh.hours,
        isStale,
        criticalFor: thresh.criticalFor,
      };
    });
    const stale = connectors.filter((c) => c.isStale && PIPELINE_STALE_THRESHOLDS[c.id]);
    res.json({
      connectors,
      anyStale: stale.length > 0,
      staleSummary: stale.length
        ? `${stale.length} source(s) stale: ${stale.map((c) => c.displayName || c.id).join(', ')}`
        : 'All monitored sources are fresh.',
      checkedAt: new Date().toISOString(),
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
