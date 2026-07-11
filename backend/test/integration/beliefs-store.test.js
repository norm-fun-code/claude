// Beliefs store against a real Postgres — the durable-knowledge guarantees the
// learning layer rests on: upsert-by-dedup-key (re-promotion updates, never
// duplicates), and retirement that sticks (the nightly promoter must never
// silently resurrect a belief that was turned off).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const beliefsStore = require('../../src/store/beliefs');

const TAG = `belief-test-${Date.now()}`;
const key = (s) => `${TAG}:${s}`;

after(async () => {
  await db.query(`DELETE FROM beliefs WHERE dedup_key LIKE $1`, [`${TAG}:%`]);
  await closeDb();
});

test('upsert inserts once, then updates in place on the same dedup key', async () => {
  const id1 = await beliefsStore.upsertBelief({
    kind: 'dismissal_pattern', dedupKey: key('a'),
    statement: 'They dismissed 3 subscription insights.', confidence: 0.6, evidence: { n: 3 },
  });
  assert.ok(id1 != null);
  const id2 = await beliefsStore.upsertBelief({
    kind: 'dismissal_pattern', dedupKey: key('a'),
    statement: 'They dismissed 5 subscription insights.', confidence: 0.8, evidence: { n: 5 },
  });
  assert.equal(id2, id1, 'same dedup key must update the same row');

  const rows = (await beliefsStore.listActive()).filter((b) => b.dedup_key === key('a'));
  assert.equal(rows.length, 1);
  assert.match(rows[0].statement, /5 subscription insights/);
  assert.equal(rows[0].evidence.n, 5);
});

test('a retired belief is not resurrected by re-promotion', async () => {
  await beliefsStore.upsertBelief({
    kind: 'user_statement', dedupKey: key('b'), statement: 'Original statement.',
  });
  assert.equal(await beliefsStore.retire(key('b')), true);

  // The nightly promoter re-running the same inference must be a no-op now.
  const id = await beliefsStore.upsertBelief({
    kind: 'user_statement', dedupKey: key('b'), statement: 'Re-promoted statement.',
  });
  assert.equal(id, null, 'upsert against a retired belief returns null (no-op)');

  const active = (await beliefsStore.listActive()).filter((b) => b.dedup_key === key('b'));
  assert.equal(active.length, 0, 'retired belief stays out of the active list');
  const { rows } = await db.query(`SELECT statement, status FROM beliefs WHERE dedup_key = $1`, [key('b')]);
  assert.equal(rows[0].status, 'retired');
  assert.equal(rows[0].statement, 'Original statement.', 'retired content is preserved, not overwritten');
});

test('listActive filters by kind', async () => {
  await beliefsStore.upsertBelief({ kind: 'user_statement', dedupKey: key('c1'), statement: 'S1.' });
  await beliefsStore.upsertBelief({ kind: 'dismissal_pattern', dedupKey: key('c2'), statement: 'S2.' });
  const stmts = (await beliefsStore.listActive({ kinds: ['user_statement'] })).filter((b) => b.dedup_key.startsWith(TAG));
  assert.equal(stmts.length, 1);
  assert.equal(stmts[0].dedup_key, key('c1'));
});

// End-to-end: dismissals in the real table -> promoteBeliefs() -> belief row ->
// consolidate's self-model text carries it. This is the full path that makes
// a thumb-tap pattern durable knowledge every surface sees.
test('promoteBeliefs turns >=3 real dismissals of one type into an active belief', async (t) => {
  const dismissedInsights = require('../../src/store/dismissedInsights');
  const keys = [
    `${TAG}_type|insight one`, `${TAG}_type|insight two`, `${TAG}_type|insight three`,
  ];
  t.after(async () => {
    await db.query(`DELETE FROM dismissed_insights WHERE dismiss_key LIKE $1`, [`${TAG}_type|%`]);
    await db.query(`DELETE FROM beliefs WHERE dedup_key = $1`, [`dismissal:${TAG}_type`]);
  });
  for (const k of keys) await dismissedInsights.dismiss(k);

  // extractStatements:false — this test pins the dismissal path; the LLM
  // extraction path has its own tests with a stubbed model.
  const result = await require('../../src/intelligence/beliefs').promoteBeliefs({ extractStatements: false });
  assert.deepEqual(result.errors, []);

  const promoted = (await beliefsStore.listActive()).find((b) => b.dedup_key === `dismissal:${TAG}_type`);
  assert.ok(promoted, 'expected a promoted dismissal_pattern belief');
  assert.match(promoted.statement, /dismissed 3 different/);
});
