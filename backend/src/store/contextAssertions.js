// CRUD for context_assertions — WHAT the user communicated, compiled by
// intelligence/context-compiler.js. See migration 051_context_understanding.sql
// and intelligence/context-resolver.js (the canonical projection built from
// these rows + context_relations).
const { query } = require('../db');

/** Persist one compiled assertion. `db` defaults to the pooled `query` but
 *  accepts an injected transaction client (see db/index.js's withTransaction)
 *  — routes/annotations.js writes this atomically alongside the annotation
 *  it was compiled from and any derived context_relations rows. */
async function create(a, db = query) {
  const {
    sourceAnnotationId = null, source, rawText, assertionType, subject = null, predicate = null,
    objectValue = null, entities = [], concepts = [], domains = [], eventStatus = 'occurred',
    effectiveStart = null, effectiveEnd = null, confidence = null, sourceAuthority = 'user',
    supersedesAssertionId = null, compilerVersion,
  } = a;
  const { rows } = await db(
    `INSERT INTO context_assertions
       (source_annotation_id, source, raw_text, assertion_type, subject, predicate, object_value,
        entities, concepts, domains, event_status, effective_start, effective_end, confidence,
        source_authority, supersedes_assertion_id, compiler_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      sourceAnnotationId, source, rawText, assertionType, subject, predicate, objectValue,
      JSON.stringify(entities || []), JSON.stringify(concepts || []), domains || [], eventStatus,
      effectiveStart, effectiveEnd, confidence, sourceAuthority, supersedesAssertionId, compilerVersion,
    ]
  );
  return rows[0]?.id ?? null;
}

/** Retire an assertion (superseded/retracted) — never deleted, matches
 *  annotations' retirement convention. Also retires every context_relation
 *  DERIVED from it (scenario: "forget what I said about the late meal" must
 *  retire both the assertion and everything it was used to justify — a
 *  retired assertion left with live relations pointing at it would keep
 *  influencing the resolver after being explicitly retracted). `db` accepts
 *  an injected transaction client, same as create(). */
async function retire(id, reason = null, db = query) {
  const { rowCount } = await db(
    `UPDATE context_assertions SET retired_at = now(), retired_reason = $2 WHERE id = $1 AND retired_at IS NULL`,
    [id, reason]
  );
  if (rowCount > 0) {
    // Lazy require: contextRelations doesn't need to require this module
    // back, but keeping the require local avoids any future load-cycle risk
    // as both modules grow (same convention as store/annotations.js's
    // invalidateContext()).
    const contextRelationsStore = require('./contextRelations');
    await contextRelationsStore.retireBySourceAssertion(id, reason ? `source assertion retired: ${reason}` : 'source assertion retired', db);
  }
  return rowCount > 0;
}

/** Retire every structured assertion compiled from one raw annotation. This
 * makes annotation deletion/correction authoritative across all consumers;
 * leaving these rows active was the duplicate-memory path the audit found. */
async function retireBySourceAnnotation(sourceAnnotationId, reason = null, db = query) {
  const { rows } = await db(
    `UPDATE context_assertions
        SET retired_at = now(), retired_reason = $2
      WHERE source_annotation_id = $1 AND retired_at IS NULL
      RETURNING id`,
    [sourceAnnotationId, reason]
  );
  for (const row of rows) {
    await require('./contextRelations').retireBySourceAssertion(row.id, reason ? `source annotation retired: ${reason}` : 'source annotation retired', db);
  }
  return rows.length;
}

/** Active (non-retired) assertions, optionally filtered by domain and a
 *  recorded_at/effective window. Used by the resolver to build
 *  ResolvedContext, and by the compiler's correction/supersession matching
 *  (recent candidates to compare a new correction against). */
async function getActive({ domains = null, recordedFrom = null, recordedTo = null, limit = 500 } = {}) {
  const { rows } = await query(
    `SELECT * FROM context_assertions
      WHERE retired_at IS NULL
        AND ($1::text[] IS NULL OR domains && $1::text[])
        AND ($2::timestamptz IS NULL OR recorded_at >= $2)
        AND ($3::timestamptz IS NULL OR recorded_at <= $3)
      ORDER BY recorded_at DESC
      LIMIT $4`,
    [domains, recordedFrom, recordedTo, limit]
  );
  return rows.map(mapRow);
}

/** Active, non-negated/retracted/superseded assertions whose EFFECTIVE
 *  window overlaps [periodStart, periodEnd] — the period-bounded
 *  counterpart to getActive()'s recorded_at-only filtering. A weekly-scoped
 *  consumer (intelligence/weeklyLedger.js) needs "what applied during this
 *  period", not "what was compiled during this period": recorded_at can lag
 *  effective_start by hours (an evening event logged the next morning), so
 *  filtering on recorded_at alone would both miss and wrongly include rows
 *  near the period boundary. Falls back to recorded_at only when
 *  effective_start/effective_end are null (an assertion with no resolved
 *  temporal window at all) rather than excluding it outright. */
async function getActiveOverlapping(periodStart, periodEnd, { domains = null, limit = 500 } = {}) {
  const { rows } = await query(
    `SELECT * FROM context_assertions
      WHERE retired_at IS NULL
        AND event_status NOT IN ('negated', 'retracted', 'superseded')
        AND COALESCE(effective_start, recorded_at) <= $2
        AND COALESCE(effective_end, effective_start, recorded_at) >= $1
        AND ($3::text[] IS NULL OR domains && $3::text[])
      ORDER BY effective_start DESC NULLS LAST, recorded_at DESC
      LIMIT $4`,
    [periodStart, periodEnd, domains, limit]
  );
  return rows.map(mapRow);
}

async function getById(id) {
  const { rows } = await query(`SELECT * FROM context_assertions WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Recently retired (superseded/retracted/forgotten) assertions — the
 *  audit-trail counterpart to getActive(). Nothing before this needed "give
 *  me what's no longer active" (the resolver only ever reads active rows),
 *  so this is a genuinely new read, not a duplicate of an existing one —
 *  added for the Memory screen's collapsed "expired/superseded" area, which
 *  must show retired facts as auditable history without ever making them
 *  reasoning-eligible again (retired_at stays the single source of truth
 *  for that; this is a read-only view over it). */
async function getRecentlyRetired({ limit = 200, since = null } = {}) {
  const { rows } = await query(
    `SELECT * FROM context_assertions
      WHERE retired_at IS NOT NULL
        AND ($1::timestamptz IS NULL OR retired_at >= $1)
      ORDER BY retired_at DESC
      LIMIT $2`,
    [since, limit]
  );
  return rows.map(mapRow);
}

/** Update ONLY the effective_end of an active assertion — "mark temporary /
 *  set an expiration" for a currently-durable statement (a `preference`
 *  assertion, which by context-resolver.js's isDurableAssertion never
 *  expires on its own). Never touches a retired row. This is a narrow,
 *  additive capability the schema already supports (effective_end has
 *  always been a plain nullable timestamptz) — nothing before this needed
 *  to set it on an existing row after the fact, only at compile time. */
async function setEffectiveEnd(id, effectiveEnd, db = query) {
  const { rowCount } = await db(
    `UPDATE context_assertions SET effective_end = $2 WHERE id = $1 AND retired_at IS NULL`,
    [id, effectiveEnd]
  );
  return rowCount > 0;
}

/** Rows -> camelCase, JSON-parsed shape used everywhere else in this layer. */
function mapRow(r) {
  return {
    id: r.id,
    sourceAnnotationId: r.source_annotation_id,
    source: r.source,
    rawText: r.raw_text,
    assertionType: r.assertion_type,
    subject: r.subject,
    predicate: r.predicate,
    objectValue: r.object_value,
    entities: r.entities ?? [],
    concepts: r.concepts ?? [],
    domains: r.domains ?? [],
    eventStatus: r.event_status,
    effectiveStart: r.effective_start,
    effectiveEnd: r.effective_end,
    recordedAt: r.recorded_at,
    confidence: r.confidence == null ? null : Number(r.confidence),
    sourceAuthority: r.source_authority,
    supersedesAssertionId: r.supersedes_assertion_id,
    compilerVersion: r.compiler_version,
    retiredAt: r.retired_at,
    retiredReason: r.retired_reason,
    createdAt: r.created_at,
  };
}

module.exports = { create, retire, retireBySourceAnnotation, getActive, getActiveOverlapping, getById, getRecentlyRetired, setEffectiveEnd, mapRow };
