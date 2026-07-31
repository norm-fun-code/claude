// Pure reconciliation helpers for Today commitments. Network operations can
// finish out of order; these operations preserve the result of every other
// commitment instead of restoring a stale whole-list snapshot on one failure.

export interface IdentifiedCommitment { id: number; }

export function removeCommitment<T extends IdentifiedCommitment>(items: T[], id: number): T[] {
  return items.filter((item) => item.id !== id);
}

export function restoreCommitment<T extends IdentifiedCommitment>(items: T[], original: T, originalIndex: number): T[] {
  if (items.some((item) => item.id === original.id)) return items;
  const index = Math.max(0, Math.min(originalIndex, items.length));
  return [...items.slice(0, index), original, ...items.slice(index)];
}

/** A list response that raced with an in-flight done/skip request must not
 * re-show that pending row before its mutation settles. */
export function hidePendingCommitments<T extends IdentifiedCommitment>(items: T[], pendingIds: ReadonlySet<number>): T[] {
  return items.filter((item) => !pendingIds.has(item.id));
}
