// Recovery router: live recovery score (same computation the briefing
// embeds, standalone and fast), its history, and the self-reported-sleep
// fallback for nights without an Eight Sleep reading. Fourteenth router
// extraction out of server.js's monolith (see the engineering review's
// #1+#6 recommendation) — a straight move, verified line-by-line against
// the original before removing it from server.js.
const express = require('express');
const sourcesStore = require('../store/sources');
const metricsStore = require('../store/metrics');
const { asyncHandler } = require('../middleware/asyncHandler');

function createRecoveryRouter() {
  const router = express.Router();

  // Live recovery score — the same computation the briefing embeds, but
  // standalone and fast (a few aggregate queries, no LLM, no briefing build).
  // Lets the Health tab refresh the recovery card in under a second instead of
  // waiting out a full briefing rebuild.
  router.get('/recovery', asyncHandler(async (req, res) => {
    // Debug: ?forceCheckIn=1 forces the sleep check-in card to show (so the
    // no-Pod flow can be tested without an actual no-Pod night).
    if (req.query.forceCheckIn === '1') {
      return res.json({ recovery: null, needsSleepCheckIn: true });
    }
    const rec = require('../intelligence/recovery');
    const recovery = await rec.liveRecovery();
    // When there's no recovery (no Pod reading last night) AND no self-report yet,
    // tell the client to prompt the sleep check-in.
    const needsSleepCheckIn = recovery ? false : await rec.needsSleepCheckIn();
    res.json({ recovery, needsSleepCheckIn });
  }));

  // Recovery-score trend: the last N days of composite recovery, computed with the
  // same scorer as the live card. Returns { rows:[{ts,value}] } like metrics/history.
  router.get('/recovery/history', asyncHandler(async (req, res) => {
    const days = Math.max(7, Math.min(Number(req.query.days) || 30, 90));
    const rec = require('../intelligence/recovery');
    res.json({ rows: await rec.recoveryHistory({ days }) });
  }));

  // Self-reported sleep for nights without an Eight Sleep reading. Stores a 1–5
  // quality (and optional hours), then recomputes recovery as a subjective proxy
  // that drives the recovery card / forecast / brief for the day.
  router.post('/recovery/self-report', asyncHandler(async (req, res) => {
    const quality = Number(req.body?.quality);
    const hours = req.body?.hours != null && req.body.hours !== '' ? Number(req.body.hours) : null;
    if (!Number.isFinite(quality) || quality < 1 || quality > 5) {
      return res.status(400).json({ error: 'quality (1-5) required' });
    }
    await sourcesStore.registerSource({ id: 'self_report', domain: 'health', displayName: 'Self-reported sleep' });
    // Anchor at noon UTC of today's LOCAL date so the day-slice matches how
    // liveRecovery compares "today" (wake-date convention).
    const tz = process.env.TZ || 'America/New_York';
    const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const ts = new Date(`${todayLocal}T12:00:00Z`);
    const rows = [{ ts, domain: 'health', metric: 'sleep_quality', value: quality, unit: '', source: 'self_report' }];
    if (Number.isFinite(hours) && hours > 0 && hours <= 24) {
      rows.push({ ts, domain: 'health', metric: 'sleep_hours', value: hours, unit: 'hours', source: 'self_report' });
    }
    const written = await metricsStore.insertMetrics(rows);
    const recoveryModule = require('../intelligence/recovery');
    // A recovery change: drive the registry-declared invalidation (recovery →
    // effectiveWorkout → todayForecast → recoveryComposite) through the ONE bus,
    // which also clears the liveRecovery compute cache via its registered
    // listener. Must happen before re-reading: an earlier request in this same
    // process (e.g. the Health tab's initial load, before this check-in was
    // submitted) can have cached a "no data yet" null that's still within its
    // TTL — without invalidation that stale null gets served right back through
    // the write and the recovery score never appears to have been created.
    require('../brain/invalidation').bump('recovery_change');
    const recovery = await recoveryModule.liveRecovery();
    // Return the new proxy recovery immediately. The mobile then fires its normal
    // non-blocking briefing rebuild (triggerRebuild) which picks up this stored
    // self-report — so the brief rebuilds with the recovery score AND the app
    // actually refetches it (the old server-only background build never reached
    // the client, so the briefing looked unchanged after submit).
    res.json({ ok: true, written, recovery });
  }));

  return router;
}

module.exports = { createRecoveryRouter };
