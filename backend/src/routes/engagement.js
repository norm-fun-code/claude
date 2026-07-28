// Engagement router: ranked leverage actions, goal-forecast probabilities,
// push-device registration, the proactive nudge log + trigger, and dismissed-
// insight management. Twentieth router extraction out of server.js's
// monolith (see the engineering review's #1+#6 recommendation) — a straight
// move, verified line-by-line against the original before removing it from
// server.js.
const express = require('express');
const findingsStore = require('../store/findings');
const devicesStore = require('../store/devices');
const nudgesStore = require('../store/nudges');
const { runNudges } = require('../notify/run');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireFields } = require('../middleware/validate');

function createEngagementRouter() {
  const router = express.Router();

  // The ranked "highest leverage actions" — the core NormOS question.
  router.get('/actions', asyncHandler(async (req, res) => {
    const open = await findingsStore.listFindings({ status: 'open' });
    const actions = open
      .filter((f) => f.type === 'leverage')
      .sort((a, b) => (a.evidence?.rank ?? 99) - (b.evidence?.rank ?? 99))
      .map((f) => ({ title: f.title, detail: f.detail, score: f.evidence?.score, domains: f.domains }));
    res.json({ actions });
  }));

  // Goal achievement-probability forecasts (latest analyze run).
  router.get('/forecasts', asyncHandler(async (req, res) => {
    const open = await findingsStore.listFindings({ status: 'open' });
    const forecasts = open
      .filter((f) => f.type === 'forecast')
      .map((f) => ({
        title: f.title,
        detail: f.detail,
        probability: f.confidence,
        domains: f.domains,
        ...f.evidence,
      }))
      .sort((a, b) => (a.probability ?? 1) - (b.probability ?? 1)); // most at-risk first
    res.json({ forecasts });
  }));

  // Register a phone's Expo push token so NormOS can reach out proactively.
  router.post('/devices/register', asyncHandler(async (req, res) => {
    const { pushToken, platform, label } = req.body || {};
    if (!requireFields(req.body, ['pushToken'], res)) return;
    const id = await devicesStore.registerDevice({ pushToken, platform, label });
    res.json({ ok: true, id });
  }));

  // Recent nudges (the proactive-message log).
  router.get('/nudges', asyncHandler(async (req, res) => {
    res.json({ nudges: await nudgesStore.listNudges({ limit: Math.max(1, Math.min(Number(req.query.limit) || 50, 200)) }) });
  }));

  // Generate + (optionally) send today's nudges. Cron hits this each morning;
  // pass { force, dryRun } to override quiet hours or preview without sending.
  router.post('/nudges/run', asyncHandler(async (req, res) => {
    const { force = false, dryRun = false } = req.body || {};
    res.json(await runNudges({ force, send: !dryRun }));
  }));

  // Dismiss/explain a "What The Data Shows" insight by its stable key — stays
  // gone across rebuilds (e.g. a recurring car payment flagged for "review",
  // or a category confirmed "This was intentional"). POST { key, title }.
  // `amount` (optional) — the $ evidence behind a wealth insight at dismiss
  // time, so wealth-landing.js's "materially new evidence" reactivation
  // check has a real number to compare a future recurrence against.
  // `category`/`type`/`detail` (optional) — the structured explanation
  // context (severity/reliability cleanup, item 3: "This was intentional"
  // persists a structured explanation against the exact anomaly/category,
  // not a bare local dismissal) — read back by dismissedContextByKey() and
  // consumed identically by Wealth, Today, and Ask.
  router.post('/insights/dismiss', asyncHandler(async (req, res) => {
    const { key, title = null, amount = null, category = null, type = null, detail = null } = req.body || {};
    if (!requireFields(req.body, ['key'], res)) return;
    const context = {
      ...(typeof amount === 'number' && Number.isFinite(amount) ? { amount } : {}),
      ...(typeof category === 'string' && category ? { category } : {}),
      ...(typeof type === 'string' && type ? { type } : {}),
      ...(typeof detail === 'string' && detail ? { detail } : {}),
    };
    await require('../store/dismissedInsights').dismiss(key, title, Object.keys(context).length ? context : null);
    res.json({ ok: true, dismissed: key });
  }));

  // Restore a dismissed insight. POST { key }.
  router.post('/insights/undismiss', asyncHandler(async (req, res) => {
    const { key } = req.body || {};
    if (!requireFields(req.body, ['key'], res)) return;
    await require('../store/dismissedInsights').undismiss(key);
    res.json({ ok: true, restored: key });
  }));

  // List dismissed insights (for a future "manage dismissed" view).
  router.get('/insights/dismissed', asyncHandler(async (req, res) => {
    res.json({ dismissed: await require('../store/dismissedInsights').listDismissed() });
  }));

  return router;
}

module.exports = { createEngagementRouter };
