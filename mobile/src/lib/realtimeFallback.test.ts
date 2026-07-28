import test from 'node:test';
import assert from 'node:assert/strict';
import { decideFallback, isRetryable, MAX_ATTEMPTS } from './realtimeFallback.ts';

test('a non-retryable failure (not configured) falls back immediately, no reconnect attempt', () => {
  const d = decideFallback('openai_not_configured', 0);
  assert.equal(d.action, 'fallback');
});

test('required: a transient failure (network) reconnects quickly, bounded, then falls back — never sits for 60s', () => {
  const first = decideFallback('network_failure', 0);
  assert.equal(first.action, 'reconnecting');
  assert.ok(first.delayMs != null && first.delayMs < 5000, 'reconnect delay must be short, not a long patient wait');

  const second = decideFallback('network_failure', 1);
  assert.equal(second.action, 'reconnecting');

  // Attempts exhausted — must now expose the fallback, not keep retrying forever.
  const third = decideFallback('network_failure', MAX_ATTEMPTS);
  assert.equal(third.action, 'fallback');
});

test('webrtc_handshake_failed and connection_lost are retryable', () => {
  assert.equal(isRetryable('webrtc_handshake_failed'), true);
  assert.equal(isRetryable('connection_lost'), true);
  assert.equal(isRetryable('openai_auth_failed'), false);
  assert.equal(isRetryable('realtime_disabled'), false);
});
