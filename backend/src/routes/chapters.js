// Life chapters router: persistent long-arc facts (a pregnancy + due date, a
// big deadline) that auto-advance and inform every brief without being
// re-typed into weekly context. Also creatable by telling the Ask chat /
// voice chief ("remember: Nancy is due January 6th") — that path lives
// elsewhere in server.js and calls lifeChaptersStore directly. Twelfth
// router extraction out of server.js's monolith (see the engineering
// review's #1+#6 recommendation) — a straight move, verified line-by-line
// against the original before removing it from server.js.
const express = require('express');
const lifeChaptersStore = require('../store/lifeChapters');
const { asyncHandler } = require('../middleware/asyncHandler');

function createChaptersRouter() {
  const router = express.Router();

  router.get('/chapters', asyncHandler(async (req, res) => {
    const chapters = await lifeChaptersStore.listActive();
    res.json({ chapters });
  }));

  router.post('/chapters', asyncHandler(async (req, res) => {
    const { kind, label, keyDate, keyDateLabel, notes } = req.body || {};
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'label is required' });
    const chapter = await lifeChaptersStore.create({
      kind: ['pregnancy', 'countdown', 'note'].includes(kind) ? kind : 'countdown',
      label: String(label).trim().slice(0, 120),
      keyDate: keyDate || null,
      keyDateLabel: keyDateLabel ? String(keyDateLabel).slice(0, 40) : null,
      notes: notes ? String(notes).slice(0, 500) : null,
    });
    res.json({ chapter });
  }));

  router.delete('/chapters/:id', asyncHandler(async (req, res) => {
    const ok = await lifeChaptersStore.deactivate(req.params.id);
    res.json({ ok });
  }));

  return router;
}

module.exports = { createChaptersRouter };
