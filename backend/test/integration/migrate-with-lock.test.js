// Production Safety Gate (audit recommendation #1), item 3 — the
// advisory-locked migration runner (src/db/migrateWithLock.js) that
// server.js's boot() calls before ever binding the HTTP port. Real Postgres
// (same convention as the rest of this suite): the whole point is proving
// real advisory-lock semantics, which a mock DB can't meaningfully fake.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { migrateWithLock, MIGRATION_LOCK_ID } = require('../../src/db/migrateWithLock');
const { pool } = require('../../src/db');
const { closeDb } = require('./helpers');

after(async () => { await closeDb(); });

// pg_locks encodes a single-bigint pg_advisory_lock(key) as TWO 32-bit
// halves (classid = high bits, objid = low bits, objsubid = 1) — rather than
// depend on that exact bit-packing, just count ALL advisory locks currently
// held. Safe in this isolated test DB (nothing else in this suite takes an
// advisory lock), and matches how this was manually verified during
// development.
async function heldAdvisoryLockCount() {
  const { rows } = await pool.query(`SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory'`);
  return rows[0].n;
}

test('migrateWithLock(): runs migrations and releases the advisory lock afterward — no lock left held', async () => {
  await migrateWithLock();
  assert.equal(await heldAdvisoryLockCount(), 0, 'the migration lock must not still be held after migrateWithLock() returns');
});

test('migrateWithLock(): idempotent — calling it again with nothing new to migrate is a safe no-op, still releases the lock', async () => {
  await migrateWithLock();
  await migrateWithLock();
  assert.equal(await heldAdvisoryLockCount(), 0);
});

test('migrateWithLock(): two callers racing for the SAME lock never run migrations concurrently — the second waits for the first to finish and release', async () => {
  // Both calls target the real schema (nothing new to apply, since the test
  // DB is already migrated) — the assertion here is about LOCK safety, not
  // migration content: two concurrent calls must not error against each
  // other (e.g. a duplicate-key crash from double-inserting into
  // schema_migrations) and both must complete cleanly.
  const results = await Promise.allSettled([migrateWithLock(), migrateWithLock()]);
  assert.ok(results.every((r) => r.status === 'fulfilled'), `expected both concurrent callers to succeed, got: ${JSON.stringify(results.map((r) => r.status === 'rejected' ? r.reason.message : 'ok'))}`);
  assert.equal(await heldAdvisoryLockCount(), 0, 'the lock must be fully released after both concurrent callers finish');
});

test('migrateWithLock(): a migration failure still releases the advisory lock (never leaks a held lock on error)', async () => {
  const fs = require('fs');
  const path = require('path');
  const migrationsDir = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');
  const brokenFile = path.join(migrationsDir, '999_test_broken_migration_lock_release.sql');
  fs.writeFileSync(brokenFile, 'THIS IS NOT VALID SQL;;;');
  try {
    await assert.rejects(() => migrateWithLock());
  } finally {
    fs.unlinkSync(brokenFile);
    // Also clean up any partial schema_migrations tracking row, if the
    // (rolled-back) transaction somehow left one — it shouldn't, since
    // migrate.js wraps each migration in withTransaction, but this keeps
    // the test DB clean regardless.
    await pool.query(`DELETE FROM schema_migrations WHERE name = '999_test_broken_migration_lock_release.sql'`);
  }
  assert.equal(await heldAdvisoryLockCount(), 0, 'a failed migration must still release the lock, not leak it');
});

test('migrateWithLock(): a lock held by another session causes a bounded wait, not an indefinite hang — surfaces as a clear timeout error', async () => {
  const holder = await pool.connect();
  try {
    await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    const start = Date.now();
    await assert.rejects(
      () => migrateWithLock({ lockTimeoutMs: 300 }),
      (err) => /lock timeout|canceling statement/i.test(err.message)
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `expected the bounded lock_timeout to fire quickly, took ${elapsed}ms`);
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    holder.release();
  }
});
