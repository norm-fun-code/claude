// Rebuild resumability hardening pass — pure decision logic extracted from
// useBriefing.ts so it's unit testable (this project's test runner only
// strips TS types, it cannot transform JSX — same pattern as
// briefingMerge.ts/openWeeklyReview.ts/chiefBriefState.ts).

/** The durable client-side identity of an in-flight (or last-known)
 *  rebuild, persisted the instant a rebuild is ACCEPTED. `buildId: null` is
 *  itself meaningful — "the trigger hit lock_contended and must be
 *  retried" — never treated as a pollable id. */
export interface RebuildIdentity {
  buildId: string | null;
  localDay: string;
  startedAt: number;
}

interface RecoveryBuildResponse {
  recoveryBuildId?: string | null;
  currentLocalDate?: string | null;
  localDate?: string | null;
}

/**
 * Converts the self-healing GET /briefing contract into the exact durable
 * identity used by manual rebuilds. `currentLocalDate` wins over `localDate`:
 * a previous-day cached envelope can legitimately enqueue a recovery job for
 * the live day, and the returned job must be polled as today's work.
 */
export function recoveryBuildIdentityFromResponse(
  response: RecoveryBuildResponse,
  now: number = Date.now()
): RebuildIdentity | null {
  const buildId = response.recoveryBuildId || null;
  const localDay = response.currentLocalDate || response.localDate || null;
  if (!buildId || !localDay) return null;
  return { buildId, localDay, startedAt: now };
}

/** Persist and begin following a self-heal job using the same identity/poller
 * contract as a manually-triggered rebuild. Persistence deliberately
 * completes first so closing the app immediately after the GET cannot lose
 * the job the server already started. */
export async function adoptRecoveryBuildFromResponse(
  response: RecoveryBuildResponse,
  persist: (identity: RebuildIdentity) => Promise<void>,
  poll: (buildId: string, localDay: string) => void,
  now: number = Date.now()
): Promise<boolean> {
  const identity = recoveryBuildIdentityFromResponse(response, now);
  if (!identity?.buildId) return false;
  await persist(identity);
  poll(identity.buildId, identity.localDay);
  return true;
}

// A persisted identity older than this (well past any real build or
// retry-wait window) can no longer mean anything useful to resume.
export const MAX_RESUME_AGE_MS = 6 * 60 * 60 * 1000;

export type ResumeDecision =
  | { kind: 'discard' }
  | { kind: 'poll'; buildId: string }
  | { kind: 'retry_trigger' };

/** On mount/foreground: what should the client do with whatever rebuild
 *  identity (if any) was persisted from before? A persisted identity from a
 *  PRIOR local day (the app was closed overnight) or absurdly old is
 *  discarded — resuming it can no longer mean anything. Otherwise, a real
 *  buildId resumes polling that EXACT job; a null buildId (a persisted
 *  "must retry the trigger" marker from lock contention) resumes by
 *  retrying the trigger itself — never by polling nothing. */
export function resolveResumeDecision(
  identity: RebuildIdentity | null | undefined,
  todayLocalDay: string,
  now: number = Date.now()
): ResumeDecision {
  if (!identity) return { kind: 'discard' };
  if (identity.localDay !== todayLocalDay) return { kind: 'discard' };
  if (now - (identity.startedAt || 0) > MAX_RESUME_AGE_MS) return { kind: 'discard' };
  if (identity.buildId) return { kind: 'poll', buildId: identity.buildId };
  return { kind: 'retry_trigger' };
}

/** Validates a 'ready' job's EXACT fetched result before ever reporting the
 *  rebuild as successful — must belong to the job's own local day and carry
 *  a genuinely usable Chief Brief. A 'ready' status whose fetched content
 *  fails either check must be treated as an unverifiable result, never a
 *  success. */
export function isValidReadyResult(
  content: { localDate?: string | null; chiefBrief?: unknown } | null | undefined,
  expectedLocalDay: string
): boolean {
  if (!content) return false;
  if (content.localDate && content.localDate !== expectedLocalDay) return false;
  if (!content.chiefBrief) return false;
  return true;
}

export type TriggerOutcome =
  | { kind: 'poll'; buildId: string }
  | { kind: 'retry' }
  | { kind: 'give_up' };

/** Classifies a POST /briefing/rebuild response into what the client should
 *  do next. A real `buildId` (fresh trigger, or an already-running job
 *  being adopted) always means "poll it". `buildId: null` with
 *  `retryable: true` (lock_contended, no owner job row discoverable yet)
 *  means "back off and re-POST the trigger shortly" — NEVER "poll a null
 *  id as though it were a valid job". Anything else (no id, not retryable)
 *  is an honest failure. */
export function classifyTriggerResponse(json: { buildId?: string | null; retryable?: boolean }): TriggerOutcome {
  if (json.buildId) return { kind: 'poll', buildId: json.buildId };
  if (json.retryable) return { kind: 'retry' };
  return { kind: 'give_up' };
}
