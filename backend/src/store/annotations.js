// Life-context annotations: travel, illness, deadlines, etc. — so the
// intelligence layer (and you) can explain anomalies instead of being misled.
const { query } = require('../db');

async function createAnnotation(a) {
  const { startTs, endTs = null, category, label, note = null } = a;
  const { rows } = await query(
    `INSERT INTO annotations (start_ts, end_ts, category, label, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [startTs, endTs, category, label, note]
  );
  return rows[0]?.id ?? null;
}

async function listAnnotations({ from = null, to = null, limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT * FROM annotations
      WHERE ($1::timestamptz IS NULL OR start_ts >= $1)
        AND ($2::timestamptz IS NULL OR start_ts <= $2)
      ORDER BY start_ts DESC
      LIMIT $3`,
    [from, to, limit]
  );
  return rows;
}

/** Annotations overlapping a window — used to contextualize findings. */
async function overlapping(windowStart, windowEnd) {
  const { rows } = await query(
    `SELECT * FROM annotations
      WHERE start_ts <= $2
        AND COALESCE(end_ts, start_ts) >= $1
      ORDER BY start_ts DESC`,
    [windowStart, windowEnd]
  );
  return rows;
}

module.exports = { createAnnotation, listAnnotations, overlapping };
