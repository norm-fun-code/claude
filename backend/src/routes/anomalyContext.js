// "What explains this?" router — the mobile anomaly detail view calls
// /ensure on-demand (never embedded in the cached briefing payload) with
// the evidence snapshot it already holds in memory from the currently
// displayed Worth Knowing insight, then /answer, /nothing-unusual, /skip,
// or /forget as the user acts. See intelligence/anomalyContext.js for the
// eligibility/temporal-binding logic this thinly wraps.
const express = require('express');
const anomalyContext = require('../intelligence/anomalyContext');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireFields } = require('../middleware/validate');

function tzFromReq(req) {
  return req.get('X-Time-Zone') || process.env.TZ || 'America/New_York';
}

function createAnomalyContextRouter() {
  const router = express.Router();

  router.post('/anomaly-context/ensure', asyncHandler(async (req, res) => {
    if (!requireFields(req.body, ['evidence'], res)) return;
    const { metric, domains, evidence } = req.body;
    const card = await anomalyContext.ensureAnomalyContextCard({
      metric, domains: Array.isArray(domains) ? domains : [], evidence, tz: tzFromReq(req),
    });
    if (!card) return res.status(400).json({ error: 'not_an_anomaly' });
    res.json(card);
  }));

  router.post('/anomaly-context/:key/answer', asyncHandler(async (req, res) => {
    if (!requireFields(req.body, ['text'], res)) return;
    const result = await anomalyContext.answerAnomalyContext({
      anomalyKey: req.params.key, text: req.body.text, tz: tzFromReq(req),
    });
    if (!result.ok) {
      const code = result.error === 'not_found' ? 404 : result.error === 'context_compilation_failed' ? 503 : 400;
      return res.status(code).json({ error: result.error });
    }
    res.json({ ok: true });
  }));

  router.post('/anomaly-context/:key/nothing-unusual', asyncHandler(async (req, res) => {
    const result = await anomalyContext.markNothingUnusual({ anomalyKey: req.params.key });
    if (!result.ok) return res.status(result.error === 'not_found' ? 404 : 400).json({ error: result.error });
    res.json({ ok: true });
  }));

  router.post('/anomaly-context/:key/skip', asyncHandler(async (req, res) => {
    const result = await anomalyContext.skipAnomalyContext({ anomalyKey: req.params.key });
    if (!result.ok) return res.status(result.error === 'not_found' ? 404 : 400).json({ error: result.error });
    res.json({ ok: true });
  }));

  router.post('/anomaly-context/:key/forget', asyncHandler(async (req, res) => {
    const result = await anomalyContext.forgetAnomalyContext({ anomalyKey: req.params.key });
    if (!result.ok) return res.status(result.error === 'not_found' ? 404 : 400).json({ error: result.error });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createAnomalyContextRouter };
