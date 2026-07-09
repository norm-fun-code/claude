// Commitments router: the follow-through loop (open commitments, manual add,
// done/skip, the reminder-poll test trigger) and the daily-context journal.
// Twenty-fifth router extraction out of server.js's monolith (see the
// engineering review's #1+#6 recommendation) — a straight move, verified
// line-by-line against the original before removing it from server.js.
const express = require('express');
const commitmentsStore = require('../store/commitments');
const dayJournalStore = require('../store/dayJournal');
const { asyncHandler } = require('../middleware/asyncHandler');

function createCommitmentsRouter() {
  const router = express.Router();

  // ── Commitments (follow-through loop) ─────────────────────────────────────────

  // Open commitments for the Today card, soonest-due first.
  router.get('/commitments', asyncHandler(async (req, res) => {
    res.json({ commitments: await commitmentsStore.listActive({ limit: 20 }) });
  }));

  // Manually add a commitment (typed, not by voice). { title, detail?, at? }
  router.post('/commitments', asyncHandler(async (req, res) => {
    const { title, detail = null, at = null } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
    const { dueAt } = commitmentsStore.resolveReminderTime(at, new Date());
    const row = await commitmentsStore.create({ title, detail, source: 'manual', dueAt });
    res.json({ ok: true, commitment: row });
  }));

  router.post('/commitments/:id/done', asyncHandler(async (req, res) => {
    const row = await commitmentsStore.markDone(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'not found or already done' });
    res.json({ ok: true, commitment: row });
  }));

  router.post('/commitments/:id/skip', asyncHandler(async (req, res) => {
    const row = await commitmentsStore.markSkipped(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'not found or not open' });
    res.json({ ok: true, commitment: row });
  }));

  // Fire due commitment reminders on demand (mirrors the scheduler poll — for testing).
  router.post('/commitments/run', asyncHandler(async (req, res) => {
    const { runCommitmentReminders } = require('../notify/commitments');
    const force = req.query.force === '1' || req.query.force === 'true';
    res.json(await runCommitmentReminders({ force }));
  }));

  // ── Daily context journal ─────────────────────────────────────────────────────

  // Recent daily-context entries (their own words about their days).
  router.get('/day-context', asyncHandler(async (req, res) => {
    const days = Math.min(Number(req.query.days) || 14, 90);
    res.json({ entries: await dayJournalStore.recent({ days, limit: 30 }) });
  }));

  // Add a daily-context entry (typed, not by voice). { text }
  router.post('/day-context', asyncHandler(async (req, res) => {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
    const tz = process.env.TZ || 'America/New_York';
    const entryDate = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const row = await dayJournalStore.create({ text, entryDate, source: 'manual' });
    res.json({ ok: true, entry: row });
  }));

  return router;
}

module.exports = { createCommitmentsRouter };
