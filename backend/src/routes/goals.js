// Goals router: create/list/update/delete for user-set goals. Third router
// extraction out of server.js's monolith (see the engineering review's
// #1+#6 recommendation) — a straight move, verified line-by-line against
// the original before removing it from server.js.
const express = require('express');
const goalsStore = require('../store/goals');
const { asyncHandler } = require('../middleware/asyncHandler');

function createGoalsRouter() {
  const router = express.Router();

  router.get('/goals', asyncHandler(async (req, res) => {
    const status = req.query.status ?? 'active';
    res.json({ goals: await goalsStore.listGoals({ status: status === 'all' ? null : status }) });
  }));

  router.post('/goals', asyncHandler(async (req, res) => {
    const { title, domain, metric, targetValue, unit, targetDate, baselineValue } = req.body ?? {};
    if (!title?.trim()) return res.status(400).json({ error: 'title required' });
    const goal = await goalsStore.createGoal({ title: title.trim(), domain, metric, targetValue, unit, targetDate, baselineValue });
    res.json({ goal });
  }));

  router.patch('/goals/:id', asyncHandler(async (req, res) => {
    const { status, title } = req.body ?? {};
    await goalsStore.updateGoal(req.params.id, { status, title });
    res.json({ ok: true });
  }));

  router.delete('/goals/:id', asyncHandler(async (req, res) => {
    await goalsStore.deleteGoal(req.params.id);
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createGoalsRouter };
