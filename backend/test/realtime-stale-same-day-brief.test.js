// Behavioral proof for item 6: realtime voice must not combine a FRESH
// snapshot with an OLDER same-day brief. Drives the REAL production path —
// chat/realtimeTools.js's runTool('get_today_context') — with the snapshot
// composer and DB reads stubbed (deterministic, no DB), so this exercises the
// actual glue code (not just the pure snapshot.js projection function).
const test = require('node:test');
const assert = require('node:assert/strict');

const { runTool } = require('../src/chat/realtimeTools');
const snapshotMod = require('../src/brain/snapshot');
const briefingsStore = require('../src/store/briefings');
const invalidation = require('../src/brain/invalidation');

// This file's bumpDurable()/refresh() calls open a real pool connection
// whenever a DB happens to be reachable (whether or not brain_state_version
// exists yet) — close it explicitly so the process doesn't sit on
// DB_IDLE_TIMEOUT_MS (30s default) before exiting. No-op if nothing ever
// connected (a genuinely DB-less environment).
test.after(async () => {
  await require('../src/db').pool.end().catch(() => {});
});

const RECOVERY = { score: 58, band: 'yellow', proxy: false };
const WORKOUT = { source: 'scheduled', workoutId: 'zone2', label: 'Zone 2', isHard: false };

function fakeSnapshot(localDate) {
  return {
    localDate,
    timezone: 'America/New_York',
    recovery: { value: RECOVERY },
    effectiveWorkout: { value: WORKOUT },
  };
}

test('a same-calendar-day brief whose fieldVersions predate a later recovery change is rejected as stale', async () => {
  const TODAY = '2026-06-11';
  const origBuild = snapshotMod.buildBrainSnapshot;
  const origLatest = briefingsStore.latestBriefing;

  snapshotMod.buildBrainSnapshot = async () => fakeSnapshot(TODAY);
  briefingsStore.latestBriefing = async () => ({
    generated_at: `${TODAY}T11:00:00.000Z`, // built THIS morning — same calendar day
    content: {
      localDate: TODAY,
      chiefBrief: { synthesis: 'Stale synthesis from this morning', action: 'Stale action', risk: 'Stale risk' },
      // Stamped at build time against whatever the bus read then.
      fieldVersions: { recovery: 3, effectiveWorkout: 1, todayForecast: 1 },
    },
  });

  // Simulate a LATER recovery-relevant event (an ingest bump) by directly
  // bumping the real invalidation bus past what the brief reflects — this is
  // the actual mechanism store/metrics.js's insertMetrics drives in production.
  // bumpDurable (not bump) so the durable write-through has definitely landed
  // (or definitely failed) before this proceeds — bump()'s write-through is
  // fire-and-forget, and a pending write resolving mid-test (with a real DB
  // behind it, as CI/this env has) could otherwise race the assertions below.
  // This test only needs the IN-PROCESS version bumped (applyLocal runs
  // synchronously inside bumpDurable before the durable write is even
  // attempted — see invalidation.js) — it doesn't depend on brain_state_version
  // actually existing, so a genuine durable-persistence failure (e.g. this
  // suite's pre-migration DB in CI) is expected and irrelevant here.
  await invalidation.bumpDurable('recovery_change').catch(() => {});
  await invalidation.bumpDurable('recovery_change').catch(() => {});
  await invalidation.bumpDurable('recovery_change').catch(() => {}); // now well past the brief's recorded version 3

  try {
    const result = await runTool('get_today_context', {});
    // The date matched, but the bus moved since the brief was built — must be
    // rejected as current, not silently narrated as "this morning's brief."
    assert.equal(result.briefIsCurrent, false);
    assert.equal(result.synthesis, null);
    assert.equal(result.action, null);
    assert.equal(result.risk, null);
    // The canonical (snapshot-sourced) facts are still returned — voice can
    // still answer "what's my recovery/workout" correctly even while the
    // BRIEF narration is suppressed.
    assert.equal(result.recovery.band, 'yellow');
    assert.equal(result.workout.type, 'Zone 2');
  } finally {
    snapshotMod.buildBrainSnapshot = origBuild;
    briefingsStore.latestBriefing = origLatest;
  }
});

test('a same-calendar-day brief whose fieldVersions MATCH the current bus is accepted as current', async () => {
  const TODAY = '2026-06-12';
  const origBuild = snapshotMod.buildBrainSnapshot;
  const origLatest = briefingsStore.latestBriefing;

  snapshotMod.buildBrainSnapshot = async () => fakeSnapshot(TODAY);
  // Settle against the SAME authoritative source getTodayContext()'s internal
  // refresh() will read, so the captured baseline can't be a stale in-process
  // value that a pending durable write later overtakes.
  await invalidation.refresh();
  const nowVersions = {
    recovery: invalidation.versionOf('recovery'),
    effectiveWorkout: invalidation.versionOf('effectiveWorkout'),
    todayForecast: invalidation.versionOf('todayForecast'),
  };
  briefingsStore.latestBriefing = async () => ({
    generated_at: `${TODAY}T11:00:00.000Z`,
    content: {
      localDate: TODAY,
      chiefBrief: { synthesis: 'Fresh synthesis', action: 'Fresh action', risk: 'Fresh risk' },
      fieldVersions: nowVersions, // built against exactly the current bus state
    },
  });

  try {
    const result = await runTool('get_today_context', {});
    assert.equal(result.briefIsCurrent, true);
    assert.equal(result.synthesis, 'Fresh synthesis');
  } finally {
    snapshotMod.buildBrainSnapshot = origBuild;
    briefingsStore.latestBriefing = origLatest;
  }
});
