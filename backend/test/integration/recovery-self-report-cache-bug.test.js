// Live bug report: "I logged my sleep but no recovery score was created."
// Root cause: liveRecovery()'s promise cache (added for perf — see
// recovery-live-cache.test.js) has no invalidation hook. GET /api/recovery on
// the Health tab's initial load (before the user has logged anything) caches
// a "no data yet" null for RECOVERY_CACHE_MS. When the user then submits the
// sleep check-in, POST /api/recovery/self-report wrote the metrics but
// re-read liveRecovery() WITHOUT invalidating first — so it served the stale
// cached null right back, through the write, and the recovery score never
// appeared. Exercises the real HTTP routes end to end (not the recovery.js
// module directly) since that's exactly the request sequence a live user hit.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');

const app = buildTestApp();

after(async () => {
  await db.query(`DELETE FROM metrics WHERE source = 'self_report'`);
  await closeDb();
});

test('a sleep check-in submitted moments after a cached "no data" GET immediately produces a recovery score', async () => {
  delete require.cache[require.resolve('../../src/intelligence/recovery')];
  process.env.RECOVERY_CACHE_MS = '120000'; // the real production default-ish TTL
  await db.query(`DELETE FROM metrics WHERE domain = 'health' AND metric IN ('sleep_quality', 'sleep_hours') AND source = 'self_report'`);

  // 1) Health tab loads before anything is logged today — this is the call
  //    that populates the cache with null.
  const first = await request(app).get('/api/recovery').set(authHeader());
  assert.equal(first.status, 200);
  assert.equal(first.body.recovery, null, 'sanity: no data yet, so no recovery score');

  // 2) User fills out the sleep check-in a moment later, well within the cache TTL.
  const submit = await request(app)
    .post('/api/recovery/self-report')
    .set(authHeader())
    .send({ quality: 4, hours: 7.5 });
  assert.equal(submit.status, 200);
  assert.ok(submit.body.recovery, 'the self-report response itself must return the freshly computed proxy score, not the stale cached null');
  assert.equal(submit.body.recovery.source, 'self_report');

  // 3) A subsequent GET (still within the same cache TTL) must also reflect it —
  //    confirms the cache itself was invalidated, not just this one response patched.
  const after = await request(app).get('/api/recovery').set(authHeader());
  assert.ok(after.body.recovery, 'a GET right after the check-in must show the new score, not the pre-check-in cached null');
  assert.equal(after.body.recovery.source, 'self_report');

  delete require.cache[require.resolve('../../src/intelligence/recovery')];
  delete process.env.RECOVERY_CACHE_MS;
});
