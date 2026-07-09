// recordNudge used a plain INSERT — two near-simultaneous callers (e.g. an
// overlapping scheduler tick + a manually-triggered run) could each pass
// their own recentlySentKeys() check before either had recorded anything,
// then both insert AND both push the identical nudge. recordNudge now
// atomically suppresses a concurrent duplicate insert for the same
// dedup_key, returning null so callers know to skip sending.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const nudgesStore = require('../../src/store/nudges');

const KEY = `test-concurrent-dedup-${Date.now()}`;

after(async () => {
  await db.query(`DELETE FROM nudges WHERE dedup_key = $1`, [KEY]);
  await closeDb();
});

test('two concurrent recordNudge calls for the same dedup_key: only one actually inserts', async () => {
  const [id1, id2] = await Promise.all([
    nudgesStore.recordNudge({ dedupKey: KEY, title: 'Race A', body: 'body', status: 'pending' }),
    nudgesStore.recordNudge({ dedupKey: KEY, title: 'Race B', body: 'body', status: 'pending' }),
  ]);
  const ids = [id1, id2].filter((x) => x != null);
  assert.equal(ids.length, 1, 'exactly one of the two concurrent inserts should win');

  const { rows } = await db.query(`SELECT count(*)::int AS n FROM nudges WHERE dedup_key = $1`, [KEY]);
  assert.equal(rows[0].n, 1, 'only one row should actually exist for this dedup_key');
});

test('a later recordNudge for the same key (after the concurrency window) is NOT suppressed by this guard', async () => {
  // recentlySentKeys()-based business dedup is unaffected/unchanged — this
  // just confirms recordNudge itself doesn't permanently block re-use of a
  // dedup_key once it's outside the short concurrency window. We can't wait
  // out the real 10s window in a fast test, so this asserts the SQL's
  // window is time-bounded (not "ever", which would break legitimate
  // multi-day re-sends) by checking a manually-backdated row does not
  // suppress a fresh insert.
  const oldKey = `${KEY}-backdated`;
  await db.query(
    `INSERT INTO nudges (dedup_key, title, body, status, created_at)
     VALUES ($1, 'old', 'body', 'sent', now() - interval '1 hour')`,
    [oldKey]
  );
  const id = await nudgesStore.recordNudge({ dedupKey: oldKey, title: 'fresh', body: 'body', status: 'pending' });
  assert.ok(id != null, 'a dedup_key last used over an hour ago must not be blocked by the concurrency guard');
  await db.query(`DELETE FROM nudges WHERE dedup_key = $1`, [oldKey]);
});
