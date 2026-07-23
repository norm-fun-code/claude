// Ask NormOS 500 bug fix — mobile side: useChat.ts used to discard the
// backend's error code/body and show the SAME undifferentiated
// "NormOS hit an error (status)" message for every kind of failure
// (truncation, decline, provider outage, or anything else). mapAskError is
// the pure decision logic extracted so it's directly testable without
// rendering the hook — see src/hooks/useChat.ts for the wiring.
//
//   node --experimental-strip-types --test src/lib/askError.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapAskError, NETWORK_ERROR_MESSAGE } from './askError.ts';

test('ask_truncated maps to a truncation-specific, retryable message — never the raw backend error text', () => {
  const info = mapAskError(503, { error: 'internal detail should not leak', code: 'ask_truncated' });
  assert.equal(info.code, 'ask_truncated');
  assert.equal(info.retryable, true);
  assert.ok(!info.message.includes('internal detail should not leak'));
  assert.match(info.message, /finish|limit/i);
});

test('ask_declined maps to a decline-specific message', () => {
  const info = mapAskError(503, { error: 'x', code: 'ask_declined' });
  assert.equal(info.code, 'ask_declined');
  assert.equal(info.retryable, true);
  assert.match(info.message, /declined/i);
});

test('ask_unavailable maps to a provider-unavailable message', () => {
  const info = mapAskError(503, { error: 'x', code: 'ask_unavailable' });
  assert.equal(info.code, 'ask_unavailable');
  assert.equal(info.retryable, true);
  assert.match(info.message, /unavailable/i);
});

test('an unrecognized/missing code falls back to the prior generic status message (back-compat with any other 4xx/5xx route)', () => {
  const info = mapAskError(500, { error: 'boom' });
  assert.equal(info.code, null);
  assert.equal(info.retryable, true);
  assert.match(info.message, /NormOS hit an error \(500\)/);
});

test('a missing/unparseable body (json fetch failed) still produces a safe generic message, not a crash', () => {
  const info = mapAskError(500, undefined);
  assert.equal(info.code, null);
  assert.match(info.message, /NormOS hit an error \(500\)/);
});

test('three distinct backend codes produce three DISTINCT messages (the bug: they were all identical before this fix)', () => {
  const truncated = mapAskError(503, { code: 'ask_truncated' }).message;
  const declined = mapAskError(503, { code: 'ask_declined' }).message;
  const unavailable = mapAskError(503, { code: 'ask_unavailable' }).message;
  const generic = mapAskError(503, {}).message;
  const all = [truncated, declined, unavailable, generic];
  assert.equal(new Set(all).size, 4, 'each failure kind must produce a distinct, non-generic message');
});

test('the network-failure (no response at all) message is a distinct constant, never confused with a backend-classified failure', () => {
  assert.match(NETWORK_ERROR_MESSAGE, /connection/i);
  const backendMessages = [
    mapAskError(503, { code: 'ask_truncated' }).message,
    mapAskError(503, { code: 'ask_declined' }).message,
    mapAskError(503, { code: 'ask_unavailable' }).message,
  ];
  assert.ok(!backendMessages.includes(NETWORK_ERROR_MESSAGE));
});
