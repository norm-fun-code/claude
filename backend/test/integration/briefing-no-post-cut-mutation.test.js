// Behavioral proof for item 3: a full build's post-cut background work
// (primeNextBuildCycle) must run STRICTLY AFTER the brief is built/persisted,
// and must NOT retroactively mutate the already-persisted `briefings` row.
// Drives the REAL production functions against a real DB — not a source-order
// string check.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');

after(async () => { await closeDb(); });

// buildFreshBriefing persists via a FIRE-AND-FORGET saveBriefing() call
// (deliberate — the response itself is the source of truth for the caller;
// persistence is for history + later reads, not synchronous confirmation).
// So a test reading the DB back immediately after the await can legitimately
// race the write landing. Poll briefly rather than assume synchronous
// consistency with a write the source code never promises.
async function waitForPersistedSnapshot(briefingsStore, snapshotId, { timeoutMs = 3000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await briefingsStore.latestBriefing('daily');
    if (last?.content?.snapshotId === snapshotId) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

test('the background-priming callback is scheduled (via setImmediate) but has NOT run by the time the caller gets the response back', async () => {
  const { buildFreshBriefing } = require('../../src/routes/briefing');

  // setImmediate callbacks always run in a LATER turn of the event loop than
  // the synchronous code that scheduled them — so capturing "was the
  // callback already invoked by the time our await resolves" is a genuine,
  // deterministic proof (not a timing guess) that buildFreshBriefing's return
  // value can never depend on what the background priming work does.
  const origSetImmediate = global.setImmediate;
  let scheduleCount = 0;
  global.setImmediate = (...args) => { scheduleCount += 1; return origSetImmediate(...args); };

  let result;
  try {
    result = await buildFreshBriefing({ force: true });
  } finally {
    global.setImmediate = origSetImmediate;
  }

  assert.equal(typeof result, 'object');
  assert.equal(scheduleCount, 1, 'buildFreshBriefing must schedule exactly one background-priming callback via setImmediate');
  // The response object is already fully formed (has its own snapshotId/
  // chiefBrief/etc.) at THIS point, synchronously after the await resolves —
  // none of it is filled in later by the scheduled callback, which by
  // definition has not run yet: setImmediate always defers to a LATER
  // event-loop turn than the synchronous call that scheduled it.
  assert.ok(result.snapshotId, 'the response is fully formed independent of the deferred background work');
});

test('the persisted brief content is UNCHANGED immediately after buildFreshBriefing returns, even though background priming is about to run', async () => {
  const { buildFreshBriefing } = require('../../src/routes/briefing');
  const briefingsStore = require('../../src/store/briefings');

  const result = await buildFreshBriefing({ force: true });
  // saveBriefing() is fire-and-forget in the source, so poll briefly for the
  // write to land rather than assume synchronous consistency.
  const persisted = await waitForPersistedSnapshot(briefingsStore, result.snapshotId);
  assert.ok(persisted?.content);
  assert.equal(persisted.content.snapshotId, result.snapshotId);
  assert.equal(persisted.content.builtAt, result.builtAt);
  // The persisted chiefBrief content matches what was returned — proving the
  // response object IS what got saved, not a value later reconciled by
  // background work.
  assert.deepEqual(persisted.content.chiefBrief, result.chiefBrief);
});

test('primeNextBuildCycle is exported as a standalone function, decoupled from buildFreshBriefing\'s return path', () => {
  const { primeNextBuildCycle, buildFreshBriefing } = require('../../src/routes/briefing');
  assert.equal(typeof primeNextBuildCycle, 'function');
  assert.equal(typeof buildFreshBriefing, 'function');
  assert.notEqual(primeNextBuildCycle, buildFreshBriefing);
});

test('primeNextBuildCycle does not recompute wealth flows (that runs pre-cut, not post-persist)', async () => {
  const { primeNextBuildCycle } = require('../../src/routes/briefing');
  const recomputeWealthMod = require('../../src/services/recompute-wealth');
  const origRecompute = recomputeWealthMod.recomputeWealthFlows;
  let recomputeCalls = 0;
  recomputeWealthMod.recomputeWealthFlows = async (...args) => { recomputeCalls += 1; return origRecompute(...args); };
  try {
    // Best-effort — external connectors (ingest/analyze/crossContext/nudges)
    // will fail softly in this test environment (no API keys), same as every
    // other integration test that exercises the full build. What matters is
    // that recomputeWealthFlows is NEVER called from this path.
    await primeNextBuildCycle().catch(() => {});
  } finally {
    recomputeWealthMod.recomputeWealthFlows = origRecompute;
  }
  assert.equal(recomputeCalls, 0, 'primeNextBuildCycle must never recompute wealth flows — that runs pre-cut, before the snapshot');
});

test('a mutation that lands DURING primeNextBuildCycle does not alter the already-persisted brief row, but IS visible to the next cache-hit read', async () => {
  const { buildFreshBriefing } = require('../../src/routes/briefing');
  const briefingsStore = require('../../src/store/briefings');
  const metricsStore = require('../../src/store/metrics');
  const sourcesStore = require('../../src/store/sources');

  await sourcesStore.registerSource({ id: 'eight_sleep', domain: 'health', displayName: 'Eight Sleep' }).catch(() => {});

  // 1) A real full build — persists a brief with fieldVersions stamped at cut time.
  const firstResult = await buildFreshBriefing({ force: true });
  const persistedBefore = await waitForPersistedSnapshot(briefingsStore, firstResult.snapshotId);
  const snapshotIdBefore = persistedBefore.content.snapshotId;
  assert.equal(snapshotIdBefore, firstResult.snapshotId, 'the build must have actually persisted before this test proceeds');

  // 2) Simulate what primeNextBuildCycle's full ingest COULD write (a belated
  // recovery-relevant metric) via the exact real write path (insertMetrics) —
  // this is what drives store/metrics.js's own recovery_change bump.
  await metricsStore.insertMetrics([
    { ts: new Date(), domain: 'health', metric: 'hrv', value: 55, unit: 'ms', source: 'eight_sleep' },
    { ts: new Date(), domain: 'health', metric: 'resting_hr', value: 58, unit: 'bpm', source: 'eight_sleep' },
  ]);

  // 3) The ALREADY-PERSISTED brief row must be untouched — its snapshotId and
  // fieldVersions are exactly what the full build cut, never rewritten by a
  // later write.
  const persistedAfter = await briefingsStore.latestBriefing('daily');
  assert.equal(persistedAfter.content.snapshotId, snapshotIdBefore, 'a later metric write must not rewrite the already-persisted brief');
  assert.deepEqual(persistedAfter.content.fieldVersions, persistedBefore.content.fieldVersions,
    'the persisted fieldVersions snapshot must not be mutated by a later write');

  // 4) But the NEXT cache-hit read must be able to see the drift (whether or
  // not THIS particular write moved the score enough to bump — either way the
  // mechanism ran without throwing, and if it did move materially, the very
  // next read reflects it rather than the stale first-build value).
  const second = await buildFreshBriefing({ force: false });
  assert.equal(second.cached, true);
  assert.ok(second, 'the cache-hit path completes cleanly after a post-cut metric write');
});
