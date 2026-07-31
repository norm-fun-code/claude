// Small, deterministic helpers for mutations initiated from Today. Keeping
// the action outcome separate from rendering prevents a successful canonical
// write from being misreported as a failure merely because its follow-up brief
// refresh is still catching up.

export type PlanConflictResolution =
  | { kind: 'failed'; message: string }
  | { kind: 'updated'; briefSyncPending: boolean; message: string | null };

export type OverrideConfirmation = 'confirmed' | 'rejected' | 'unknown';

/** The workout override belongs to NormOS's canonical/home timezone, never
 * the phone's physical timezone. A traveler near midnight must not alter the
 * next or previous day's plan. */
export function canonicalActionDate(now: Date, timezone: string | null | undefined): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** Truthful outcome copy for a plan-conflict choice. An override and a prose
 * refresh are separate operations: only a failed override means no change. */
export function planConflictResolution(override: OverrideConfirmation, briefRefreshed: boolean): PlanConflictResolution {
  if (override === 'rejected') {
    return { kind: 'failed', message: 'Couldn’t update today’s plan. Nothing was changed — try again.' };
  }
  if (override === 'unknown') {
    return { kind: 'failed', message: 'Couldn’t confirm whether today’s plan changed. Refresh before trying again.' };
  }
  if (!briefRefreshed) {
    return { kind: 'updated', briefSyncPending: true, message: 'Plan updated. The brief is still catching up.' };
  }
  return { kind: 'updated', briefSyncPending: false, message: null };
}
