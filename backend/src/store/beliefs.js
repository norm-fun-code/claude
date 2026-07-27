// Durable beliefs store — see migrations/040_beliefs.sql for what belongs here
// (and, as importantly, what deliberately does not).
const { query } = require('../db');

/**
 * Insert or refresh a belief. Keyed on dedup_key so re-promotion (which runs
 * nightly) updates the statement/evidence in place instead of duplicating.
 * A retired or forgotten belief is NOT resurrected, and a user_locked
 * belief (one the user has confirmed or hand-edited) is NOT overwritten:
 * the update only touches active, unlocked rows' content. The insert path
 * only fires when no row exists at all — including forgotten rows, whose
 * dedup_key still occupies the UNIQUE constraint, so a matching nightly
 * upsert can never resurrect them as a fresh INSERT either.
 */
async function upsertBelief({ kind, dedupKey, statement, confidence = null, evidence = {} }) {
  if (!kind || !dedupKey || !statement) throw new Error('kind, dedupKey, statement required');
  const { rows } = await query(
    `INSERT INTO beliefs (kind, dedup_key, statement, confidence, evidence)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (dedup_key) DO UPDATE
       SET statement = EXCLUDED.statement,
           confidence = EXCLUDED.confidence,
           evidence = EXCLUDED.evidence,
           updated_at = now()
       WHERE beliefs.status = 'active' AND beliefs.user_locked = false
     RETURNING id`,
    [kind, dedupKey, statement, confidence, JSON.stringify(evidence)]
  );
  return rows[0]?.id ?? null; // null = row exists but is retired/forgotten/locked (no-op)
}

/** Active beliefs, optionally filtered by kind(s). Fail-safe: [] on error, so
 *  a missing table (pre-migration) can never break a briefing build. */
async function listActive({ kinds = null, limit = 50 } = {}) {
  try {
    const { rows } = await query(
      `SELECT * FROM beliefs
        WHERE status = 'active'
          AND ($1::text[] IS NULL OR kind = ANY($1))
        ORDER BY updated_at DESC
        LIMIT $2`,
      [kinds, limit]
    );
    return rows;
  } catch {
    return [];
  }
}

async function retire(dedupKey) {
  const { rowCount } = await query(
    `UPDATE beliefs SET status = 'retired', updated_at = now() WHERE dedup_key = $1`,
    [dedupKey]
  );
  return rowCount > 0;
}

/** Every belief the user is allowed to see (active + retired), for the
 *  Patterns & experiments screen's "What NormOS currently believes" —
 *  unlike listActive() this is a read-only management view, not what gets
 *  injected into prompts. Forgotten beliefs are excluded: they stay in the
 *  table for auditability (forget() never deletes), but forgotten content
 *  must never be retrieved or surfaced to the user.
 *
 *  Deliberately NOT fail-safe: this store function has exactly one caller
 *  (GET /beliefs, the management route), and swallowing a real DB error
 *  into [] would render as an indistinguishable-from-genuine "nothing
 *  learned yet" empty state — a false empty state the route must not show.
 *  Let the error propagate; asyncHandler/errorHandler turn it into an
 *  honest 5xx. Contrast with listActive(), whose sole caller is the
 *  no-catch nightly pipeline, where fail-open is the correct behavior. */
async function listAll({ limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT * FROM beliefs WHERE status != 'forgotten' ORDER BY updated_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Retire by id (the management UI addresses beliefs by id, not dedup_key). */
async function retireById(id) {
  const { rowCount } = await query(
    `UPDATE beliefs SET status = 'retired', updated_at = now() WHERE id = $1`,
    [id]
  );
  return rowCount > 0;
}

/** User-initiated "Confirm" (health tab redesign, audit rec #4) — an
 *  explicit affirmation distinct from the system's own confidence score.
 *  Sets user_locked so the nightly promoter can no longer silently rewrite
 *  this belief's statement/evidence out from under the user's confirmation
 *  — the belief stays bound to the exact statement the user confirmed.
 *  Only meaningful on an active belief; a retired one must be un-retired
 *  first (there is no "confirm a retired belief" path — Edit/Confirm always
 *  act on what's currently shown, and a retired belief isn't shown as
 *  confirmable). */
async function confirm(id) {
  const { rowCount } = await query(
    `UPDATE beliefs SET confirmed_at = now(), user_locked = true, updated_at = now()
      WHERE id = $1 AND status = 'active'`,
    [id]
  );
  return rowCount > 0;
}

/** User edit of the belief's own statement text. The edited statement is
 *  authoritative: this also sets user_locked so later automated extraction
 *  can never silently overwrite what the user wrote. Only meaningful on an
 *  active belief, matching confirm()/the UI (edit is only offered on
 *  non-retired beliefs, and a forgotten belief is never listed at all). */
async function updateStatement(id, statement) {
  if (!statement || !statement.trim()) throw new Error('statement required');
  const { rowCount } = await query(
    `UPDATE beliefs SET statement = $2, user_locked = true, updated_at = now()
      WHERE id = $1 AND status = 'active'`,
    [id, statement.trim()]
  );
  return rowCount > 0;
}

/** "Forget" — a durable tombstone, distinct from Retire (which keeps the
 *  row active-adjacent as visible history but stops injecting it into
 *  prompts). Forget is for a belief the user says is simply wrong: content
 *  must stop being retrieved/surfaced (listAll excludes status='forgotten'),
 *  but the row is not hard-deleted — provenance for auditability survives,
 *  and critically, the row keeps occupying its dedup_key's UNIQUE slot so
 *  the next matching nightly upsert can never resurrect it via a fresh
 *  INSERT (upsertBelief's ON CONFLICT path also refuses to touch a
 *  non-'active' row's content, so it can't revive it via UPDATE either). */
async function forget(id) {
  const { rowCount } = await query(
    `UPDATE beliefs SET status = 'forgotten', user_locked = true, updated_at = now()
      WHERE id = $1 AND status != 'forgotten'`,
    [id]
  );
  return rowCount > 0;
}

module.exports = { upsertBelief, listActive, listAll, retire, retireById, confirm, updateStatement, forget };
