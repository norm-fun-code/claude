// Chief Brief loading state machine (On My Radar audit item 8). Before this,
// the ONLY loading state BriefCard understood was "pending" (from the
// server's chiefBriefPending flag), rendered as static italic text
// ("Finishing today's brief…") with no distinction between "this is the
// very first build of the day" (should show a skeleton) and "we already
// have a good brief, just refreshing it" (should keep showing the last-good
// content, not blank it out) — and no bound on how long "pending" could be
// displayed if a build never resolved. Pure and unit-testable so the state
// transitions are verified without an RN renderer.
//
// Morning-lifecycle follow-up: the first cut of this file could only reach
// 'failed_empty' via a CLIENT fetch error. A build that completed hours ago
// and produced an unusable Chief Brief still returns HTTP 200 (with
// chiefBrief: null, chiefBriefPending: true), so it fell through to
// 'initial_loading' and pulsed a skeleton indefinitely — a failed backend
// state rendered as "loading". The fix is to stop inferring "in flight" from
// the ABSENCE of an error and instead require positive evidence that a build
// is genuinely running right now (`refreshing`, or a live build-job state).
// Anything else with no brief is a failure and says so, with a retry.
export type ChiefBriefState =
  | 'ready'                    // a fresh, current brief — render normally
  | 'refreshing_with_last_good' // a good brief is showing; a rebuild is in flight (or the server is still assembling today's very first one and this ISN'T the first time we've had content)
  | 'initial_loading'          // no brief yet AND a build is genuinely in flight — render a skeleton, not an empty card
  | 'failed_with_last_good'    // the last refresh attempt failed, but we still have good content to show, with a retry affordance
  | 'failed_empty';            // no content at all, and no build is running — show a Retry state, never a spinner forever

/** The server's durable build-job state (backend store/morningBuildJobs.js).
 *  `null` when no job exists for today — e.g. the automatic morning path,
 *  which does not mint job rows, so absence here is NOT evidence of a build
 *  being in flight. */
export type BuildJobState =
  | 'waiting_for_sleep' | 'queued' | 'building' | 'retry_wait' | 'ready' | 'failed' | null;

/** Build-job states that mean work is genuinely still happening server-side. */
const IN_FLIGHT_BUILD_STATES = new Set<string>(['waiting_for_sleep', 'queued', 'building', 'retry_wait']);

export interface ChiefBriefStateInput {
  /** The brief object itself (or null/undefined if none has ever loaded). */
  brief: unknown | null | undefined;
  /** Server's chiefBriefPending flag — true while a fresh brief is still being assembled. */
  pending: boolean;
  /** A refresh/rebuild this client explicitly triggered is currently in flight. */
  refreshing: boolean;
  /** The most recent fetch/refresh attempt ended in an error. */
  error: boolean;
  /** The server's OWN verdict on this build's chiefBrief attempt (backend
   *  brain/claimValidator.js's assessChiefBriefQuality). 'degraded'/'failed'
   *  means the build FINISHED and its output was unusable — a completed
   *  failure, never something more waiting will fix. Undefined on a cached
   *  build that predates the quality contract. */
  quality?: 'fresh' | 'degraded' | 'failed' | null;
  /** Durable build-job state for today, when one is known. */
  buildState?: BuildJobState;
  /** Has the pending state been showing long enough that a skeleton is no
   *  longer honest? Only consulted when neither `quality` nor `buildState`
   *  can settle it (see hasBeenPendingTooLong). */
  pendingTooLong?: boolean;
}

/** Pure, total, deterministic — never throws, always returns exactly one of
 *  the five states above. `brief` truthiness is what separates "we have
 *  something to show" from "we don't," independent of `pending`/`error`, so
 *  a stale-but-present brief is never blanked out just because a rebuild is
 *  in flight or the last one failed. */
export function resolveChiefBriefState(
  { brief, pending, refreshing, error, quality, buildState, pendingTooLong }: ChiefBriefStateInput
): ChiefBriefState {
  if (brief) {
    if (refreshing) return 'refreshing_with_last_good';
    // A fresh build is in flight server-side (chiefBriefPending) while we're
    // still showing a carried-forward one — same user-facing shape as an
    // explicit client-triggered refresh: keep the content, show "Updating…".
    if (pending) return 'refreshing_with_last_good';
    if (error) return 'failed_with_last_good';
    return 'ready';
  }

  // ---- No content to show. The question is only: is one still coming? ----
  if (error) return 'failed_empty';

  // Positive evidence of work in progress is the ONLY thing that earns a
  // skeleton. An in-flight build outranks a stale 'failed' verdict from a
  // previous attempt, so tapping Retry immediately shows progress.
  if (refreshing || IN_FLIGHT_BUILD_STATES.has(String(buildState))) return 'initial_loading';

  // Server truth that the build is over and produced nothing usable. This is
  // the case that used to pulse forever: HTTP 200, chiefBrief null, no error.
  if (buildState === 'failed') return 'failed_empty';
  if (quality === 'degraded' || quality === 'failed') return 'failed_empty';

  // No verdict available either way (a cached build predating the quality
  // contract, or a status endpoint we couldn't reach) — fall back to a time
  // bound so the skeleton can still never run forever.
  if (pendingTooLong) return 'failed_empty';

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

export interface ChiefBriefFailureInput {
  quality?: 'fresh' | 'degraded' | 'failed' | null;
  buildState?: BuildJobState;
  /** Safe, non-prose diagnostic codes from the server (chiefBriefQuality
   *  .reasonCodes / the build job's own reasonCodes). Never model output. */
  reasonCodes?: string[] | null;
  /** True when the draft was fine but persisting it failed. */
  persistenceFailed?: boolean;
}

/** Pure: one short, honest, user-facing sentence explaining why there is no
 *  brief — so the card can say what happened instead of pulsing. Deliberately
 *  maps to fixed copy rather than echoing raw reason codes or any model text:
 *  reason codes are diagnostics for logs, not UI, and the whole point of the
 *  quality gate is that unusable generated prose never reaches the screen. */
export function describeChiefBriefFailure(
  { quality, buildState, reasonCodes, persistenceFailed }: ChiefBriefFailureInput = {}
): string {
  if (persistenceFailed) return "The brief was written but couldn't be saved.";
  const codes = Array.isArray(reasonCodes) ? reasonCodes : [];
  if (codes.some((c) => typeof c === 'string' && c.startsWith('provider'))) {
    return "The writing step didn't respond. Nothing was lost — retrying usually clears it.";
  }
  if (quality === 'failed' || buildState === 'failed') {
    return "The last build finished, but the write-up didn't come back usable.";
  }
  if (quality === 'degraded' || codes.some((c) => typeof c === 'string' && c.includes('underfilled'))) {
    return "The last build came back too thin to trust, so it wasn't published.";
  }
  return "The last build didn't produce a usable brief.";
}
