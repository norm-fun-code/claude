// Pure decision: given an AppState transition, should an active voice
// session/recording be torn down? Extracted so the rule is unit-testable
// without importing react-native's AppState. Neither TalkOverlay (Realtime)
// nor AskOverlay's push-to-talk mic had ANY AppState-driven cleanup before
// this — backgrounding mid-call left the WebRTC peer/mic (or an in-flight
// recording/playback) alive with no code path that noticed, a real
// zombie-microphone risk this closes structurally.

export type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

/** True when transitioning to this status should stop an in-progress voice
 *  session/recording/playback. Leaving 'active' never stops anything;
 *  entering 'background' always does (the conversation cannot continue
 *  meaningfully once the app is backgrounded); 'inactive' (iOS's brief
 *  transitional state — an incoming call overlay, the app switcher) is
 *  treated the same as background, since it precedes it and the mic should
 *  not keep running through it either. */
export function shouldStopForAppState(nextStatus: AppStateStatus): boolean {
  return nextStatus === 'background' || nextStatus === 'inactive';
}

/** True when returning to 'active' from a stopped state should be treated
 *  as a fresh mount rather than a resume — i.e. any prior session must be
 *  fully torn down first, never silently reused (a stale session/turnId
 *  surviving a background/foreground cycle is exactly the "duplicate
 *  session" failure mode this guards against). */
export function shouldResetOnForeground(prevStatus: AppStateStatus, nextStatus: AppStateStatus): boolean {
  return nextStatus === 'active' && prevStatus !== 'active';
}
