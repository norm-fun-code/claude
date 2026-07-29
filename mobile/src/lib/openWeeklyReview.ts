// Pure decision logic for the canonical openWeeklyReview action (weekly-
// review CTA fix): given what's already in the current briefing payload,
// an optional identity (reviewId/weekStart) the caller wants, and an
// in-session cache, decide whether to use what's already on screen, reuse a
// cached fetch, or issue a network fetch — NEVER by matching headline text
// or array position (see backend/src/brain/radar.js's weeklyReviewCandidate
// for the server-side half of this contract).
//
// Extracted out of App.tsx so this decision is unit-testable without an RN
// renderer (this repo's mobile test stack only runs pure .ts modules).
export interface WeeklyReviewIdentity {
  reviewId?: number | string | null;
  weekStart?: string | null;
}

export interface WeeklyReviewLike {
  id?: number | string | null;
  weekStart?: string | null;
}

export type WeeklyReviewSource =
  | { kind: 'current' }
  | { kind: 'cached'; cacheKey: string }
  | { kind: 'fetch'; cacheKey: string; query: { id: number | string } | { weekStart: string } };

/** The cache/query key for a given identity — `null` when there's no
 *  identity to key on (the "just show whatever's current" case). */
export function weeklyReviewCacheKey({ reviewId, weekStart }: WeeklyReviewIdentity): string | null {
  if (reviewId != null) return `id:${reviewId}`;
  if (weekStart != null) return `week:${weekStart}`;
  return null;
}

/** Does `current` (the review already embedded in the briefing payload)
 *  already satisfy this request? True when no identity was requested at
 *  all (the plain "open whatever's current" entry points — Today's since-
 *  morning card, Weekly Focus), or when the requested id/weekStart matches
 *  current's own id/weekStart exactly. */
export function currentSatisfies(current: WeeklyReviewLike | null | undefined, identity: WeeklyReviewIdentity): boolean {
  if (!current) return false;
  const { reviewId, weekStart } = identity;
  if (reviewId == null && weekStart == null) return true;
  if (reviewId != null && current.id != null && String(current.id) === String(reviewId)) return true;
  if (weekStart != null && current.weekStart != null && current.weekStart === weekStart) return true;
  return false;
}

/** Resolve where openWeeklyReview should get its data from. `cacheHas`
 *  is a predicate over the same cache keys `weeklyReviewCacheKey` produces,
 *  so the caller's cache implementation (a Map, AsyncStorage, etc.) stays
 *  decoupled from this decision. */
export function resolveWeeklyReviewSource(
  current: WeeklyReviewLike | null | undefined,
  identity: WeeklyReviewIdentity,
  cacheHas: (key: string) => boolean
): WeeklyReviewSource {
  if (currentSatisfies(current, identity)) return { kind: 'current' };
  const cacheKey = weeklyReviewCacheKey(identity);
  if (cacheKey && cacheHas(cacheKey)) return { kind: 'cached', cacheKey };
  if (identity.reviewId != null) return { kind: 'fetch', cacheKey: cacheKey!, query: { id: identity.reviewId } };
  if (identity.weekStart != null) return { kind: 'fetch', cacheKey: cacheKey!, query: { weekStart: identity.weekStart } };
  // No identity, no current review available (e.g. a cold-launch push tap
  // before the briefing has ever loaded) and nothing cached — nothing to
  // fetch by, since fetching "the current review" isn't identity-based.
  // The caller falls back to whatever `current` is (null) and lets the
  // modal's own empty/loading state handle it.
  return { kind: 'current' };
}
