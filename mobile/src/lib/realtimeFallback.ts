// Pure reconnect/fallback decision logic for a live Realtime voice session —
// extracted the same way realtimeTurnGate.ts/bargeInGate.ts are, so the
// state machine is unit-testable without react-native-webrtc.
//
// The problem this fixes: previously, ANY Realtime failure (mint failure,
// WebRTC handshake failure, mid-call disconnect) surfaced as a single
// terminal "error" state with a manual Retry button and a permanent text
// pointer to "the regular mic in Ask" — never an automatic reconnect, and
// never an in-place fallback. A user had to notice the banner, close the
// modal, and find a different mic. This makes both decisions (when to retry
// automatically, when to give up and offer the SAME modal's inline
// push-to-talk fallback) explicit and testable.

export type RealtimeFailureCode =
  | 'realtime_disabled' | 'openai_not_configured' | 'openai_auth_failed'
  | 'openai_access_denied' | 'invalid_realtime_model' | 'session_mint_failed'
  | 'webrtc_handshake_failed' | 'network_failure' | 'connection_lost';

// Codes where retrying is pointless — the session will never succeed until
// something outside this call changes (config, entitlement, disabled flag).
// Reconnect attempts are reserved for the transient ones.
const NON_RETRYABLE = new Set<RealtimeFailureCode>([
  'realtime_disabled', 'openai_not_configured', 'openai_auth_failed',
  'openai_access_denied', 'invalid_realtime_model',
]);

const MAX_RECONNECT_ATTEMPTS = 2;
// Short, bounded backoff — this must fail over to push-to-talk QUICKLY (the
// task's explicit "do not sit for 60 seconds" requirement), not retry
// patiently. Two attempts at ~1.5s apart is enough to ride out a one-off
// blip without making the user wait.
const RECONNECT_DELAYS_MS = [1500, 3000];

export interface FallbackDecision {
  /** 'reconnecting' — retry automatically after `delayMs`.
   *  'fallback' — give up on Realtime for this session; offer inline push-to-talk.
   *  'retry_exhausted_fallback' — same as 'fallback', distinguished for logging. */
  action: 'reconnecting' | 'fallback';
  delayMs?: number;
  attempt: number;
}

/** Pure: given a failure code and how many reconnect attempts have already
 *  happened THIS session, decide whether to retry or fall back. */
export function decideFallback(code: RealtimeFailureCode, attemptsSoFar: number): FallbackDecision {
  if (NON_RETRYABLE.has(code) || attemptsSoFar >= MAX_RECONNECT_ATTEMPTS) {
    return { action: 'fallback', attempt: attemptsSoFar };
  }
  return { action: 'reconnecting', delayMs: RECONNECT_DELAYS_MS[attemptsSoFar] ?? RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1], attempt: attemptsSoFar + 1 };
}

export function isRetryable(code: RealtimeFailureCode): boolean {
  return !NON_RETRYABLE.has(code);
}

export const MAX_ATTEMPTS = MAX_RECONNECT_ATTEMPTS;
