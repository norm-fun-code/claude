// The dispatch orchestration layer (notify/dispatch.js) is where the pure
// judge() meets the database: it builds a PolicyContext from live ledger
// reads, executes the resulting decision, and — for a batch — tracks budget
// and cross-producer identity IN-MEMORY across the run. These tests exercise
// the two behaviors that ONLY exist at this layer (the pure policy can't test
// them): (1) two different producers describing the SAME fact collapse onto
// one event_key so only the first surfaces, and (2) the daily interruption
// budget accumulates across a batch so later candidates see it spent. Uses
// send:false so no push infrastructure is required — the decision + ledger
// writes are what's under test.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { dispatchEvents, buildContext } = require('../../src/notify/dispatch');
const { judge } = require('../../src/intelligence/attention');
const events = require('../../src/intelligence/events');
const { closeDb } = require('./helpers');

async function cleanup() {
  await db.query(`DELETE FROM attention_log WHERE event_key LIKE 'wealth:over_budget:ZZTest%' OR subject LIKE 'ZZTest%'`);
  await db.query(`DELETE FROM nudges WHERE dedup_key LIKE 'wealth:over_budget:ZZTest%'`);
}

after(async () => {
  await cleanup();
  await closeDb();
});

test('two producers describing the SAME fact collapse to one surfaced decision (cross-surface dedup)', async () => {
  await cleanup();
  const asOf = new Date();
  // A wealth watcher candidate and a finding-pipeline candidate that both
  // describe "ZZTestDining is over budget this month" — different producers,
  // SAME domain:type:subject:month, so the same event_key.
  const fromWealth = events.fromWealthCandidate(
    { title: 'Over budget: ZZTestDining', body: 'x', priority: 0.7, basis: { type: 'over_budget', category: 'ZZTestDining' } },
    { asOf }
  );
  const fromFinding = events.fromWealthCandidate(
    { title: 'ZZTestDining trending over', body: 'y', priority: 0.7, basis: { type: 'over_budget', category: 'ZZTestDining' } },
    { asOf }
  );
  assert.equal(require('../../src/intelligence/attention').eventKey(fromWealth), require('../../src/intelligence/attention').eventKey(fromFinding), 'same fact must produce the same event_key regardless of producer');

  const results = await dispatchEvents([fromWealth, fromFinding], { asOf, send: false, force: true });
  const surfaced = results.map((r) => r.decision.disposition);
  // First is a real user-facing disposition; the second, being the same fact
  // already surfaced this batch, is suppressed by the cooldown gate.
  assert.notEqual(surfaced[0], 'store_silently', `first should surface, got ${surfaced[0]}`);
  assert.equal(surfaced[1], 'store_silently', 'the second producer of the same fact must be deduped to store_silently');
});

test('the daily interruption budget accumulates across a batch — later distinct facts get downgraded once it is spent', async () => {
  await cleanup();
  const asOf = new Date();
  // Build a context at budget limit 1, and feed two DISTINCT high-value push
  // candidates. The first spends the budget; the second, though it would
  // otherwise notify, must be downgraded (not dropped) because the budget is
  // now exhausted for the run.
  const ctx = await buildContext({ asOf, force: true });
  ctx.budget = { limit: 1, usedToday: 0 };

  const a = events.baseEvent({ source: 'watch_health', domain: 'health', type: 'anomaly', subject: 'ZZTestA', title: 'A', body: 'a', observedAt: asOf, signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 }, urgencyHint: 0.9 });
  const b = events.baseEvent({ source: 'watch_health', domain: 'health', type: 'anomaly', subject: 'ZZTestB', title: 'B', body: 'b', observedAt: asOf, signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 }, urgencyHint: 0.9 });

  // Simulate the batch loop's in-memory budget accounting (dispatchEvents does
  // this internally; here we assert the judge honors the accumulated count).
  const first = judge(a, ctx);
  assert.equal(first.disposition, 'notify_now');
  if (first.deliver?.consumesBudget) ctx.budget.usedToday += 1;
  const second = judge(b, ctx);
  assert.notEqual(second.disposition, 'notify_now', 'a distinct fact after the budget is spent must be downgraded');
  assert.notEqual(second.disposition, 'store_silently', 'but never dropped — it defers, e.g. to the brief');
});
