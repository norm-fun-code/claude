// Behavioral proof for item 1, driven through the REAL production call path —
// buildFreshBriefing({force:true}) against a real DB — not a source-string or
// counter-only check. Stubs the module-level authorities getEffectiveWorkout
// and buildWealthInsights (the ones brain/snapshot.js calls internally via a
// fresh require() lookup, which a full build must route through exactly
// once) and asserts each is invoked exactly ONCE for the whole build: the LLM
// prompt, the claim validator, the forecast, and the persisted brief all
// project from the SAME BrainSnapshot instead of each re-resolving.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');

const workoutMod = require('../../src/services/workout');
const wealthInsightsMod = require('../../src/services/wealth-insights');

after(async () => { await closeDb(); });

test('a full build resolves the effective workout and wealth insights exactly ONCE each', async () => {
  const { buildFreshBriefing } = require('../../src/routes/briefing');

  const origEff = workoutMod.getEffectiveWorkout;
  const origWealth = wealthInsightsMod.buildWealthInsights;
  let effCalls = 0;
  let wealthCalls = 0;
  workoutMod.getEffectiveWorkout = async (...args) => { effCalls += 1; return origEff(...args); };
  wealthInsightsMod.buildWealthInsights = async (...args) => { wealthCalls += 1; return origWealth(...args); };

  try {
    const result = await buildFreshBriefing({ force: true });
    assert.equal(typeof result, 'object');
    assert.notEqual(result.cached, true, 'must be a fresh build, not a cache hit');

    // The single BrainSnapshot resolves each authority exactly once — no
    // separate prompt-context read, no separate chiefFacts read, no separate
    // response-card read.
    assert.equal(effCalls, 1, `getEffectiveWorkout must be called exactly once per full build (was called ${effCalls} times)`);
    assert.equal(wealthCalls, 1, `buildWealthInsights must be called exactly once per full build (was called ${wealthCalls} times)`);

    // And the response cards actually reflect that ONE resolution (not a
    // second, independently-derived value).
    assert.ok(result.workout, 'response must carry the workout card derived from the snapshot');
    assert.ok(Array.isArray(result.wealthInsights), 'response must carry the wealthInsights array derived from the snapshot');
  } finally {
    workoutMod.getEffectiveWorkout = origEff;
    wealthInsightsMod.buildWealthInsights = origWealth;
  }
});
