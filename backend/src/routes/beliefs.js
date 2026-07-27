// Beliefs router — "What NormOS currently believes" (Health tab redesign,
// audit rec #4). Read/manage surface over the existing durable beliefs store
// (store/beliefs.js, migration 040_beliefs.sql). Deliberately thin: this is
// NOT a new learning authority — every belief here was already being
// computed/promoted by intelligence/beliefs.js; this router only exposes
// read + the four user actions (Confirm/Edit/Retire/Forget) the redesign's
// Patterns & experiments screen needs, replacing the old raw self-model prose
// as the primary surface for this durable knowledge.
const express = require('express');
const beliefsStore = require('../store/beliefs');
const { asyncHandler } = require('../middleware/asyncHandler');

// Confidence-only (no explicit user confirmation) still shown as "supported"
// rather than the weaker-sounding "hypothesis" once it clears this bar —
// beliefs only reach this table after real evidence (a stated preference, a
// repeated dismissal pattern, or a measured outcome), so even an
// unconfirmed belief already has SOME evidentiary basis, distinct from an
// experiment's pre-registration hypothesis stage.
const SUPPORTED_CONFIDENCE_MIN = 0.5;

/** Pure: map the store's real active|retired + confidence + confirmed_at
 *  onto the redesign's display vocabulary. Honest simplification — there is
 *  no disputed/hypothesis detector in the backend, so this only ever returns
 *  one of the three states it actually has evidence for. */
function displayStatus(row) {
  if (row.status === 'retired') return 'retired';
  if (row.confirmed_at) return 'confirmed';
  return (row.confidence == null || row.confidence >= SUPPORTED_CONFIDENCE_MIN) ? 'supported' : 'hypothesis';
}

function toView(row) {
  return {
    id: row.id,
    kind: row.kind,
    statement: row.statement,
    status: displayStatus(row),
    confidence: row.confidence,
    evidence: row.evidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at ?? null,
  };
}

function createBeliefsRouter() {
  const router = express.Router();

  router.get('/beliefs', asyncHandler(async (req, res) => {
    const rows = await beliefsStore.listAll({ limit: 200 });
    res.json({ beliefs: rows.map(toView) });
  }));

  router.post('/beliefs/:id/confirm', asyncHandler(async (req, res) => {
    const ok = await beliefsStore.confirm(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'not found (or not active)' });
    res.json({ ok: true });
  }));

  router.patch('/beliefs/:id', asyncHandler(async (req, res) => {
    const statement = String(req.body?.statement ?? '');
    if (!statement.trim()) return res.status(400).json({ error: 'statement required' });
    const ok = await beliefsStore.updateStatement(Number(req.params.id), statement);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  }));

  router.post('/beliefs/:id/retire', asyncHandler(async (req, res) => {
    const ok = await beliefsStore.retireById(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  }));

  router.delete('/beliefs/:id', asyncHandler(async (req, res) => {
    const ok = await beliefsStore.forget(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createBeliefsRouter };
