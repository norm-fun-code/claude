// Weekly intentions router: the Sunday check-in (life context + focus
// goals). Eleventh router extraction out of server.js's monolith (see the
// engineering review's #1+#6 recommendation) — a straight move, verified
// line-by-line against the original before removing it from server.js.
const express = require('express');
const intentionsStore = require('../store/intentions');
const { asyncHandler } = require('../middleware/asyncHandler');

function createIntentionsRouter() {
  const router = express.Router();

  // GET returns the current week's entry (so the Today card can pre-fill /
  // know if it's been set); POST upserts it.
  router.get('/intentions/current', asyncHandler(async (req, res) => {
    res.json({
      weekStart: intentionsStore.weekStart(),
      intention: await intentionsStore.currentIntention(),
      // Last week's goals, so the Sunday card can show them with a checkbox to
      // mark which were achieved.
      prior: await intentionsStore.priorIntention(),
    });
  }));

  router.post('/intentions', asyncHandler(async (req, res) => {
    const { context, goals } = req.body || {};
    res.json({ intention: await intentionsStore.saveIntention({ context, goals }) });
  }));

  // Record which of a (default: prior) week's goals were achieved. Body:
  // { weekStart?: 'YYYY-MM-DD', achieved: boolean[] } aligned to that week's goals.
  router.post('/intentions/results', asyncHandler(async (req, res) => {
    const { weekStart, achieved } = req.body || {};
    res.json({ intention: await intentionsStore.saveGoalResults({ weekStart, achieved }) });
  }));

  return router;
}

module.exports = { createIntentionsRouter };
