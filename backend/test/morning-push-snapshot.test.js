// The morning push must reference the SAME persisted, read-back-VERIFIED
// briefing the in-app brief was built from — so a notification and the
// brief the user opens are provably one cut of state, not two. Every
// identifier in the push payload comes from publishBriefingDraft's verified
// publication receipt (morning-notification lifecycle fix, item A), never
// the in-memory draft treated as its own proof. All deps stubbed → no
// DB/network.
const test = require('node:test');
const assert = require('node:assert/strict');

const morning = require('../src/notify/morning');
const devicesStore = require('../src/store/devices');
const nudgesStore = require('../src/store/nudges');
const expo = require('../src/notify/expo');
const briefingRoute = require('../src/routes/briefing');

test('warmAndNotify forwards the VERIFIED publication receipt\'s identity into the push payload', async () => {
  const FAKE_BRIEF = {
    snapshotId: 'snap_2026-06-11_a1b2c3d4',
    snapshotVersion: 1,
    builtAt: '2026-06-11T11:00:05.000Z',
    weather: { temp: 70, condition: 'Clear' },
    // The prepare -> validate -> publish gate (audit fix, item 3) only
    // publishes/pushes a draft whose OWN attempt is quality 'fresh' — a
    // realistic stub of a genuinely fresh build, not just any brief object.
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm' },
    chiefBriefQuality: { status: 'fresh' },
  };
  const FAKE_RECEIPT = {
    briefingId: 'stub-briefing-id',
    snapshotId: FAKE_BRIEF.snapshotId,
    snapshotVersion: FAKE_BRIEF.snapshotVersion,
    localDay: '2026-06-11',
    generatedAt: new Date().toISOString(),
    builtAt: FAKE_BRIEF.builtAt,
    qualityStatus: 'fresh',
    readbackVerified: true,
  };
  const orig = {
    build: briefingRoute.buildFreshBriefing,
    publish: briefingRoute.publishBriefingDraft,
    tokens: devicesStore.listActiveTokens,
    deactivate: devicesStore.deactivate,
    recent: nudgesStore.recentlySentKeys,
    record: nudgesStore.recordNudge,
    mark: nudgesStore.markStatus,
    push: expo.sendPush,
  };
  let captured = null;
  briefingRoute.buildFreshBriefing = async () => FAKE_BRIEF;
  // publishBriefingDraft now performs its own post-save read-back
  // verification (item A) — this is a pure unit test (no DB), so stub it to
  // return the verified receipt directly, exactly like buildFreshBriefing.
  briefingRoute.publishBriefingDraft = async () => FAKE_RECEIPT;
  devicesStore.listActiveTokens = async () => ['ExponentPushToken[test]'];
  devicesStore.deactivate = async () => {};
  nudgesStore.recentlySentKeys = async () => new Set();
  nudgesStore.recordNudge = async () => 1;
  nudgesStore.markStatus = async () => {};
  expo.sendPush = async (_tokens, msg) => { captured = msg; return { sent: 1, invalidTokens: [] }; };

  try {
    const res = await morning.warmAndNotify({ send: true });
    assert.equal(res.sent, 1);
    assert.ok(captured, 'a push was sent');
    assert.equal(captured.data.type, 'morning_briefing');
    // required: Include briefingId, snapshotId, snapshotVersion, localDay,
    // and builtAt in the notification payload — all sourced from the
    // VERIFIED receipt, never the in-memory draft.
    assert.equal(captured.data.briefingId, FAKE_RECEIPT.briefingId);
    assert.equal(captured.data.snapshotId, FAKE_RECEIPT.snapshotId);
    assert.equal(captured.data.snapshotVersion, FAKE_RECEIPT.snapshotVersion);
    assert.equal(captured.data.localDay, FAKE_RECEIPT.localDay);
    assert.equal(captured.data.builtAt, FAKE_RECEIPT.builtAt);
  } finally {
    briefingRoute.buildFreshBriefing = orig.build;
    briefingRoute.publishBriefingDraft = orig.publish;
    devicesStore.listActiveTokens = orig.tokens;
    devicesStore.deactivate = orig.deactivate;
    nudgesStore.recentlySentKeys = orig.recent;
    nudgesStore.recordNudge = orig.record;
    nudgesStore.markStatus = orig.mark;
    expo.sendPush = orig.push;
  }
});

test('required: a publish that never produces a verified receipt (publishBriefingDraft throws) sends NO push', async () => {
  const FAKE_BRIEF = {
    snapshotId: 'snap_no_receipt',
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm' },
    chiefBriefQuality: { status: 'fresh' },
  };
  const orig = {
    build: briefingRoute.buildFreshBriefing,
    publish: briefingRoute.publishBriefingDraft,
    push: expo.sendPush,
  };
  let pushCalled = false;
  briefingRoute.buildFreshBriefing = async () => FAKE_BRIEF;
  briefingRoute.publishBriefingDraft = async () => { throw new Error('publish read-back verification failed'); };
  expo.sendPush = async () => { pushCalled = true; return { sent: 1, invalidTokens: [] }; };

  try {
    const res = await morning.warmAndNotify({ send: true });
    assert.equal(res.sent, 0);
    assert.equal(res.skipped, 'publish_failed');
    assert.equal(pushCalled, false, 'no push may be sent when the publish/read-back failed');
  } finally {
    briefingRoute.buildFreshBriefing = orig.build;
    briefingRoute.publishBriefingDraft = orig.publish;
    expo.sendPush = orig.push;
  }
});
