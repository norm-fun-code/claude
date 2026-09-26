// "I didn't wear my Apple Watch today."
//
// Wearing it is the default, so this endpoint records EXCEPTIONS. Marking a day
// not-worn excludes that day's wrist-sensed readings (steps, active energy,
// exercise/mindful minutes) from every daily read — see store/metrics.js, where
// the exclusion lives so no consumer has to remember to ask.
//
// Nothing is deleted. Toggling back to worn removes the exception and the
// original readings count again, unchanged.
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { localDateStr } = require('../util/date');

function tzOf(req) {
  return req.get('X-Time-Zone') || process.env.TZ || 'America/New_York';
}

function dayOf(req, tz) {
  const raw = req.query.day ?? req.body?.day;
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : localDateStr(tz);
}

function createWatchWearRouter() {
  const router = express.Router();
  const store = require('../store/watchWear');

  // GET /api/watch-wear?day=YYYY-MM-DD  -> { day, worn }
  // Defaults to today in the caller's timezone. `worn: true` for any day never
  // marked, which is why the client can render the toggle before this returns.
  router.get('/watch-wear', asyncHandler(async (req, res) => {
    const tz = tzOf(req);
    const day = dayOf(req, tz);
    res.json({ day, worn: await store.wasWorn(day), tz });
  }));

  // GET /api/watch-wear/recent -> the exceptions, newest first.
  router.get('/watch-wear/recent', asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 60, 400));
    res.json({ notWorn: await store.notWornDays({ limit }) });
  }));

  // POST /api/watch-wear  { day?, worn }
  router.post('/watch-wear', asyncHandler(async (req, res) => {
    const tz = tzOf(req);
    const day = dayOf(req, tz);
    const { worn } = req.body || {};
    if (typeof worn !== 'boolean') {
      return res.status(400).json({ error: 'worn must be true or false' });
    }
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : null;
    if (worn) await store.markWorn(day);
    else await store.markNotWorn(day, note);

    // Every activity-derived figure for this day just changed meaning, so the
    // derived state built on it is stale. Reuse the existing durable bus rather
    // than a bespoke refresh: `training_change` is the declared trigger for
    // activity/completion movement (see brain/registry.js), which is exactly
    // what a day's movement total becoming valid or void is. Best-effort — the
    // toggle itself is already committed and must not fail over invalidation.
    try {
      await require('../brain/invalidation').bumpDurable('training_change');
    } catch (err) {
      console.error('[watch-wear] invalidation failed:', err.message);
    }

    res.json({ ok: true, day, worn });
  }));

  return router;
}

module.exports = { createWatchWearRouter };
