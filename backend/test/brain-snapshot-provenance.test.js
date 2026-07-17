// Honest provenance + lean projection + single-authority-read guarantees for
// buildBrainSnapshot. These exercise the composition itself with stubbed
// authorities (no DB), so they're deterministic.
const test = require('node:test');
const assert = require('node:assert/strict');
const snap = require('../src/brain/snapshot');

const RECOVERY = { score: 55, band: 'yellow', proxy: false };

// Save/restore stubs on module singletons.
function withStub(modPath, name, fn, run) {
  const mod = require(modPath);
  const orig = mod[name];
  mod[name] = fn;
  return Promise.resolve(run()).finally(() => { mod[name] = orig; });
}

test('an authority FAILURE is freshness "failed" (degraded + error), never flattened into empty', async () => {
  await withStub('../src/store/goals', 'listGoals', async () => { throw new Error('db down'); }, async () => {
    const s = await snap.buildBrainSnapshot({
      recovery: RECOVERY,
      include: { forecast: false, weeklyIntention: false, commitments: false, wealth: false, findings: false, experiments: false, eligibleContext: false, sourceHealth: false },
    });
    assert.equal(s.goals.freshness, 'failed');
    assert.equal(s.goals.degraded, true);
    assert.match(String(s.goals.error), /db down/);
    // And it's surfaced on the snapshot's degraded list.
    assert.ok(s.degraded.some((d) => d.field === 'goals'));
  });
});

test('a genuinely-empty (but successful) collection is "valid-empty", not "unavailable" or degraded', async () => {
  await withStub('../src/store/goals', 'listGoals', async () => [], async () => {
    const s = await snap.buildBrainSnapshot({
      recovery: RECOVERY,
      include: { forecast: false, weeklyIntention: false, commitments: false, wealth: false, findings: false, experiments: false, eligibleContext: false, sourceHealth: false },
    });
    // Zero open goals is a real, current, correct answer — not a data gap and
    // not a failure. Collapsing this into 'unavailable' (indistinguishable
    // from "we don't know") was the exact honesty gap this 5-state model fixes.
    assert.equal(s.goals.freshness, 'valid-empty');
    assert.equal(s.goals.degraded, undefined); // empty ≠ failed
  });
});

test('a scalar fact with no value (no recovery reading) is "unavailable", not "valid-empty"', async () => {
  const s = await snap.buildBrainSnapshot({
    recovery: null, // explicit "known absent" — no HRV reading last night
    include: { forecast: false, goals: false, weeklyIntention: false, commitments: false, wealth: false, findings: false, experiments: false, eligibleContext: false, sourceHealth: false },
  });
  // Recovery absence is a genuine data gap (we don't know today's score) —
  // unlike an empty goals list, this must NOT read as "valid-empty".
  assert.equal(s.recovery.freshness, 'unavailable');
});

test('the lean include projection marks skipped sections not-included (never fake-fresh)', async () => {
  const s = await snap.buildBrainSnapshot({
    recovery: RECOVERY,
    include: { forecast: false, goals: false, weeklyIntention: false, commitments: false, wealth: false, findings: false, experiments: false, eligibleContext: false, sourceHealth: false },
  });
  assert.equal(s.wealth.freshness, 'unavailable');
  assert.equal(s.goals.reason, 'not-included');
  assert.equal(s.experiments.reason, 'not-included');
  // Core recovery + effective workout are still present.
  assert.equal(s.recovery.value.band, 'yellow');
});

test('the forecast consumes the snapshot-resolved workout — getEffectiveWorkout is called ONCE per snapshot', async () => {
  let calls = 0;
  const EW = { source: 'scheduled', workoutId: 'zone2', label: 'Zone 2', isHard: false };
  await withStub('../src/services/workout', 'getEffectiveWorkout', async () => { calls += 1; return EW; }, async () => {
    const s = await snap.buildBrainSnapshot({
      recovery: RECOVERY,
      // Keep forecast ON (it must reuse the resolved workout), skip the heavy rest.
      include: { goals: false, weeklyIntention: false, commitments: false, wealth: false, findings: false, experiments: false, eligibleContext: false, sourceHealth: false },
    });
    // computeTodayForecast ran (recovery has a score) but did NOT re-resolve the
    // workout — so exactly one getEffectiveWorkout call for the whole snapshot.
    assert.equal(calls, 1);
    assert.equal(s.effectiveWorkout.value.label, 'Zone 2');
  });
});

test('recovery freshness is "stale" when the underlying liveRecovery() value came from a cache older than the registry TTL', async () => {
  const recoveryMod = require('../src/intelligence/recovery');
  const origLive = recoveryMod.liveRecovery;
  const origComputedAt = recoveryMod.recoveryComputedAt;
  const OLD_COMPUTE = Date.now() - (recoveryMod.RECOVERY_TTL_MS + 60_000); // well past TTL
  recoveryMod.liveRecovery = async () => ({ score: 61, band: 'yellow', proxy: false });
  recoveryMod.recoveryComputedAt = () => OLD_COMPUTE;
  try {
    // Do NOT pass `recovery` explicitly — force the snapshot to call
    // liveRecovery()/recoveryComputedAt() itself so the stale cache timestamp
    // is actually consulted.
    const s = await snap.buildBrainSnapshot({
      include: { forecast: false, goals: false, weeklyIntention: false, commitments: false, wealth: false, findings: false, experiments: false, eligibleContext: false, sourceHealth: false },
    });
    assert.equal(s.recovery.freshness, 'stale');
    assert.equal(s.recovery.value.score, 61);
  } finally {
    recoveryMod.liveRecovery = origLive;
    recoveryMod.recoveryComputedAt = origComputedAt;
  }
});

test('recovery freshness is "fresh" when the cache is within TTL', async () => {
  const recoveryMod = require('../src/intelligence/recovery');
  const origLive = recoveryMod.liveRecovery;
  const origComputedAt = recoveryMod.recoveryComputedAt;
  recoveryMod.liveRecovery = async () => ({ score: 61, band: 'yellow', proxy: false });
  recoveryMod.recoveryComputedAt = () => Date.now(); // just computed
  try {
    const s = await snap.buildBrainSnapshot({
      include: { forecast: false, goals: false, weeklyIntention: false, commitments: false, wealth: false, findings: false, experiments: false, eligibleContext: false, sourceHealth: false },
    });
    assert.equal(s.recovery.freshness, 'fresh');
  } finally {
    recoveryMod.liveRecovery = origLive;
    recoveryMod.recoveryComputedAt = origComputedAt;
  }
});
