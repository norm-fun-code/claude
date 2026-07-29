// Server-authoritative "which turn is current" tracker — the write side of
// barge-in hardening (see realtimeBargeInHardening.test.js for the full
// mutating-tool acceptance scenarios). Pure module, no DB/network.
const test = require('node:test');
const assert = require('node:assert/strict');
const turnAuthority = require('../src/chat/realtimeTurnAuthority');

test.beforeEach(() => turnAuthority._reset());

test('a session with no recorded turn yet authorizes any turnId — nothing to compare against', () => {
  assert.equal(turnAuthority.isTurnAuthorized('s1', '5'), true);
});

test('advanceTurn(sessionId, N) authorizes turn N and everything at or above it', () => {
  turnAuthority.advanceTurn('s1', '3');
  assert.equal(turnAuthority.isTurnAuthorized('s1', '3'), true);
  assert.equal(turnAuthority.isTurnAuthorized('s1', '4'), true);
});

test('required: a turn below the session\'s current turn is not authorized — this is the barge-in check', () => {
  turnAuthority.advanceTurn('s1', '3');
  assert.equal(turnAuthority.isTurnAuthorized('s1', '2'), false);
  assert.equal(turnAuthority.isTurnAuthorized('s1', '1'), false);
});

test('advanceTurn is monotonic — a lower/equal turnId arriving out of order never regresses the stored value', () => {
  turnAuthority.advanceTurn('s1', '5');
  turnAuthority.advanceTurn('s1', '2'); // e.g. a delayed network arrival for an older turn-advance call
  assert.equal(turnAuthority.isTurnAuthorized('s1', '3'), false, 'the later, higher turn must still win');
  assert.equal(turnAuthority.isTurnAuthorized('s1', '5'), true);
});

test('different sessions are tracked independently', () => {
  turnAuthority.advanceTurn('s1', '10');
  assert.equal(turnAuthority.isTurnAuthorized('s2', '1'), true, 's2 has no recorded turn of its own');
});

test('a missing sessionId or turnId always authorizes — fail open on malformed input, never silently block a legitimate call', () => {
  assert.equal(turnAuthority.isTurnAuthorized(null, '1'), true);
  assert.equal(turnAuthority.isTurnAuthorized('s1', null), true);
  assert.equal(turnAuthority.isTurnAuthorized('s1', 'not-a-number'), true);
});
