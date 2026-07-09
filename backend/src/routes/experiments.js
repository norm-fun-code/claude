// Experiments router: the hypothesis-loop CRUD (propose/create/start/
// evaluate/pause/resume/delete). Fourth router extraction out of server.js's
// monolith (see the engineering review's #1+#6 recommendation) — a straight
// move, verified line-by-line against the original before removing it from
// server.js.
const express = require('express');
const experimentsStore = require('../store/experiments');
const experiments = require('../intelligence/experiments');
const { asyncHandler } = require('../middleware/asyncHandler');

function createExperimentsRouter() {
  const router = express.Router();

  router.get('/experiments', asyncHandler(async (req, res) => {
    res.json({ experiments: await experimentsStore.listExperiments({ status: req.query.status }) });
  }));

  // Generate experiment proposals from unconfirmed correlations.
  router.post('/experiments/propose', asyncHandler(async (req, res) => {
    res.json(await experiments.proposeExperiments());
  }));

  // Create a custom experiment, or start a proposed one.
  router.post('/experiments', asyncHandler(async (req, res) => {
    const id = await experimentsStore.createExperiment(req.body || {});
    res.json({ id });
  }));

  // Start a proposed experiment (sets running + dates).
  router.post('/experiments/:id/start', asyncHandler(async (req, res) => {
    const { testDays = 14 } = req.body || {};
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + Number(testDays));
    await experimentsStore.updateExperiment(req.params.id, {
      status: 'running',
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    });
    res.json({ ok: true, startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) });
  }));

  // Evaluate a single experiment now.
  router.post('/experiments/:id/evaluate', asyncHandler(async (req, res) => {
    const exp = await experimentsStore.getExperiment(req.params.id);
    if (!exp) return res.status(404).json({ error: 'not found' });
    res.json(await experiments.evaluateExperiment(exp));
  }));

  router.delete('/experiments/:id', asyncHandler(async (req, res) => {
    await require('../db').query('DELETE FROM experiments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }));

  // PATCH /api/experiments/:id — pause or resume an experiment.
  // pause: freezes the clock (status → 'paused', records paused_at)
  // resume: extends end_date by days paused so the experiment keeps its full duration
  router.patch('/experiments/:id', asyncHandler(async (req, res) => {
    const { action } = req.body || {};
    const exp = await experimentsStore.getExperiment(req.params.id);
    if (!exp) return res.status(404).json({ error: 'not found' });

    if (action === 'pause') {
      if (exp.status !== 'running') return res.status(400).json({ error: 'only running experiments can be paused' });
      await experimentsStore.updateExperiment(exp.id, { status: 'paused', pausedAt: new Date() });
      return res.json({ ok: true });
    }

    if (action === 'resume') {
      if (exp.status !== 'paused') return res.status(400).json({ error: 'only paused experiments can be resumed' });
      const daysPaused = exp.paused_at
        ? Math.round((Date.now() - new Date(exp.paused_at).getTime()) / 86400000)
        : 0;
      let newEndDate = exp.end_date ? new Date(exp.end_date) : null;
      if (newEndDate && daysPaused > 0) newEndDate.setDate(newEndDate.getDate() + daysPaused);
      // start_date must shift by the same amount — otherwise "days elapsed"
      // (computed as now - start_date on the client) counts the paused days
      // as if the experiment had been running the whole time, so day-count
      // jumps forward by daysPaused the instant you resume even though the
      // clock was supposed to be frozen while paused.
      let newStartDate = exp.start_date ? new Date(exp.start_date) : null;
      if (newStartDate && daysPaused > 0) newStartDate.setDate(newStartDate.getDate() + daysPaused);
      await experimentsStore.updateExperiment(exp.id, {
        status: 'running',
        pausedAt: null,
        ...(newEndDate ? { endDate: newEndDate.toISOString().slice(0, 10) } : {}),
        ...(newStartDate ? { startDate: newStartDate.toISOString().slice(0, 10) } : {}),
      });
      return res.json({ ok: true, daysPaused, newEndDate: newEndDate?.toISOString().slice(0, 10) ?? null, newStartDate: newStartDate?.toISOString().slice(0, 10) ?? null });
    }

    res.status(400).json({ error: 'action must be pause or resume' });
  }));

  return router;
}

module.exports = { createExperimentsRouter };
