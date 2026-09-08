// Precedent router — "you've been here before."
//
// Deliberately a STANDALONE endpoint rather than another field on the
// briefing payload. Two reasons:
//
//   1. The briefing build is the app's hot, expensive, LLM-bearing path and
//      the one most exposed to latency regressions. Precedent is pure
//      retrieval over the spine — it has no business adding seconds to a
//      build the user is already waiting on at 8am.
//   2. The card is progressive by nature: Today is useful without it, and
//      strictly better with it. Fetching it independently (the same shape
//      useRecovery already uses for the Health tab's fast path) lets it
//      arrive on its own schedule and simply not render when the evidence
//      does not support it.
//
// Everything the engine gates on lives in intelligence/precedent.js; this
// file only handles transport and caching.
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function tzOf(req) {
  return req.get('X-Time-Zone') || process.env.TZ || 'America/New_York';
}

function createPrecedentRouter() {
  const router = express.Router();

  // GET /api/precedent
  //   ?day=YYYY-MM-DD  compute as of a specific local day (diagnostics, and
  //                    what makes the endpoint verifiable by hand). Anything
  //                    that isn't an exact YYYY-MM-DD is ignored in favour of
  //                    the real local day — never interpolated anywhere.
  //   ?days=180        how far back to look for precedents.
  //   ?fresh=1         bypass the engine's memo.
  //
  // Returns { precedent: <projection> | null }. A null precedent is a
  // NORMAL, expected response — it means the evidence did not clear the
  // engine's gates — so it is never an error and never a 4xx.
  //
  // Caching lives in the engine (intelligence/precedent.js's cachedPrecedent),
  // not here, so chat/ask.js's precedentContext() shares the same memo instead
  // of re-running the scan on its own.
  router.get('/precedent', asyncHandler(async (req, res) => {
    const tz = tzOf(req);
    const { localDateStr } = require('../util/date');
    const day = typeof req.query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
      ? req.query.day
      : localDateStr(tz);
    const days = Math.max(60, Math.min(Number(req.query.days) || 180, 400));

    const { cachedPrecedent } = require('../intelligence/precedent');
    const precedent = await cachedPrecedent({ today: day, tz, days, force: req.query.fresh === '1' });
    res.json({ precedent, asOf: day, tz });
  }));

  return router;
}

module.exports = { createPrecedentRouter };
