// The morning push must reference the SAME snapshot the in-app brief was built
// from — so a notification and the brief the user opens are provably one cut of
// state, not two. warmAndNotify forwards the briefing's snapshotId/snapshotAt/
// version into the push `data`. All deps stubbed → no DB/network.
const test = require('node:test');
const assert = require('node:assert/strict');

const morning = require('../src/notify/morning');
const devicesStore = require('../src/store/devices');
const nudgesStore = require('../src/store/nudges');
const expo = require('../src/notify/expo');
const briefingRoute = require('../src/routes/briefing');

test('warmAndNotify forwards the briefing snapshot identity into the push payload', async () => {
  const FAKE_BRIEF = {
    snapshotId: 'snap_2026-06-11_a1b2c3d4',
    snapshotAt: '2026-06-11T11:00:00.000Z',
    snapshotVersion: 1,
    builtAt: '2026-06-11T11:00:05.000Z',
    weather: { temp: 70, condition: 'Clear' },
  };
  const orig = {
    build: briefingRoute.buildFreshBriefing,
    tokens: devicesStore.listActiveTokens,
    deactivate: devicesStore.deactivate,
    recent: nudgesStore.recentlySentKeys,
    record: nudgesStore.recordNudge,
    mark: nudgesStore.markStatus,
    push: expo.sendPush,
  };
  let captured = null;
  briefingRoute.buildFreshBriefing = async () => FAKE_BRIEF;
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
    // The push carries the ACTUAL brief's snapshot identity — not a re-minted one.
    assert.equal(captured.data.snapshotId, FAKE_BRIEF.snapshotId);
    assert.equal(captured.data.snapshotAt, FAKE_BRIEF.snapshotAt);
    assert.equal(captured.data.snapshotVersion, FAKE_BRIEF.snapshotVersion);
  } finally {
    briefingRoute.buildFreshBriefing = orig.build;
    devicesStore.listActiveTokens = orig.tokens;
    devicesStore.deactivate = orig.deactivate;
    nudgesStore.recentlySentKeys = orig.recent;
    nudgesStore.recordNudge = orig.record;
    nudgesStore.markStatus = orig.mark;
    expo.sendPush = orig.push;
  }
});
