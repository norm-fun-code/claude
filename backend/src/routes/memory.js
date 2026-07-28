// Memory router (product audit rec #6: separate conversation History from
// durable Memory). Read-side: GET /memory aggregates the SAME canonical
// stores every other surface already reasons from (context_assertions/
// context_relations via intelligence/memory-projection.js, beliefs via
// store/beliefs.js) into one categorized, UI-safe shape — no raw JSON,
// table names, policy enums, or internal scores. Write-side: Correct/
// Forget/Mark-temporary for assertion-origin items go through
// intelligence/memory-mutations.js (which shares the compiler/transaction/
// invalidation discipline every other context write already uses); belief-
// origin items reuse the EXISTING routes/beliefs.js endpoints directly (see
// that router's own doc comment) — the mobile Memory screen calls this
// router for everything except a belief's Confirm/Correct/Forget, which it
// calls straight through to /beliefs/:id/... .
const express = require('express');
const contextAssertionsStore = require('../store/contextAssertions');
const beliefsStore = require('../store/beliefs');
const { buildMemoryProjection } = require('../intelligence/memory-projection');
const { correctAssertion, forgetAssertion, setAssertionExpiration } = require('../intelligence/memory-mutations');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireFields } = require('../middleware/validate');

function tzFromReq(req) {
  return req.get('X-Time-Zone') || process.env.TZ || 'America/New_York';
}

function createMemoryRouter() {
  const router = express.Router();

  router.get('/memory', asyncHandler(async (req, res) => {
    const tz = tzFromReq(req);
    const [assertions, retiredAssertions, beliefs] = await Promise.all([
      contextAssertionsStore.getActive({ limit: 500 }),
      contextAssertionsStore.getRecentlyRetired({ limit: 200 }),
      beliefsStore.listAll({ limit: 200 }),
    ]);
    const projection = buildMemoryProjection({ assertions, retiredAssertions, beliefs, asOf: new Date(), tz });
    res.json(projection);
  }));

  router.post('/memory/assertions/:id/correct', asyncHandler(async (req, res) => {
    if (!requireFields(req.body, ['text'], res)) return;
    const result = await correctAssertion({
      assertionId: req.params.id, correctionText: req.body.text, tz: tzFromReq(req),
    });
    if (!result.ok) {
      const code = result.error === 'not_found' ? 404 : result.error === 'context_compilation_failed' ? 503 : 400;
      return res.status(code).json({ error: result.error });
    }
    res.json({ ok: true });
  }));

  router.post('/memory/assertions/:id/forget', asyncHandler(async (req, res) => {
    const ok = await forgetAssertion({ assertionId: req.params.id });
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  }));

  router.post('/memory/assertions/:id/expire', asyncHandler(async (req, res) => {
    if (!requireFields(req.body, ['effectiveEnd'], res)) return;
    const effectiveEnd = new Date(req.body.effectiveEnd);
    if (Number.isNaN(effectiveEnd.getTime())) return res.status(400).json({ error: 'invalid effectiveEnd' });
    const ok = await setAssertionExpiration({ assertionId: req.params.id, effectiveEnd });
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createMemoryRouter };
