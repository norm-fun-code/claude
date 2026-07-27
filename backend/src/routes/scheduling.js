// Scheduling-trigger router: manual + external-cron entry points for the
// anomaly watcher, morning routine, afternoon check-in reminder, combined
// evening reminder, weekly review, and the weekly-review read endpoint.
// Twenty-first router extraction out of server.js's monolith (see the
// engineering review's #1+#6 recommendation) — a straight move, verified
// line-by-line against the original before removing it from server.js.
const express = require('express');
const briefingsStore = require('../store/briefings');
const { runCheckinReminder, runEveningReminder } = require('../notify/run');
const { runMorningBriefing, runWeeklyReviewWithPush } = require('../notify/morning');
const { runReview } = require('../intelligence/review');
const { asyncHandler } = require('../middleware/asyncHandler');

function createSchedulingRouter() {
  const router = express.Router();

  // Manually trigger the anomaly watcher (event-driven "your HRV dropped" ping).
  // Pass { force: true } to bypass quiet hours, { dryRun: true } to scan without pushing.
  router.post('/watch/run', asyncHandler(async (req, res) => {
    const { force = false, dryRun = false } = req.body || {};
    res.json(await require('../intelligence/watch').runWatch({ force, send: !dryRun }));
  }));

  // Manually trigger the morning routine (pre-build briefing + "ready" push).
  // Lets you test the 8am flow on demand; pass { dryRun: true } to build without
  // pushing. Explicit test trigger — forces past the "already built recently"
  // guard by default so it always runs; pass { force: false } to exercise the
  // guard itself.
  router.post('/morning/run', asyncHandler(async (req, res) => {
    const { dryRun = false, force = true } = req.body || {};
    res.json(await runMorningBriefing({ send: !dryRun, force }));
  }));

  // External-cron trigger for the morning routine. Accepts a lightweight
  // CRON_SECRET (separate from NORMOS_API_TOKEN) so this URL can be called by
  // cron-job.org or similar without exposing the main API token.
  // Set CRON_SECRET in Railway env vars, then call:
  //   POST /api/cron/morning?secret=<CRON_SECRET>
  router.post('/cron/morning', asyncHandler(async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured' });
    const provided = req.query.secret || req.body?.secret;
    if (provided !== secret) return res.status(401).json({ error: 'invalid secret' });
    try {
      // An external cron fires at a FIXED clock time — but the whole product
      // promise is a brief that lands only once the night's tracking is genuinely
      // finalized. The cron is a polling/reliability mechanism, NOT permission to
      // bypass sleep completion: it funnels through scheduler.morningRoutine,
      // which applies the exact same sleep-readiness gate (final ingest +
      // revalidate + build-once) that the in-process watcher uses. There is no
      // separate, weaker cron check. ?force=1 bypasses the gate for deliberate
      // authenticated manual testing only.
      const force = req.query.force === '1' || req.query.force === 'true';
      const scheduler = require('../scheduler');
      const r = await scheduler.morningRoutine({ reason: 'cron', force });
      console.log(`[cron] morning trigger: built=${r.built} sent=${r.sent ?? 0} skipped=${r.skipped ?? '-'} reason=${r.reason ?? '-'}`);
      res.json(r);
    } catch (err) {
      console.error('[cron] morning failed:', err.message);
      throw err;
    }
  }));

  // Manually trigger the afternoon check-in reminder (the 3pm flow). Only pushes
  // if you haven't logged today; { force: true } sends regardless for testing.
  router.post('/checkin/remind', asyncHandler(async (req, res) => {
    const { force = false, dryRun = false } = req.body || {};
    res.json(await runCheckinReminder({ force, send: !dryRun }));
  }));

  // Manually trigger the combined evening reminder (the 9pm flow — check-in,
  // habits, day-context, merged into one push). Only pushes if at least one is
  // still outstanding; { force: true } sends regardless for testing.
  router.post('/evening/remind', asyncHandler(async (req, res) => {
    const { force = false, dryRun = false } = req.body || {};
    res.json(await runEveningReminder({ force, send: !dryRun }));
  }));

  // Manually trigger the weekly review generation + "review ready" push (the
  // Sunday-morning flow), so you can test it on demand. { dryRun: true } generates
  // without pushing.
  router.post('/weekly/run', asyncHandler(async (req, res) => {
    const { dryRun = false } = req.body || {};
    res.json(await runWeeklyReviewWithPush({ send: !dryRun }));
  }));

  // External-cron trigger for the weekly review — the same CRON_SECRET pattern as
  // /api/cron/morning, for a host (e.g. cron-job.org) to hit on a Sunday-only
  // schedule. Exists because the in-process scheduler's setTimeout chain
  // (scheduler.js's scheduleWeekly) resets on every server restart/redeploy — a
  // restart landing near the scheduled time can silently drop that week's run
  // with no external trigger to fall back on.
  // Set CRON_SECRET in Railway env vars, then call:
  //   POST /api/cron/weekly?secret=<CRON_SECRET>
  router.post('/cron/weekly', asyncHandler(async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured' });
    const provided = req.query.secret || req.body?.secret;
    if (provided !== secret) return res.status(401).json({ error: 'invalid secret' });
    try {
      const r = await runWeeklyReviewWithPush({});
      console.log(`[cron] weekly review triggered externally: generated=${r.generated} sent=${r.sent}`);
      res.json(r);
    } catch (err) {
      console.error('[cron] weekly review failed:', err.message);
      throw err;
    }
  }));

  // Weekly review — the reflective narrative. Only weekly/quarterly kinds are
  // allowed here: 'daily' is the Chief Brief kind, and reading it through
  // this route would bypass the publishable-row selector contract
  // (store/briefings.js's latestPublishableDailyForLocalDay) every other
  // Chief Brief consumer goes through, risking a degraded/pending row being
  // shown as "the" review.
  router.get('/review', asyncHandler(async (req, res) => {
    const kind = req.query.kind === 'quarterly' ? 'quarterly' : 'weekly';
    const wr = await briefingsStore.latestBriefing(kind);
    res.json(wr ? { ...wr.content, generatedAt: wr.generated_at } : null);
  }));

  router.post('/review/run', asyncHandler(async (req, res) => {
    res.json(await runReview());
  }));

  return router;
}

module.exports = { createSchedulingRouter };
