// Evening-brief router: today's wind-down brief (Apple-Health daytime
// HRV/RHR -> autonomic tone) readback and on-demand build+push. Twenty-second
// router extraction out of server.js's monolith (see the engineering
// review's #1+#6 recommendation) — a straight move, verified line-by-line
// against the original before removing it from server.js.
const express = require('express');
const briefingsStore = require('../store/briefings');
const { asyncHandler } = require('../middleware/asyncHandler');

function createEveningBriefRouter() {
  const router = express.Router();

  // Evening wind-down brief (Apple-Health daytime HRV/RHR → autonomic tone). Returns
  // today's brief if already built, else null so the card hides. ?refresh=1 builds
  // it on demand (no push) — used by the card if you open the app before 9:30pm.
  router.get('/evening-brief', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    let latest = await briefingsStore.latestBriefing('evening');
    const isToday = latest && latest.content && latest.content.day === today;
    if (!isToday && refresh) {
      const { runEveningHealthBrief } = require('../notify/evening-brief');
      const r = await runEveningHealthBrief({ send: false, tz });
      return res.json({ ...r.content, generatedAt: new Date().toISOString(), fresh: true });
    }
    if (!isToday) return res.json(null);
    res.json({ ...latest.content, generatedAt: latest.generated_at });
  }));

  // Build + push the evening brief on demand (mirrors the 9:30pm scheduler job).
  router.post('/evening-brief/run', asyncHandler(async (req, res) => {
    const { runEveningHealthBrief } = require('../notify/evening-brief');
    const send = req.query.send !== '0' && req.query.send !== 'false';
    res.json(await runEveningHealthBrief({ send }));
  }));

  return router;
}

module.exports = { createEveningBriefRouter };
