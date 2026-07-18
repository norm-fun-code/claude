// Advisory-locked migration runner — Production Safety Gate (audit
// recommendation #1), item 3. Extracted out of server.js so it's directly
// testable (server.js itself is a script entrypoint with boot-time side
// effects — requiring it starts a real listener — not a requirable module).
// Distinct advisory-lock id from scheduler.js's own LEADER_LOCK_ID (727001)
// so the two can never collide; same dedicated-client pattern as
// scheduler.js's tryBecomeLeader() (pg_advisory_lock is tied to the SESSION
// that acquired it, so this bypasses the shared query() helper, which
// checks connections back into the pool after every call).
const { pool } = require('./index');
const { runMigrations } = require('./migrate');

const MIGRATION_LOCK_ID = 727002;

/**
 * Acquire the migration advisory lock, run migrations exactly once, then
 * release the lock — regardless of success or failure. BLOCKING
 * (pg_advisory_lock, not pg_try_advisory_lock): during a rolling deploy two
 * containers can briefly run at once; the new one should wait for the old
 * one's migration to finish rather than race it. Bounded by lockTimeoutMs
 * so a genuinely stuck peer surfaces as a clear timeout error instead of
 * hanging forever — Postgres also releases the lock automatically the
 * instant the holding connection closes, so a crashed holder can never
 * wedge this either. Throws (never swallows) on a migration failure so the
 * caller can refuse to start serving traffic.
 */
async function migrateWithLock({ lockTimeoutMs = 60000 } = {}) {
  const lockClient = await pool.connect();
  try {
    const timeoutMs = Math.max(1, Math.floor(Number(lockTimeoutMs) || 60000));
    // SET doesn't accept a bind parameter here — timeoutMs is always an
    // internal numeric config value, never external input, so this interpolation is safe.
    await lockClient.query(`SET lock_timeout = '${timeoutMs}ms'`);
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await runMigrations();
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch((err) => {
        console.error('[migrateWithLock] failed to release the migration advisory lock (connection is being closed regardless):', err.message);
      });
    }
  } finally {
    lockClient.release();
  }
}

module.exports = { migrateWithLock, MIGRATION_LOCK_ID };
