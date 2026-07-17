// CRUD for context_relations — WHY an assertion matters (how it connects to
// a target: a metric, a calendar block, a goal, an action type, ...), with
// the evidence tier that justifies the language used to describe it. See
// migration 051_context_understanding.sql and intelligence/context-resolver.js.
const { query } = require('../db');

/** Persist one derived relation. `db` accepts an injected transaction
 *  client (see db/index.js's withTransaction) for atomic persistence
 *  alongside its source assertion. */
async function create(r, db = query) {
  const {
    sourceAssertionId, targetType, targetId, relationship, direction = null, evidenceBasis,
    confidence = null, strength = null, windowStart = null, windowEnd = null, expiresAt = null,
    supportingEvidence = [], permittedLanguage = null, unresolved = false,
  } = r;
  const { rows } = await db(
    `INSERT INTO context_relations
       (source_assertion_id, target_type, target_id, relationship, direction, evidence_basis,
        confidence, strength, window_start, window_end, expires_at, supporting_evidence,
        permitted_language, unresolved)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      sourceAssertionId, targetType, targetId, relationship, direction, evidenceBasis,
      confidence, strength, windowStart, windowEnd, expiresAt, JSON.stringify(supportingEvidence || []),
      permittedLanguage, unresolved,
    ]
  );
  return rows[0]?.id ?? null;
}

/** Retire a single relation. */
async function retire(id, reason = null, db = query) {
  const { rowCount } = await db(
    `UPDATE context_relations SET retired_at = now(), retired_reason = $2 WHERE id = $1 AND retired_at IS NULL`,
    [id, reason]
  );
  return rowCount > 0;
}

/** Retire every relation derived from `sourceAssertionId` — called by
 *  contextAssertions.retire() so retracting/superseding an assertion also
 *  retires everything it was used to justify. */
async function retireBySourceAssertion(sourceAssertionId, reason = null, db = query) {
  const { rowCount } = await db(
    `UPDATE context_relations SET retired_at = now(), retired_reason = $2
      WHERE source_assertion_id = $1 AND retired_at IS NULL`,
    [sourceAssertionId, reason]
  );
  return rowCount;
}

/** Mark an unresolved relation resolved (an open question answered). Does
 *  NOT delete it — the row stays as the historical record of what was
 *  unresolved and when; `unresolved` flips false and `resolved_at` is
 *  stamped so context-resolver.js's getResolvedUncertainties() /
 *  getUnresolvedUncertainties() can partition correctly (unresolved=true
 *  alone isn't enough to tell "never was a question" from "was answered" —
 *  resolved_at IS NULL vs NOT NULL is). */
async function resolveUncertainty(id, db = query) {
  const { rowCount } = await db(
    `UPDATE context_relations SET unresolved = false, resolved_at = now() WHERE id = $1 AND retired_at IS NULL`,
    [id]
  );
  return rowCount > 0;
}

/** Active (non-retired) relations, optionally scoped by target type/domain
 *  prefix. Does NOT filter by expires_at — the resolver decides temporal
 *  eligibility itself (see context-resolver.js) so this store stays a dumb
 *  read, not a second place expiration logic could drift from the resolver's. */
async function getActive({ targetType = null, limit = 1000 } = {}) {
  const { rows } = await query(
    `SELECT * FROM context_relations
      WHERE retired_at IS NULL
        AND ($1::text IS NULL OR target_type = $1)
      ORDER BY created_at DESC
      LIMIT $2`,
    [targetType, limit]
  );
  return rows.map(mapRow);
}

async function getActiveForTarget(targetType, targetId) {
  const { rows } = await query(
    `SELECT * FROM context_relations
      WHERE retired_at IS NULL AND target_type = $1 AND target_id = $2
      ORDER BY created_at DESC`,
    [targetType, targetId]
  );
  return rows.map(mapRow);
}

/** Active, unresolved relations (modeled open questions — see
 *  intelligence/context-resolver.js's getResolvedUncertainties/
 *  getUnresolvedUncertainties). */
async function getUnresolved() {
  const { rows } = await query(
    `SELECT * FROM context_relations WHERE retired_at IS NULL AND unresolved = true ORDER BY created_at DESC`
  );
  return rows.map(mapRow);
}

function mapRow(r) {
  return {
    id: r.id,
    sourceAssertionId: r.source_assertion_id,
    targetType: r.target_type,
    targetId: r.target_id,
    relationship: r.relationship,
    direction: r.direction,
    evidenceBasis: r.evidence_basis,
    confidence: r.confidence == null ? null : Number(r.confidence),
    strength: r.strength == null ? null : Number(r.strength),
    windowStart: r.window_start,
    windowEnd: r.window_end,
    expiresAt: r.expires_at,
    supportingEvidence: r.supporting_evidence ?? [],
    permittedLanguage: r.permitted_language,
    unresolved: r.unresolved,
    resolvedAt: r.resolved_at,
    retiredAt: r.retired_at,
    retiredReason: r.retired_reason,
    createdAt: r.created_at,
  };
}

module.exports = {
  create, retire, retireBySourceAssertion, resolveUncertainty,
  getActive, getActiveForTarget, getUnresolved, mapRow,
};
