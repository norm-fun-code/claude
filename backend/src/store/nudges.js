// Log of pushed nudges — also the de-dup ledger so the same insight doesn't
// nag day after day.
const { query, withTransaction } = require('../db');

// How long a concurrent duplicate insert for the SAME dedup_key is blocked —
// short and deliberately independent of any caller's day-scale "don't repeat
// this insight for N days" business dedup (that's still driven by each
// caller's own recentlySentKeys() pre-check, unchanged). This only closes
// the TOCTOU race: two near-simultaneous callers (e.g. an overlapping
// scheduler tick + a manually-triggered run) can both pass their own
// recentlySentKeys() check before either has recorded anything, and would
// otherwise both insert + both push the same nudge. Ten seconds is far
// longer than any realistic race window but far shorter than any
// legitimate retry gap (the tightest poll in this app is 2 minutes).
const CONCURRENT_DEDUP_SECONDS = 10;

/** Insert a nudge, atomically suppressed if the SAME dedup_key was already
 *  inserted (by ANY caller, any status) in the last CONCURRENT_DEDUP_SECONDS —
 *  closes a check-then-insert race that a plain INSERT can't. Returns the new
 *  row's id, or null if suppressed as a concurrent duplicate — callers MUST
 *  treat a null id as "someone else is already handling this" and skip
 *  sending, not just skip the status update.
 *
 *  A bare `INSERT ... WHERE NOT EXISTS` is NOT actually safe against true
 *  concurrency: two simultaneous statements can each evaluate NOT EXISTS
 *  against a snapshot where neither sees the other's still-uncommitted row,
 *  so both pass and both insert (verified empirically — this is exactly
 *  the bug the first version of this fix shipped with). A transaction-scoped
 *  advisory lock keyed by the dedup_key forces the second caller to wait for
 *  the first to commit, so its NOT EXISTS check then correctly sees the
 *  first's row. hashtext() maps the key to the 32-bit int
 *  pg_advisory_xact_lock expects; the lock auto-releases at commit/rollback. */
async function recordNudge(n) {
  const { dedupKey, title, body, priority = 0, basis = {}, status = 'pending' } = n;
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [dedupKey]);
    const { rows } = await client.query(
      `INSERT INTO nudges (dedup_key, title, body, priority, basis, status)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE NOT EXISTS (
          SELECT 1 FROM nudges
           WHERE dedup_key = $1 AND created_at >= now() - ($7 || ' seconds')::interval
        )
       RETURNING id`,
      [dedupKey, title, body, priority, basis, status, String(CONCURRENT_DEDUP_SECONDS)]
    );
    return rows[0]?.id ?? null;
  });
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
  // Exclude internal bookkeeping rows (e.g. the scheduler's morning-ran marker)
  // so the proactive-message log only shows real, user-facing nudges.
  const { rows } = await query(
    `SELECT * FROM nudges
      WHERE COALESCE(basis->>'type', '') <> 'morning_marker'
      ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { recordNudge, markStatus, recentlySentKeys, listNudges };
