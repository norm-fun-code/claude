// Chief Brief loading state machine (On My Radar audit item 8). Before this,
// the ONLY loading state BriefCard understood was "pending" (from the
// server's chiefBriefPending flag), rendered as static italic text
// ("Finishing today's brief…") with no distinction between "this is the
// very first build of the day" (should show a skeleton) and "we already
// have a good brief, just refreshing it" (should keep showing the last-good
// content, not blank it out) — and no bound on how long "pending" could be
// displayed if a build never resolved. Pure and unit-testable so the state
// transitions are verified without an RN renderer.
export type ChiefBriefState =
  | 'ready'                    // a fresh, current brief — render normally
  | 'refreshing_with_last_good' // a good brief is showing; a rebuild is in flight (or the server is still assembling today's very first one and this ISN'T the first time we've had content)
  | 'initial_loading'          // no brief has ever been shown this session — render a skeleton, not an empty card
  | 'failed_with_last_good'    // the last refresh attempt failed, but we still have good content to show, with a retry affordance
  | 'failed_empty';            // no content at all, and the last attempt failed — show a Retry state, never a spinner forever

export interface ChiefBriefStateInput {
  /** The brief object itself (or null/undefined if none has ever loaded). */
  brief: unknown | null | undefined;
  /** Server's chiefBriefPending flag — true while a fresh brief is still being assembled. */
  pending: boolean;
  /** A refresh/rebuild this client explicitly triggered is currently in flight. */
  refreshing: boolean;
  /** The most recent fetch/refresh attempt ended in an error. */
  error: boolean;
}

/** Pure, total, deterministic — never throws, always returns exactly one of
 *  the five states above. `brief` truthiness is what separates "we have
 *  something to show" from "we don't," independent of `pending`/`error`, so
 *  a stale-but-present brief is never blanked out just because a rebuild is
 *  in flight or the last one failed. */
export function resolveChiefBriefState({ brief, pending, refreshing, error }: ChiefBriefStateInput): ChiefBriefState {
  if (brief) {
    if (refreshing) return 'refreshing_with_last_good';
    // A fresh build is in flight server-side (chiefBriefPending) while we're
    // still showing a carried-forward one — same user-facing shape as an
    // explicit client-triggered refresh: keep the content, show "Updating…".
    if (pending) return 'refreshing_with_last_good';
    if (error) return 'failed_with_last_good';
    return 'ready';
  }
  if (error) return 'failed_empty';
  return 'initial_loading';
}

/** Pure: has a pending/loading state been showing long enough that the UI
 *  should stop looking like "any second now" and offer a manual Retry
 *  instead? Never auto-retries on its own — only exposes the boolean so the
 *  caller can render an affordance; retrying stays a deliberate user action
 *  (never duplicate rebuilds triggered by a timer or by re-renders/polling). */
export function hasBeenPendingTooLong(pendingSinceMs: number | null, nowMs: number, thresholdMs = 45_000): boolean {
  if (pendingSinceMs == null) return false;
  return nowMs - pendingSinceMs >= thresholdMs;
}
