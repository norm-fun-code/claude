// POST /api/briefing/rebuild used an in-memory boolean (_rebuildInFlight) to
// answer "is a rebuild already running" — invisible to a sibling replica, so
// two instances behind a load balancer could each kick off their own 60-90s
// rebuild concurrently. Now uses a Postgres advisory lock, verified here
// against a real second DB session (a mock would not catch a bug where the
// lock isn't actually held across sessions).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');

const REBUILD_LOCK_ID = 727002;
const app = buildTestApp();

after(async () => {
  await closeDb();
});

test('POST /briefing/rebuild reports alreadyRunning when another session already holds the rebuild lock', async () => {
  // Simulate "a rebuild already in flight from another replica" by holding
  // the lock from a separate connection before hitting the route.
  const holder = await db.pool.connect();
  try {
    const { rows } = await holder.query('SELECT pg_try_advisory_lock($1) AS acquired', [REBUILD_LOCK_ID]);
    assert.equal(rows[0].acquired, true, 'test setup: should be able to take the lock when nothing else holds it');

    const res = await request(app).post('/api/briefing/rebuild').set(authHeader());
    assert.equal(res.status, 200);
    assert.equal(res.body.started, false);
    assert.equal(res.body.alreadyRunning, true);
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [REBUILD_LOCK_ID]);
    holder.release();
  }
});

test('POST /briefing/rebuild starts (and the lock becomes free again once the attempt fails/completes) when uncontended', async () => {
  const res = await request(app).post('/api/briefing/rebuild').set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(res.body.started, true);

  // The route's own loopback HTTP call will fail fast in this test environment
  // (no real server bound to `port`), which releases the lock via its error
  // handler — give that a moment, then confirm the lock is free again.
  await new Promise((r) => setTimeout(r, 500));
  const check = await db.pool.connect();
  try {
    const { rows } = await check.query('SELECT pg_try_advisory_lock($1) AS acquired', [REBUILD_LOCK_ID]);
    assert.equal(rows[0].acquired, true, 'lock must be released after the rebuild attempt errors out');
    await check.query('SELECT pg_advisory_unlock($1)', [REBUILD_LOCK_ID]);
  } finally {
    check.release();
  }
});
