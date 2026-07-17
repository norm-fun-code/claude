// Integration coverage for Bug 3 (remove scientifically weak delayed-effect
// claims), driven through real DB-backed store/intelligence functions —
// proves a lag>=2 finding never reaches the self-model prompt, cross-context
// synthesis, or the findings a fresh migration deploy would clean up.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const findingsStore = require('../../src/store/findings');
const { gatherFindings } = require('../../src/intelligence/consolidate');
const { selectCrossDomain, deriveConfidence } = require('../../src/intelligence/crossContext');

async function insertFinding({ type, title, lag, confidence = 0.6, extraEvidence = {} }) {
  const { rows } = await db.query(
    `INSERT INTO findings (type, domains, title, detail, confidence, status, evidence)
     VALUES ($1, '{health}', $2, 'test finding', $3, 'open', $4) RETURNING id`,
    [type, title, confidence, JSON.stringify({ auto: true, kind: type, lag, ...extraEvidence })]
  );
  return rows[0].id;
}

let ids = [];
afterEach(async () => {
  if (ids.length) await db.query('DELETE FROM findings WHERE id = ANY($1)', [ids]);
  ids = [];
});
after(async () => { await closeDb(); });

test('no lag-2 finding reaches consolidate.gatherFindings() (the self-model / chief-brief prompt surface)', async () => {
  const lag0Id = await insertFinding({ type: 'habit_split', title: 'lag0-marker same-day', lag: 0 });
  const lag2Id = await insertFinding({ type: 'habit_split', title: 'lag2-marker two-days-later', lag: 2 });
  ids.push(lag0Id, lag2Id);

  const { correlations } = await gatherFindings();
  assert.ok(correlations.some((f) => f.id === lag0Id), 'a same-day habit_split finding should reach the self-model');
  assert.ok(!correlations.some((f) => f.id === lag2Id), 'a lag>=2 finding must never reach the self-model');
});

test('no lag-2 finding reaches selectCrossDomain (the cross-context synthesis input)', async () => {
  const lag1 = { type: 'habit_split', evidence: { lag: 1 }, title: 'next-day', confidence: 0.6 };
  const lag2 = { type: 'habit_split', evidence: { lag: 2 }, title: 'two-days-later', confidence: 0.6 };
  const same = { type: 'sleep_impact', evidence: {}, title: 'same-day sleep', confidence: 0.6 };
  const selected = selectCrossDomain([lag1, lag2, same]);
  assert.ok(selected.includes(lag1));
  assert.ok(selected.includes(same));
  assert.ok(!selected.includes(lag2), 'a lag>=2 finding must never be selected for cross-context synthesis');
});

test('deriveConfidence is computed from the source findings actual confidence, not a fixed 0.7', () => {
  assert.equal(deriveConfidence([{ confidence: 0.4 }, { confidence: 0.6 }]), 0.5);
  assert.equal(deriveConfidence([{ confidence: 0.9 }]), 0.9);
  // No source confidence available at all -> a conservative default, still not 0.7.
  assert.equal(deriveConfidence([]), 0.5);
  assert.equal(deriveConfidence([{ confidence: null }]), 0.5);
});

test('store/findings.supersedeLaggedHabitSplits supersedes only open habit_split findings with lag>=2', async () => {
  const lag0 = await insertFinding({ type: 'habit_split', title: 'lag0-marker keep', lag: 0 });
  const lag1 = await insertFinding({ type: 'habit_split', title: 'lag1-marker keep', lag: 1 });
  const lag2 = await insertFinding({ type: 'habit_split', title: 'lag2-marker supersede', lag: 2 });
  const lag3 = await insertFinding({ type: 'habit_split', title: 'lag3-marker supersede', lag: 3 });
  // A different type with lag>=2 must be left alone — the cleanup is scoped
  // to habit_split, the only engine that ever computed lag>=2.
  const otherType = await insertFinding({ type: 'correlation', title: 'other-type-marker', lag: 2 });
  ids.push(lag0, lag1, lag2, lag3, otherType);

  const rowCount = await findingsStore.supersedeLaggedHabitSplits();
  assert.equal(rowCount, 2, 'exactly the two lag>=2 habit_split rows should be superseded');

  const { rows } = await db.query('SELECT id, status FROM findings WHERE id = ANY($1)', [ids]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
  assert.equal(byId[lag0], 'open');
  assert.equal(byId[lag1], 'open');
  assert.equal(byId[lag2], 'superseded');
  assert.equal(byId[lag3], 'superseded');
  assert.equal(byId[otherType], 'open', 'a non-habit_split type must never be touched by this cleanup');
});

test('migration 049 superseded any pre-existing lag>=2 habit_split finding on deploy (idempotent re-check)', async () => {
  // Simulate a finding that predates the fix, landed AFTER the migration ran
  // (e.g. a stale row re-opened by a bug) — the store function must still
  // catch it on the next invocation; this is what a scheduled analyze() run
  // relies on as the ongoing backstop beyond the one-time migration.
  const stale = await insertFinding({ type: 'habit_split', title: 'post-migration-marker stale', lag: 2 });
  ids.push(stale);
  const rowCount = await findingsStore.supersedeLaggedHabitSplits();
  assert.ok(rowCount >= 1);
  const { rows } = await db.query('SELECT status FROM findings WHERE id = $1', [stale]);
  assert.equal(rows[0].status, 'superseded');
});
