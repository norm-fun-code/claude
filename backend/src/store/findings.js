// Read/write helpers for the intelligence layer's findings.
const { query } = require('../db');

async function createFinding(f) {
  const {
    type,
    domains = [],
    title,
    detail = null,
    confidence = null,
    status = 'open',
    windowStart = null,
    windowEnd = null,
    evidence = {},
  } = f;

  const { rows } = await query(
    `INSERT INTO findings
       (type, domains, title, detail, confidence, status, window_start, window_end, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [type, domains, title, detail, confidence, status, windowStart, windowEnd, evidence]
  );
  return rows[0]?.id ?? null;
}

async function listFindings({ status = null, limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT * FROM findings
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC
      LIMIT $2`,
    [status, limit]
  );
  return rows;
}

async function updateStatus(id, status) {
  await query('UPDATE findings SET status = $2 WHERE id = $1', [id, status]);
}

/**
 * Mark previously auto-generated, still-open findings as superseded. Called at
 * the start of an analysis run so the latest run reflects the current picture
 * while history is preserved (not deleted). User-curated findings (no auto flag)
 * are left untouched.
 */
async function supersedeAuto(types = null) {
  const { rowCount } = await query(
    `UPDATE findings
        SET status = 'superseded'
      WHERE status = 'open'
        AND (evidence->>'auto') = 'true'
        AND ($1::text[] IS NULL OR type = ANY($1))`,
    [types]
  );
  return rowCount;
}

module.exports = { createFinding, listFindings, updateStatus, supersedeAuto };
