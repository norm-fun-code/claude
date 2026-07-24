// Durable, server-owned identity for every Chief Brief openQuestion — see
// migration 060 and intelligence/open-question-policy.js's
// bindOpenQuestionInstance. Mobile echoes back only `id`; the server is the
// sole authority for subject_type/subject_local_date/subject_block_ids —
// never reconstructed from the client's answer text.
const { query } = require('../db');

/** `db` defaults to the pooled `query` but accepts an injected transaction
 *  client (see db/index.js's withTransaction). Returns the new row's id. */
async function create({
  localDate, questionText, fingerprint = null, topicKey = null,
  subjectType = null, subjectLocalDate = null, subjectBlockIds = [], subjectAmbiguous = false,
}, db = query) {
  const { rows } = await db(
    `INSERT INTO open_question_instances
       (local_date, question_text, fingerprint, topic_key, subject_type, subject_local_date, subject_block_ids, subject_ambiguous)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      localDate, questionText, fingerprint, topicKey, subjectType, subjectLocalDate,
      JSON.stringify(Array.isArray(subjectBlockIds) ? subjectBlockIds : []), Boolean(subjectAmbiguous),
    ]
  );
  return rows[0].id;
}

/** The full row for `id`, or null if it doesn't exist. `db` accepts an
 *  injected transaction client so the caller can read-then-write inside one
 *  atomic answer transaction (see routes/annotations.js). */
async function getById(id, db = query) {
  if (!id) return null;
  const { rows } = await db(
    `SELECT id, local_date::text AS local_date, question_text, fingerprint, topic_key,
            subject_type, subject_local_date::text AS subject_local_date, subject_block_ids, subject_ambiguous,
            answered_at
       FROM open_question_instances
      WHERE id = $1`,
    [id]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id,
    localDate: r.local_date,
    questionText: r.question_text,
    fingerprint: r.fingerprint,
    topicKey: r.topic_key,
    subjectType: r.subject_type,
    subjectLocalDate: r.subject_local_date,
    subjectBlockIds: Array.isArray(r.subject_block_ids) ? r.subject_block_ids : [],
    subjectAmbiguous: Boolean(r.subject_ambiguous),
    answeredAt: r.answered_at,
  };
}

/** Stamp the instance as answered — idempotent (a second call is a no-op
 *  UPDATE). Called inside the SAME transaction as the compiled context
 *  write, the annotation, and the answered_open_questions ledger row, so a
 *  partial failure can never leave one durable without the others. */
async function markAnswered(id, db = query) {
  if (!id) return;
  await db(`UPDATE open_question_instances SET answered_at = now() WHERE id = $1 AND answered_at IS NULL`, [id]);
}

module.exports = { create, getById, markAnswered };
