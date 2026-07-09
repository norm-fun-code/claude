// Without leader election, N replicas each running their own in-process
// scheduler would N-way duplicate every scheduled job (morning routine,
// nudges, pushes, weekly review...) the moment this app scales past a
// single Railway instance — the review's risk #2. tryBecomeLeader() uses a
// Postgres session-level advisory lock so only one process ever proceeds;
// this test verifies actual mutual exclusion against a real DB connection
// (a mock would just prove the code calls the right function name, not that
// two real sessions actually contend for the same lock).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const scheduler = require('../../src/scheduler');

const LEADER_LOCK_ID = 727001;

after(async () => {
  await scheduler.releaseLeaderLock();
  await closeDb();
});

test('tryBecomeLeader acquires the lock when uncontended, and a second contender is rejected until it is released', async () => {
  const first = await scheduler.tryBecomeLeader();
  assert.equal(first, true, 'first caller should win an uncontended lock');

  // Simulate a second replica's connection independently contending for the
  // SAME advisory lock (a separate pool client — a mock could never catch a
  // bug where the lock silently isn't actually held across sessions).
  const rival = await db.pool.connect();
  try {
    const { rows } = await rival.query('SELECT pg_try_advisory_lock($1) AS acquired', [LEADER_LOCK_ID]);
    assert.equal(rows[0].acquired, false, 'a second session must NOT be able to acquire a lock the first session still holds');
  } finally {
    rival.release();
  }

  await scheduler.releaseLeaderLock();

  // Now that the first holder released it, a fresh contender must succeed.
  const rival2 = await db.pool.connect();
  try {
    const { rows } = await rival2.query('SELECT pg_try_advisory_lock($1) AS acquired', [LEADER_LOCK_ID]);
    assert.equal(rows[0].acquired, true, 'the lock must become acquirable again once released');
    await rival2.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_ID]);
  } finally {
    rival2.release();
  }
});
