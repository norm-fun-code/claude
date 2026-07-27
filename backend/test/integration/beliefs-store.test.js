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

// Belief hardening pass — genuine authority for confirm/edit/forget, and an
// honest (non-swallowing) management read.
test('a CONFIRMED belief stays bound to the exact statement the user confirmed — nightly re-promotion cannot silently change it', async () => {
  const id = await beliefsStore.upsertBelief({
    kind: 'dismissal_pattern', dedupKey: key('confirm-a'),
    statement: 'Original nightly statement.', confidence: 0.6, evidence: { n: 3 },
  });
  assert.equal(await beliefsStore.confirm(id), true);

  // The nightly promoter re-running the same deterministic dedupKey (the
  // near-guaranteed nightly occurrence for dismissal_pattern/
  // recommendation_outcome kinds) must be a no-op against a confirmed belief.
  const reupsertId = await beliefsStore.upsertBelief({
    kind: 'dismissal_pattern', dedupKey: key('confirm-a'),
    statement: 'A newer nightly statement that would silently overwrite confirmation.', confidence: 0.9, evidence: { n: 9 },
  });
  assert.equal(reupsertId, null, 'upsert against a confirmed (locked) belief returns null (no-op)');

  const { rows } = await db.query(`SELECT statement, confirmed_at, user_locked FROM beliefs WHERE id = $1`, [id]);
  assert.equal(rows[0].statement, 'Original nightly statement.', 'confirmed statement is preserved, not overwritten');
  assert.ok(rows[0].confirmed_at, 'confirmation timestamp is preserved');
  assert.equal(rows[0].user_locked, true);
});

test('a user-EDITED belief is authoritative — later automated extraction cannot overwrite it', async () => {
  const id = await beliefsStore.upsertBelief({
    kind: 'user_statement', dedupKey: key('edit-a'), statement: 'System-extracted statement.',
  });
  assert.equal(await beliefsStore.updateStatement(id, 'User-corrected statement.'), true);

  const reupsertId = await beliefsStore.upsertBelief({
    kind: 'user_statement', dedupKey: key('edit-a'), statement: 'A later re-extraction that should not win.',
  });
  assert.equal(reupsertId, null, 'upsert against a user-edited (locked) belief returns null (no-op)');

  const { rows } = await db.query(`SELECT statement, user_locked FROM beliefs WHERE id = $1`, [id]);
  assert.equal(rows[0].statement, 'User-corrected statement.');
  assert.equal(rows[0].user_locked, true);
});

test('"Forget" creates a durable tombstone — the same dedup key is never recreated by the next nightly upsert, and is excluded from listAll but not hard-deleted', async () => {
  const id = await beliefsStore.upsertBelief({
    kind: 'dismissal_pattern', dedupKey: key('forget-a'), statement: 'A belief the user says is simply wrong.',
  });
  assert.equal(await beliefsStore.forget(id), true);

  // The next nightly run re-inferring the identical pattern must not
  // resurrect it — neither via the UPDATE path (blocked by status check)
  // nor via a fresh INSERT (blocked by the dedup_key UNIQUE constraint
  // still being occupied by the tombstoned row).
  const reupsertId = await beliefsStore.upsertBelief({
    kind: 'dismissal_pattern', dedupKey: key('forget-a'), statement: 'The same pattern, re-inferred.',
  });
  assert.equal(reupsertId, null, 'forgotten belief is never resurrected');

  const all = await beliefsStore.listAll({ limit: 500 });
  assert.ok(!all.some((b) => b.dedup_key === key('forget-a')), 'forgotten content must not be retrieved or surfaced');

  // Provenance for auditability is preserved — not hard-deleted.
  const { rows } = await db.query(`SELECT status, statement FROM beliefs WHERE dedup_key = $1`, [key('forget-a')]);
  assert.equal(rows.length, 1, 'the row still exists for auditability');
  assert.equal(rows[0].status, 'forgotten');
  assert.equal(rows[0].statement, 'A belief the user says is simply wrong.');
});

test('retired, forgotten, and active beliefs are unambiguous: listAll shows active+retired but never forgotten', async () => {
  const activeId = await beliefsStore.upsertBelief({ kind: 'user_statement', dedupKey: key('state-active'), statement: 'Active.' });
  const retiredId = await beliefsStore.upsertBelief({ kind: 'user_statement', dedupKey: key('state-retired'), statement: 'Retired.' });
  const forgottenId = await beliefsStore.upsertBelief({ kind: 'user_statement', dedupKey: key('state-forgotten'), statement: 'Forgotten.' });
  await beliefsStore.retireById(retiredId);
  await beliefsStore.forget(forgottenId);

  const all = await beliefsStore.listAll({ limit: 500 });
  const byId = new Map(all.map((b) => [b.id, b]));
  assert.equal(byId.get(activeId)?.status, 'active');
  assert.equal(byId.get(retiredId)?.status, 'retired');
  assert.equal(byId.get(forgottenId), undefined, 'forgotten belief is absent from listAll entirely');
});

test('listAll surfaces a real database failure honestly instead of a false empty state', async () => {
  // A negative LIMIT is a genuine Postgres query error (LIMIT must not be
  // negative) — listAll must propagate it, not swallow it into [].
  await assert.rejects(() => beliefsStore.listAll({ limit: -1 }));
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
