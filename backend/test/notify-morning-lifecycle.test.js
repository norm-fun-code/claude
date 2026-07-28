// The prepare -> validate -> publish morning lifecycle (notify/morning.js's
// warmAndNotify + routes/briefing.js's buildFreshBriefing/publishBriefingDraft
// split). All deps stubbed via their module objects — no DB/network — so this
// proves the CONTROL FLOW: draft build -> final readiness re-check -> publish
// decision -> quality-gated push, independent of any real Postgres state.
const test = require('node:test');
const assert = require('node:assert/strict');

const morning = require('../src/notify/morning');
const devicesStore = require('../src/store/devices');
const nudgesStore = require('../src/store/nudges');
const expo = require('../src/notify/expo');
const briefingRoute = require('../src/routes/briefing');
const sleepReadiness = require('../src/intelligence/sleep-readiness');
const buildJobsStore = require('../src/store/morningBuildJobs');

function stubPushPlumbing() {
  devicesStore.listActiveTokens = async () => ['ExponentPushToken[test]'];
  devicesStore.deactivate = async () => {};
  nudgesStore.recentlySentKeys = async () => new Set();
  nudgesStore.recordNudge = async () => 1;
  nudgesStore.markStatus = async () => {};
  // Default stub — MUST be overridden per-test only when the test wants to
  // observe push behavior; otherwise a forgotten override silently falls
  // through to a REAL Expo network call (slow, non-deterministic, and not
  // what "all deps stubbed -> no DB/network" promises).
  expo.sendPush = async () => ({ sent: 1, invalidTokens: [] });
}

// The automatic path now mints a durable morning_build_jobs row per attempt
// (item D) — stubbed here too so this file's "all deps stubbed, no DB"
// promise still holds; a real DB round-trip would both violate that and
// leave stray rows other tests could trip over.
function stubBuildJobsStore() {
  buildJobsStore.attemptsToday = async () => 0;
  buildJobsStore.createJob = async ({ trigger, state, attemptNumber, localDay } = {}) => (
    { id: 'stub-job-id', local_day: localDay, trigger, state, attempt_number: attemptNumber }
  );
  buildJobsStore.updateJob = async () => null;
}

function withStubs(overrides, fn) {
  const orig = {
    build: briefingRoute.buildFreshBriefing,
    publish: briefingRoute.publishBriefingDraft,
    tokens: devicesStore.listActiveTokens,
    deactivate: devicesStore.deactivate,
    recent: nudgesStore.recentlySentKeys,
    record: nudgesStore.recordNudge,
    mark: nudgesStore.markStatus,
    push: expo.sendPush,
    getReadiness: sleepReadiness.getMorningSleepReadiness,
    attemptsToday: buildJobsStore.attemptsToday,
    createJob: buildJobsStore.createJob,
    updateJob: buildJobsStore.updateJob,
    EMAIL: process.env.EIGHT_SLEEP_EMAIL,
    PASSWORD: process.env.EIGHT_SLEEP_PASSWORD,
  };
  stubPushPlumbing();
  stubBuildJobsStore();
  if (overrides.build) briefingRoute.buildFreshBriefing = overrides.build;
  if (overrides.publish) briefingRoute.publishBriefingDraft = overrides.publish;
  if (overrides.push) expo.sendPush = overrides.push;
  if (overrides.getReadiness) sleepReadiness.getMorningSleepReadiness = overrides.getReadiness;
  if (overrides.eightSleep !== undefined) {
    if (overrides.eightSleep) {
      process.env.EIGHT_SLEEP_EMAIL = 'test@example.com';
      process.env.EIGHT_SLEEP_PASSWORD = 'pw';
    } else {
      delete process.env.EIGHT_SLEEP_EMAIL;
      delete process.env.EIGHT_SLEEP_PASSWORD;
    }
  }
  return fn().finally(() => {
    briefingRoute.buildFreshBriefing = orig.build;
    briefingRoute.publishBriefingDraft = orig.publish;
    devicesStore.listActiveTokens = orig.tokens;
    devicesStore.deactivate = orig.deactivate;
    nudgesStore.recentlySentKeys = orig.recent;
    nudgesStore.recordNudge = orig.record;
    nudgesStore.markStatus = orig.mark;
    expo.sendPush = orig.push;
    sleepReadiness.getMorningSleepReadiness = orig.getReadiness;
    buildJobsStore.attemptsToday = orig.attemptsToday;
    buildJobsStore.createJob = orig.createJob;
    buildJobsStore.updateJob = orig.updateJob;
    if (orig.EMAIL === undefined) delete process.env.EIGHT_SLEEP_EMAIL; else process.env.EIGHT_SLEEP_EMAIL = orig.EMAIL;
    if (orig.PASSWORD === undefined) delete process.env.EIGHT_SLEEP_PASSWORD; else process.env.EIGHT_SLEEP_PASSWORD = orig.PASSWORD;
  });
}

const FRESH_DRAFT = {
  snapshotId: 'snap_1', snapshotAt: '2026-06-11T11:00:00.000Z', snapshotVersion: 1,
  builtAt: '2026-06-11T11:00:05.000Z', weather: { temp: 70, condition: 'Clear' },
  chiefBrief: { synthesis: 'a real one' },
  chiefBriefQuality: { status: 'fresh', reasonCodes: [], fieldWordCounts: {}, fallbackFields: [], violatedChecks: [] },
};

const DEGRADED_DRAFT = {
  ...FRESH_DRAFT,
  chiefBriefQuality: { status: 'degraded', reasonCodes: ['grounded_fallback_used'], fieldWordCounts: {}, fallbackFields: ['synthesis'], violatedChecks: [] },
};

// The verified publication receipt publishBriefingDraft returns once its
// post-save read-back succeeds (morning-notification lifecycle fix, item A) —
// warmAndNotify now requires this (never the in-memory draft alone) before
// it will send a push.
const FRESH_RECEIPT = {
  briefingId: 'briefing-1', snapshotId: FRESH_DRAFT.snapshotId, snapshotVersion: FRESH_DRAFT.snapshotVersion,
  localDay: '2026-06-11', generatedAt: '2026-06-11T11:00:06.000Z', builtAt: FRESH_DRAFT.builtAt,
  qualityStatus: 'fresh', readbackVerified: true,
};

// Scenario 2 (audit fix — DEG task): quality is checked BEFORE publish, not
// after. A degraded (grounded-fallback) draft must never be published,
// TTS-prewarmed, or pushed — the production bug was exactly the opposite of
// this: publishBriefingDraft() ran unconditionally, THEN quality was
// checked, so a draft the system already knew was degraded (the literal
// "Recovery is green at 81 today." fallback) still landed on the app. See
// notify/morning.js's warmAndNotify doc comment for the full fresh-before-
// publish invariant.
test('scenario 2: automatic path — a degraded (grounded-fallback) draft is NEVER published, TTS-prewarmed, or pushed', async () => {
  let publishCalls = 0;
  let pushCalls = 0;
  await withStubs({
    eightSleep: false, // no Eight Sleep configured -> finalMorningGate is a pass-through
    build: async ({ publish } = {}) => {
      assert.equal(publish, false, 'automatic path must request an UNPUBLISHED draft');
      return DEGRADED_DRAFT;
    },
    publish: async () => { publishCalls += 1; },
    push: async () => { pushCalls += 1; return { sent: 1, invalidTokens: [] }; },
  }, async () => {
    const res = await morning.warmAndNotify({ send: true, automatic: true });
    assert.equal(res.built, false, 'nothing is published — a degraded draft must never ship as if it were a completed brief');
    assert.equal(res.sent, 0, 'no "ready" push for a degraded build');
    assert.equal(res.skipped, 'quality_not_fresh');
    assert.equal(res.quality, 'degraded');
    assert.equal(publishCalls, 0, 'publishBriefingDraft must never be called for a degraded draft — no save, no TTS prewarm');
    assert.equal(pushCalls, 0, 'sendPush must never be called for a degraded build');
  });
});

// Scenario 10: returning to bed (or any final-readiness failure) while the
// expensive build was running must discard the UNPUBLISHED draft entirely.
test('scenario 10: automatic path — a final-readiness-gate failure after preparing the draft discards it entirely (no publish, no push, no TTS prewarm)', async () => {
  let publishCalls = 0;
  let pushCalls = 0;
  await withStubs({
    eightSleep: true,
    build: async ({ publish } = {}) => {
      assert.equal(publish, false);
      return FRESH_DRAFT; // would have been a perfectly good build...
    },
    // ...but the final gate says the user is back in bed by the time we'd publish.
    getReadiness: async () => ({ ready: false, reason: 'session_active', evidence: { trigger: 'final_gate' } }),
    publish: async () => { publishCalls += 1; },
    push: async () => { pushCalls += 1; return { sent: 1, invalidTokens: [] }; },
  }, async () => {
    const res = await morning.warmAndNotify({ send: true, automatic: true });
    assert.equal(res.built, false, 'nothing is published — no visible daily briefing from this attempt');
    assert.equal(res.sent, 0);
    assert.equal(res.skipped, 'final_gate_failed');
    assert.equal(res.reason, 'session_active');
    assert.equal(publishCalls, 0, 'publishBriefingDraft must never be called — no save, no TTS prewarm, no next-cycle priming');
    assert.equal(pushCalls, 0);
  });
});

test('automatic path — a FRESH draft that clears the final gate publishes AND sends the ready push', async () => {
  let publishCalls = 0;
  let pushCalls = 0;
  await withStubs({
    eightSleep: true,
    build: async ({ publish } = {}) => { assert.equal(publish, false); return FRESH_DRAFT; },
    getReadiness: async () => ({ ready: true, reason: 'ready', evidence: { trigger: 'final_gate' } }),
    publish: async (draft) => { publishCalls += 1; assert.equal(draft, FRESH_DRAFT); return FRESH_RECEIPT; },
    push: async () => { pushCalls += 1; return { sent: 1, invalidTokens: [] }; },
  }, async () => {
    const res = await morning.warmAndNotify({ send: true, automatic: true });
    assert.equal(res.built, true);
    assert.equal(res.sent, 1);
    assert.equal(res.quality, 'fresh');
    assert.equal(publishCalls, 1);
    assert.equal(pushCalls, 1);
  });
});

// Scenario 12: manual authenticated force:true diagnostics must keep bypassing
// the entire prepare/validate/publish lifecycle — eager build, eager publish,
// eager push, exactly like before this refactor.
test('scenario 12: force:true bypasses the lifecycle entirely — eager publish regardless of automatic', async () => {
  let publishCalledViaEagerBuild = false;
  await withStubs({
    eightSleep: true,
    // force path calls warmBriefing() with publish defaulted to true — the
    // (stubbed) buildFreshBriefing itself is responsible for "publishing" in
    // that eager mode, so publish:true is what we assert here.
    build: async ({ publish } = {}) => {
      assert.equal(publish, true, 'force/manual path must NOT request an unpublished draft');
      publishCalledViaEagerBuild = true;
      // The real buildFreshBriefing attaches the verified receipt onto the
      // response itself when its internal publishBriefingDraft call succeeds
      // (morning-notification lifecycle fix, item A) — mirror that here so
      // the force path has a receipt to push from.
      return { ...FRESH_DRAFT, publicationReceipt: FRESH_RECEIPT };
    },
  }, async () => {
    const res = await morning.warmAndNotify({ send: true, automatic: true, force: true });
    assert.equal(res.sent, 1);
    assert.ok(publishCalledViaEagerBuild);
  });
});
