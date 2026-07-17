// Read/write helpers for the intelligence layer's findings.
const { query } = require('../db');

// Each writer accepts an optional `db` (a transaction client) so analyze() can
// run supersede + all inserts atomically; defaults to the pooled query.
async function createFinding(f, db = query) {
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

  const { rows } = await db(
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
async function supersedeAuto(types = null, db = query) {
  const { rowCount } = await db(
    `UPDATE findings
        SET status = 'superseded'
      WHERE status = 'open'
        AND (evidence->>'auto') = 'true'
        AND ($1::text[] IS NULL OR type = ANY($1))`,
    [types]
  );
  return rowCount;
}

/**
 * One-time cleanup for the lag>=2 methodology fix: supersede any still-open
 * habit_split finding whose evidence.lag is 2 or more — a two-night-delayed
 * physiological claim is scientifically weak to draw from daily observational
 * data, and analyze.js no longer generates these at all. History is
 * preserved (status flips to 'superseded', row kept), matching supersedeAuto's
 * convention. Scoped to habit_split specifically (the only engine that ever
 * computed lag>=2) rather than a blanket `evidence.lag >= 2` sweep across
 * every finding type, so a legitimate same-day or next-day finding of a
 * different type is never touched by this cleanup.
 */
async function supersedeLaggedHabitSplits(minLag = 2, db = query) {
  const { rowCount } = await db(
    `UPDATE findings
        SET status = 'superseded'
      WHERE status = 'open'
        AND type = 'habit_split'
        AND (evidence->>'lag')::numeric >= $1`,
    [minLag]
  );
  return rowCount;
}

module.exports = { createFinding, listFindings, updateStatus, supersedeAuto, supersedeLaggedHabitSplits };
