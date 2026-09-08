// Disagreement router — the surface that holds you to what you said.
//
// Two endpoints, and the second matters as much as the first. A confrontation
// with no way to answer it is just an app being unpleasant at you; the whole
// design rests on the reply being a real fork ("is the goal wrong, or the
// plan?") with three legitimate answers, any of which resolves it.
//
// Resolution is recorded through the EXISTING dismissed_insights store rather
// than a new table — specifically its `context` column, added (migration 065)
// for exactly this rule: stay suppressed until materially new evidence
// appears. Storing the statement count at resolution time is what lets the
// engine re-raise later if the same goal keeps being set and missed, so the
// confrontation can be answered but never permanently escaped by one tap.
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createDisagreementRouter() {
  const router = express.Router();

  // GET /api/disagreement
  //   ?weeks=16   how far back to look.
  //
  // Returns { disagreement: <projection> | null }. Null is the NORMAL,
  // expected, and hoped-for answer — it means no repeated goal is being
  // repeatedly missed — so it is never an error.
  router.get('/disagreement', asyncHandler(async (req, res) => {
    const weeks = Math.max(4, Math.min(Number(req.query.weeks) || 16, 52));
    const { computeDisagreement } = require('../intelligence/disagreement');
    const disagreement = await computeDisagreement({ weeks });
    res.json({ disagreement });
  }));

  // POST /api/disagreement/resolve
  //   { resolutionKey, choice: 'revise'|'keep'|'retire', statements }
  //
  // `statements` is the count the user was shown — recorded so re-activation
  // is measured from what they actually saw, not from whatever the engine
  // recomputes later.
  router.post('/disagreement/resolve', asyncHandler(async (req, res) => {
    const resolutionKey = String(req.body?.resolutionKey || '').trim();
    const choice = String(req.body?.choice || '').trim();
    const statements = Number(req.body?.statements);
    if (!resolutionKey.startsWith('disagreement:')) {
      return res.status(400).json({ error: 'resolutionKey must be a disagreement key' });
    }
    if (!['revise', 'keep', 'retire'].includes(choice)) {
      return res.status(400).json({ error: 'choice must be revise, keep, or retire' });
    }
    if (!Number.isFinite(statements) || statements < 0) {
      return res.status(400).json({ error: 'statements must be the count shown to the user' });
    }
    const dismissedStore = require('../store/dismissedInsights');
    // Replace, don't insert. dismiss() is ON CONFLICT DO NOTHING by design —
    // for a wealth insight, re-dismissing must keep the ORIGINAL evidence so
    // suppression isn't silently extended. A disagreement is the opposite
    // case: answering it a second time, at a higher statement count, MUST
    // record the new count. Without this the stored count stays at the first
    // answer and the re-activation threshold is already exceeded, so the card
    // returns immediately after being answered — the precise behaviour that
    // would make this surface feel like nagging. Clearing first is the honest
    // way to say "this is a new resolution", without changing the shared
    // dismissal semantics every other consumer relies on.
    await dismissedStore.undismiss(resolutionKey);
    await dismissedStore.dismiss(resolutionKey, `disagreement resolved: ${choice}`, {
      statements,
      choice,
      resolvedAt: new Date().toISOString(),
    });
    res.json({ ok: true, resolutionKey, choice });
  }));

  return router;
}

module.exports = { createDisagreementRouter };
