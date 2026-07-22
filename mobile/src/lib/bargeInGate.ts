// Short client-side duration-gated cancellation for genuine barge-in.
//
// The Realtime session no longer sets turn_detection.interrupt_response
// (see backend/src/services/realtime.js) — that let ANY VAD-detected
// speech_started instantly truncate the assistant's audio, including a
// stray noise blip or speaker echo, before the pre-response transcript
// guard (transcriptGuard.ts) ever got a chance to judge what was actually
// said. This gate replaces that: a burst of user speech only cancels the
// in-flight assistant response after it has SUSTAINED past a short
// threshold, not on the first instant of detected audio energy. A blip that
// stops before the gate elapses (speechStopped() called first) never
// triggers a cancellation at all.
//
// Deliberately NOT a long cooldown or a muted mic — real barge-in still
// needs to feel instant, so the gate is short (default ~200ms): long enough
// to filter out a noise blip, short enough that a person who's actually
// talking still interrupts promptly.
//
// Pure and framework-free — no RN/webrtc dependency — so it's directly
// unit-testable under plain Node. See bargeInGate.test.ts.

export interface BargeInGate {
  /** Call when a speech_started event arrives while the assistant is
   *  speaking. Schedules `onSustained` to run after the gate duration
   *  unless speechStopped() cancels it first. Calling this again before the
   *  gate elapses restarts the timer against the new call's callback. */
  speechStarted(onSustained: () => void): void;
  /** Call on every speech_stopped event. Cancels any pending gate timer —
   *  a no-op if none is pending. */
  speechStopped(): void;
  /** Cancel any pending timer without side effects — call on teardown. */
  dispose(): void;
}

const DEFAULT_GATE_MS = 200;

export function createBargeInGate(gateMs: number = DEFAULT_GATE_MS): BargeInGate {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    speechStarted(onSustained: () => void) {
      clear();
      timer = setTimeout(() => {
        timer = null;
        onSustained();
      }, gateMs);
    },
    speechStopped() {
      clear();
    },
    dispose() {
      clear();
    },
  };
}
