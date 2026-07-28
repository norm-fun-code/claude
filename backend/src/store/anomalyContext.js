// CRUD for anomaly_context_questions — "What explains this?" (see migration
// 067_anomaly_context_questions.sql and intelligence/anomalyContext.js, the
// orchestration layer built on top of this store). anomaly_key is the
// stable identity (deterministic per metric+observation-date — see
// intelligence/analyze.js's computeAnomalies) that lets two UI
// representations of the same anomaly, and a rebuilt brief, all resolve to
// the exact same question/answer state.
const { query } = require('../db');

/** Idempotent create-or-fetch keyed on anomaly_key (ON CONFLICT DO NOTHING),
 *  then always reads back the row — whether it was just inserted or already
 *  existed. `db` defaults to the pooled `query` but accepts an injected
 *  transaction client. */
async function ensure({
  anomalyKey, metric, domains = [], observedValue = null, baselineMean = null,
  baselineStd = null, deviation = null, unit = null, observedAt = null,
  localObservationDate, tz, sourceFresh = true,
}, db = query) {
  await db(
    `INSERT INTO anomaly_context_questions
       (anomaly_key, metric, domains, observed_value, baseline_mean, baseline_std, deviation,
        unit, observed_at, local_observation_date, tz, source_fresh)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (anomaly_key) DO NOTHING`,
    [
      anomalyKey, metric, domains, observedValue, baselineMean, baselineStd, deviation,
      unit, observedAt, localObservationDate, tz, Boolean(sourceFresh),
    ]
  );
  return getByKey(anomalyKey, db);
}

const SELECT_COLUMNS = `id, anomaly_key, metric, domains, observed_value, baseline_mean, baseline_std,
  deviation, unit, observed_at, local_observation_date::text AS local_observation_date, tz,
  source_fresh, status, raw_answer, context_assertion_id, created_at, updated_at, retired_at, retired_reason`;

async function getByKey(anomalyKey, db = query) {
  if (!anomalyKey) return null;
  const { rows } = await db(`SELECT ${SELECT_COLUMNS} FROM anomaly_context_questions WHERE anomaly_key = $1`, [anomalyKey]);
  return rows[0] ? mapRow(rows[0]) : null;
}

async function getById(id, db = query) {
  if (!id) return null;
  const { rows } = await db(`SELECT ${SELECT_COLUMNS} FROM anomaly_context_questions WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** First-answer or edit — always overwrites raw_answer/context_assertion_id
 *  together so ONE call handles both (edit = answer again on an already-
 *  answered row). Also clears any prior retired_at/retired_reason, since a
 *  fresh answer on a previously-forgotten row makes it active again. */
async function recordAnswer(id, { rawAnswer, contextAssertionId = null }, db = query) {
  await db(
    `UPDATE anomaly_context_questions
        SET status = 'answered', raw_answer = $2, context_assertion_id = $3,
            updated_at = now(), retired_at = NULL, retired_reason = NULL
      WHERE id = $1`,
    [id, rawAnswer, contextAssertionId]
  );
}

async function recordSkipped(id, db = query) {
  await db(
    `UPDATE anomaly_context_questions SET status = 'skipped', updated_at = now() WHERE id = $1`,
    [id]
  );
}

/** "Forget" — retire the question row itself (independent of whatever
 *  happens to its linked context_assertion, which the caller retires
 *  separately). A retired row is treated as fresh/re-askable by the
 *  eligibility gate. */
async function retire(id, reason = null, db = query) {
  const { rowCount } = await db(
    `UPDATE anomaly_context_questions SET retired_at = now(), retired_reason = $2 WHERE id = $1 AND retired_at IS NULL`,
    [id, reason]
  );
  return rowCount > 0;
}

function mapRow(r) {
  return {
    id: r.id,
    anomalyKey: r.anomaly_key,
    metric: r.metric,
    domains: r.domains ?? [],
    observedValue: r.observed_value == null ? null : Number(r.observed_value),
    baselineMean: r.baseline_mean == null ? null : Number(r.baseline_mean),
    baselineStd: r.baseline_std == null ? null : Number(r.baseline_std),
    deviation: r.deviation == null ? null : Number(r.deviation),
    unit: r.unit,
    observedAt: r.observed_at,
    localObservationDate: r.local_observation_date,
    tz: r.tz,
    sourceFresh: Boolean(r.source_fresh),
    status: r.status,
    rawAnswer: r.raw_answer,
    contextAssertionId: r.context_assertion_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    retiredAt: r.retired_at,
    retiredReason: r.retired_reason,
  };
}

module.exports = { ensure, getByKey, getById, recordAnswer, recordSkipped, retire, mapRow };
