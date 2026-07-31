// Durable outbox for context compilation. The outbox is deliberately tiny:
// raw user input already committed, compilation is retried separately, and a
// job can be canceled when its underlying annotation is retired.
const { query, withTransaction } = require('../db');

const MAX_ATTEMPTS = 5;

function retryDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, attempts - 1)));
}

async function enqueue({ sourceAnnotationId = null, rawText, source, question = null, timezone, recordedAt }, db = query) {
  const { rows } = await db(
    `INSERT INTO context_compilation_jobs
       (source_annotation_id, raw_text, source, question, timezone, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_annotation_id) WHERE source_annotation_id IS NOT NULL AND status IN ('pending', 'processing')
     DO UPDATE SET raw_text = EXCLUDED.raw_text, source = EXCLUDED.source,
                   question = EXCLUDED.question, timezone = EXCLUDED.timezone,
                   recorded_at = EXCLUDED.recorded_at, status = 'pending',
                   next_attempt_at = now(), updated_at = now()
     RETURNING *`,
    [sourceAnnotationId, rawText, source, question, timezone, recordedAt]
  );
  return rows[0] ?? null;
}

async function claimNext({ now = new Date(), jobId = null } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `WITH next_job AS (
         SELECT id FROM context_compilation_jobs
          WHERE status = 'pending' AND next_attempt_at <= $1
            AND ($2::uuid IS NULL OR id = $2::uuid)
          ORDER BY next_attempt_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE context_compilation_jobs j
          SET status = 'processing', attempts = attempts + 1, updated_at = now()
         FROM next_job
        WHERE j.id = next_job.id
       RETURNING j.*`,
      [now, jobId]
    );
    return rows[0] ?? null;
  });
}

async function markSucceeded(id, db = query) {
  const { rowCount } = await db(
    `UPDATE context_compilation_jobs
        SET status = 'succeeded', completed_at = now(), updated_at = now(), last_error = NULL
      WHERE id = $1 AND status = 'processing'`,
    [id]
  );
  return rowCount > 0;
}

async function reschedule(id, { attempts, error }, db = query) {
  const terminal = attempts >= MAX_ATTEMPTS;
  const nextAttemptAt = new Date(Date.now() + retryDelayMs(attempts));
  const { rowCount } = await db(
    `UPDATE context_compilation_jobs
        SET status = $2, next_attempt_at = $3, last_error = $4, updated_at = now()
      WHERE id = $1 AND status = 'processing'`,
    [id, terminal ? 'failed' : 'pending', nextAttemptAt, String(error || 'context_compilation_failed').slice(0, 500)]
  );
  return { updated: rowCount > 0, terminal, nextAttemptAt };
}

async function cancelForSourceAnnotation(sourceAnnotationId, db = query) {
  const { rowCount } = await db(
    `UPDATE context_compilation_jobs
        SET status = 'canceled', canceled_at = now(), updated_at = now()
      WHERE source_annotation_id = $1 AND status IN ('pending', 'processing')`,
    [sourceAnnotationId]
  );
  return rowCount;
}

async function isSourceAnnotationActive(sourceAnnotationId, db) {
  if (!sourceAnnotationId) return true;
  const { rows } = await db(
    `SELECT retired_at FROM annotations WHERE id = $1 FOR KEY SHARE`, [sourceAnnotationId]
  );
  return Boolean(rows[0] && !rows[0].retired_at);
}

module.exports = {
  MAX_ATTEMPTS, retryDelayMs, enqueue, claimNext, markSucceeded, reschedule,
  cancelForSourceAnnotation, isSourceAnnotationActive,
};
