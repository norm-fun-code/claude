// Log of pushed nudges — also the de-dup ledger so the same insight doesn't
// nag day after day.
const { query } = require('../db');

async function recordNudge(n) {
  const { dedupKey, title, body, priority = 0, basis = {}, status = 'pending' } = n;
  const { rows } = await query(
    `INSERT INTO nudges (dedup_key, title, body, priority, basis, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [dedupKey, title, body, priority, basis, status]
  );
  return rows[0]?.id ?? null;
}

async function markStatus(id, status) {
  await query(
    `UPDATE nudges SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
      WHERE id = $1`,
    [id, status]
  );
}

/** dedup_keys that were actually delivered within the last `days` — used to
 *  suppress repeats so a still-true insight isn't pushed every morning. */
async function recentlySentKeys(days = 2) {
  const { rows } = await query(
    `SELECT DISTINCT dedup_key FROM nudges
      WHERE status = 'sent' AND sent_at >= now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return new Set(rows.map((r) => r.dedup_key));
}

async function listNudges({ limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT * FROM nudges ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { recordNudge, markStatus, recentlySentKeys, listNudges };
