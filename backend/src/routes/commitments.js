// Commitments router: the follow-through loop (open commitments, manual add,
// done/skip, the reminder-poll test trigger) and the daily-context journal.
// Twenty-fifth router extraction out of server.js's monolith (see the
// engineering review's #1+#6 recommendation) — a straight move, verified
// line-by-line against the original before removing it from server.js.
const express = require('express');
const commitmentsStore = require('../store/commitments');
const dayJournalStore = require('../store/dayJournal');
const { asyncHandler } = require('../middleware/asyncHandler');

/** Fire-and-forget attention-ledger outcome stamp for a commitment the user
 *  just resolved. Audit-only (the beliefs loop reads these) — never awaited by
 *  the route, never throws into it. */
function stampCommitmentOutcome(commitment, outcome) {
  Promise.resolve()
    .then(async () => {
      const attentionStore = require('../store/attention');
      const { fromCommitmentDue } = require('../intelligence/events');
      await attentionStore.stampOutcome(fromCommitmentDue({ commitment, asOf: new Date() }), outcome);
    })
    .catch(() => {});
}

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
    // Audit-only: stamp the attention ledger so the beliefs loop sees the user
    // followed through on this commitment. Never blocks the response.
    stampCommitmentOutcome(row, 'completed');
    res.json({ ok: true, commitment: row });
  }));

  router.post('/commitments/:id/skip', asyncHandler(async (req, res) => {
    const row = await commitmentsStore.markSkipped(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'not found or not open' });
    // Audit-only: a user skip is an 'ignored' outcome — the strongest signal
    // the dismissal-pattern belief promoter learns from. Never blocks.
    stampCommitmentOutcome(row, 'ignored');
    res.json({ ok: true, commitment: row });
  }));

  // Fire due commitment reminders on demand (mirrors the scheduler poll — for testing).
  router.post('/commitments/run', asyncHandler(async (req, res) => {
    const { runCommitmentReminders } = require('../notify/commitments');
    const force = req.query.force === '1' || req.query.force === 'true';
    res.json(await runCommitmentReminders({ force }));
  }));

  // One-tap "Commit" on the brief's ACTION (full-repo review, improvement #3:
  // THE ACTION was pure narration — the leverage engine computed the single
  // highest-leverage move each morning and rendered it read-only). This turns
  // it into a real commitment with everything commitments already have: due
  // reminders, escalating follow-ups, and auto-completion when metric
  // evidence proves it happened. Also stamps accepted_at on today's ledger
  // row so the recommendation ledger measures ACCEPTANCE rate, not just
  // outcomes — feeding the learning layer.
  router.post('/briefing/action/commit', asyncHandler(async (req, res) => {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
    const tz = process.env.TZ || 'America/New_York';
    // Due this evening (9pm local) — the day-close reads it as today's task —
    // or in 3 hours when committed late in the evening, so it never lands
    // already-overdue.
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const ninePm = new Date(require('../util/date').naiveToUtcIso(`${todayStr}T21:00:00`, tz));
    const dueAt = ninePm.getTime() > Date.now() + 60 * 1000 ? ninePm : new Date(Date.now() + 3 * 60 * 60 * 1000);
    const row = await commitmentsStore.create({
      title: String(text).trim().slice(0, 200),
      source: 'brief_action',
      dueAt,
    });
    // Acceptance stamp is best-effort — the commitment is the user-facing
    // result; the ledger update is bookkeeping.
    const startOfToday = new Date(require('../util/date').naiveToUtcIso(`${todayStr}T00:00:00`, tz));
    require('../store/recommendations').acceptLatestBriefingAction({ startOfToday })
      .catch((e) => console.error('[action commit] acceptance stamp failed:', e.message));
    res.json({ ok: true, commitment: row });
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
