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

// Cap the build's own external-source and LLM timeouts before the app is built.
// This test is about the LOCK, not the build, and it waits on a real build to
// settle — so how long the build can stall is part of its contract.
//
// The defaults are 12s per external source and 90s per LLM call. This test used
// to assume every source "fails fast" here because no credentials are set, and
// for weather/calendar/Gemini/Anthropic that is true: they throw on the missing
// key before making a request. Notion does not — the SDK client is constructed
// happily and the HTTP call hangs until withTimeout fires at 12s, which is
// LONGER than the window this test allowed for the lock to be released. So the
// test failed on CI while passing locally, where that request is refused
// quickly instead of hanging.
//
// Setting these makes the fail-fast premise TRUE rather than lucky, and covers
// the LLM path too: if an API key ever reaches CI, a 90s generation would break
// this test far more slowly for the same reason. Each integration file runs in
// its own process, so this affects nothing else. Both are read per-build inside
// buildFreshBriefing, so setting them here is picked up.
process.env.BRIEFING_SOURCE_TIMEOUT_MS = '500';
process.env.BRIEFING_LLM_TIMEOUT_MS = '500';

const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');

const REBUILD_LOCK_ID = 727002;
const app = buildTestApp();

after(async () => {
  // buildFreshBriefing's own promise settling (which releases the rebuild
  // lock, polled for below) only means its trailing best-effort ingest/
  // analyze/nudge chain has been KICKED OFF, not that it's finished — those
  // are deliberately fire-and-forget, same as the original handler. Give
  // them a moment to settle before closing the pool, so cleanup doesn't log
  // spurious "pool already ended" noise from work still in flight.
  await new Promise((r) => setTimeout(r, 1000));
  await db.query(`DELETE FROM morning_build_jobs WHERE trigger = 'manual'`);
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
    // Durable build-job contract (audit fix, item 5): 202 + a build id/state
    // the client polls, never a bare {started:false}.
    assert.equal(res.status, 202);
    assert.equal(res.body.alreadyRunning, true);
    assert.ok('state' in res.body);
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [REBUILD_LOCK_ID]);
    holder.release();
  }
});

test('POST /briefing/rebuild starts (and the lock becomes free again once the build settles) when uncontended', async () => {
  const res = await request(app).post('/api/briefing/rebuild').set(authHeader());
  assert.equal(res.status, 202);
  assert.ok(res.body.buildId, 'a durable build id is returned so the client can poll status instead of comparing builtAt');
  assert.equal(res.body.state, 'building');

  // The route now calls buildFreshBriefing() directly (no more loopback HTTP)
  // and releases the lock in a .finally() once that settles. Every external
  // source fails fast here (see the timeout caps at the top of this file), but
  // the build still runs its full best-effort sequence against a real database
  // before returning, so poll for the lock instead of guessing a fixed delay.
  //
  // The window is generous on purpose. A too-tight deadline does not fail when
  // the lock leaks — it fails when a shared CI runner is slow, which is a flake
  // that teaches you nothing. The real assertion is "released, not leaked", and
  // waiting longer costs nothing on a passing run because the poll exits as
  // soon as the lock is free.
  const deadline = Date.now() + 60_000;
  let acquired = false;
  while (Date.now() < deadline) {
    const check = await db.pool.connect();
    try {
      const { rows } = await check.query('SELECT pg_try_advisory_lock($1) AS acquired', [REBUILD_LOCK_ID]);
      acquired = rows[0].acquired;
      if (acquired) {
        await check.query('SELECT pg_advisory_unlock($1)', [REBUILD_LOCK_ID]);
        break;
      }
    } finally {
      check.release();
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(acquired, true, 'lock must be released once the background build settles');
});
