// liveRecovery() is called from several independent request paths within one
// briefing build (already deduped against each other via briefing.js's
// `if (!recovery)` guard) AND across separate requests entirely (every
// pull-to-refresh re-checks it on the cache-serve path). It ran 4 serial DB
// round trips on every single call with no caching. Now parallelized and
// memoized (short TTL — recovery only changes when a new Eight Sleep reading
// lands, at most once per night).
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');

// recoveryScore() requires >=8 days of HRV/RHR history to compute a baseline
// (see recovery.js's baselineScore, minN: 8) — without it liveRecovery()
// always returns null, which would make a "cached vs fresh" comparison
// trivially pass on null === null regardless of whether caching works.
before(async () => {
  await db.query(`INSERT INTO sources (id, domain, display_name) VALUES ('eight_sleep', 'health', 'Eight Sleep') ON CONFLICT (id) DO NOTHING`);
  for (let i = 0; i < 14; i++) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    for (const [metric, value, unit] of [
      ['hrv', 50 + (i % 5), 'ms'],
      ['resting_hr', 58 - (i % 3), 'bpm'],
      ['sleep_hours', 7 + (i % 2) * 0.5, 'hours'],
      ['sleep_score', 78 + (i % 4), 'score'],
    ]) {
      await db.query(
        `INSERT INTO metrics (ts, domain, metric, value, unit, source)
         VALUES ($1, 'health', $2, $3, $4, 'eight_sleep')
         ON CONFLICT (ts, domain, metric, source) DO UPDATE SET value = EXCLUDED.value`,
        [`${day}T12:00:00Z`, metric, value, unit]
      );
    }
  }
});

after(async () => {
  await db.query(`DELETE FROM metrics WHERE source = 'eight_sleep'`);
  await closeDb();
});

test('liveRecovery() serves a cached result on a second call within the TTL', async () => {
  delete require.cache[require.resolve('../../src/intelligence/recovery')];
  process.env.RECOVERY_CACHE_MS = '60000'; // long TTL for this test
  const { liveRecovery } = require('../../src/intelligence/recovery');

  const first = await liveRecovery();
  assert.ok(first?.score != null, 'sanity: the seeded baseline should produce a real (non-null) score');

  // Insert a wildly different HRV reading for today — if the second call were
  // NOT cached, this would change the computed score.
  const today = new Date().toISOString().slice(0, 10);
  await db.query(
    `INSERT INTO metrics (ts, domain, metric, value, unit, source)
     VALUES ($1, 'health', 'hrv', 5, 'ms', 'eight_sleep')
     ON CONFLICT (ts, domain, metric, source) DO UPDATE SET value = EXCLUDED.value`,
    [`${today}T12:00:00Z`]
  );

  const second = await liveRecovery();
  assert.deepEqual(second, first, 'a cached call must return the identical result, ignoring the just-inserted data');

  delete require.cache[require.resolve('../../src/intelligence/recovery')];
  delete process.env.RECOVERY_CACHE_MS;
});

test('liveRecovery() picks up new data once the cache TTL has elapsed', async () => {
  delete require.cache[require.resolve('../../src/intelligence/recovery')];
  process.env.RECOVERY_CACHE_MS = '1'; // effectively no caching
  const { liveRecovery } = require('../../src/intelligence/recovery');

  const today = new Date().toISOString().slice(0, 10);
  // Pin today's HRV to a known value first (a prior test in this file may
  // have left today's row at a different value) so the change below is
  // guaranteed to actually differ, not coincidentally match leftover state.
  await db.query(
    `INSERT INTO metrics (ts, domain, metric, value, unit, source)
     VALUES ($1, 'health', 'hrv', 50, 'ms', 'eight_sleep')
     ON CONFLICT (ts, domain, metric, source) DO UPDATE SET value = EXCLUDED.value`,
    [`${today}T12:00:00Z`]
  );
  const first = await liveRecovery();
  await new Promise((r) => setTimeout(r, 20));

  await db.query(
    `INSERT INTO metrics (ts, domain, metric, value, unit, source)
     VALUES ($1, 'health', 'hrv', 5, 'ms', 'eight_sleep')
     ON CONFLICT (ts, domain, metric, source) DO UPDATE SET value = EXCLUDED.value`,
    [`${today}T12:00:00Z`]
  );
  await new Promise((r) => setTimeout(r, 20));

  const second = await liveRecovery();
  assert.notDeepEqual(second, first, 'with a near-zero TTL, a fresh computation should reflect the new HRV reading');

  delete require.cache[require.resolve('../../src/intelligence/recovery')];
  delete process.env.RECOVERY_CACHE_MS;
});

test('liveRecovery() concurrent calls share one in-flight computation', async () => {
  delete require.cache[require.resolve('../../src/intelligence/recovery')];
  process.env.RECOVERY_CACHE_MS = '60000';
  const { liveRecovery } = require('../../src/intelligence/recovery');

  const [a, b] = await Promise.all([liveRecovery(), liveRecovery()]);
  assert.deepEqual(a, b, 'two concurrent calls should resolve to the same cached computation');
  assert.ok(a?.score != null, 'sanity: should be a real score, not null');

  delete require.cache[require.resolve('../../src/intelligence/recovery')];
  delete process.env.RECOVERY_CACHE_MS;
});
