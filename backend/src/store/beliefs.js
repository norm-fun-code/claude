// Durable beliefs store — see migrations/040_beliefs.sql for what belongs here
// (and, as importantly, what deliberately does not).
const { query } = require('../db');

/**
 * Insert or refresh a belief. Keyed on dedup_key so re-promotion (which runs
 * nightly) updates the statement/evidence in place instead of duplicating.
 * A retired belief is NOT resurrected: once the user (or a future retire
 * pathway) has turned a belief off, the nightly promoter must not silently
 * turn it back on — the update only touches active rows' content, and the
 * insert path only fires when no row exists at all.
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
       WHERE beliefs.status = 'active'
     RETURNING id`,
    [kind, dedupKey, statement, confidence, JSON.stringify(evidence)]
  );
  return rows[0]?.id ?? null; // null = row exists but is retired (no-op)
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

/** Every belief (active + retired), for the Patterns & experiments screen's
 *  "What NormOS currently believes" — unlike listActive() this is a
 *  read-only management view, not what gets injected into prompts. */
async function listAll({ limit = 200 } = {}) {
  try {
    const { rows } = await query(`SELECT * FROM beliefs ORDER BY updated_at DESC LIMIT $1`, [limit]);
    return rows;
  } catch {
    return [];
  }
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
 *  Only meaningful on an active belief; a retired one must be un-retired
 *  first (there is no "confirm a retired belief" path — Edit/Confirm always
 *  act on what's currently shown, and a retired belief isn't shown as
 *  confirmable). */
async function confirm(id) {
  const { rowCount } = await query(
    `UPDATE beliefs SET confirmed_at = now(), updated_at = now() WHERE id = $1 AND status = 'active'`,
    [id]
  );
  return rowCount > 0;
}

/** User edit of the belief's own statement text. */
async function updateStatement(id, statement) {
  if (!statement || !statement.trim()) throw new Error('statement required');
  const { rowCount } = await query(
    `UPDATE beliefs SET statement = $2, updated_at = now() WHERE id = $1`,
    [id, statement.trim()]
  );
  return rowCount > 0;
}

/** "Forget" — a hard delete, distinct from Retire (which keeps the row as
 *  history but stops surfacing it). Forget is for a belief the user says is
 *  simply wrong, not just no longer worth acting on. */
async function forget(id) {
  const { rowCount } = await query(`DELETE FROM beliefs WHERE id = $1`, [id]);
  return rowCount > 0;
}

module.exports = { upsertBelief, listActive, listAll, retire, retireById, confirm, updateStatement, forget };
