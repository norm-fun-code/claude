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

test('an authority FAILURE is represented (degraded + error), not a silent empty', async () => {
  await withStub('../src/store/goals', 'listGoals', async () => { throw new Error('db down'); }, async () => {
    const s = await snap.buildBrainSnapshot({
      recovery: RECOVERY,
      include: { forecast: false, weeklyIntention: false, commitments: false, wealth: false, findings: false, experiments: false, eligibleContext: false, sourceHealth: false },
    });
    assert.equal(s.goals.freshness, 'unavailable');
    assert.equal(s.goals.degraded, true);
    assert.match(String(s.goals.error), /db down/);
    // And it's surfaced on the snapshot's degraded list.
    assert.ok(s.degraded.some((d) => d.field === 'goals'));
  });
});

test('a genuinely-empty (but successful) authority is unavailable WITHOUT degraded', async () => {
  await withStub('../src/store/goals', 'listGoals', async () => [], async () => {
    const s = await snap.buildBrainSnapshot({
      recovery: RECOVERY,
      include: { forecast: false, weeklyIntention: false, commitments: false, wealth: false, findings: false, experiments: false, eligibleContext: false, sourceHealth: false },
    });
    assert.equal(s.goals.freshness, 'unavailable');
    assert.equal(s.goals.degraded, undefined); // empty ≠ failed
  });
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
