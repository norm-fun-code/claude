// Weekly-review UUID hardening pass: openWeeklyReview's in-session cache
// (App.tsx's `weeklyReviewCache` ref) used to be a plain in-memory Map —
// gone the instant the app was terminated, so reopening a review you'd
// already fetched (e.g. from a push tap while offline, or after a background
// kill) meant either a blank/error state or a redundant refetch. This module
// is the pure serialize/deserialize half of a bounded, AsyncStorage-backed
// persistence layer for that cache — extracted so it's unit-testable without
// an RN renderer or a real AsyncStorage (this repo's mobile test stack only
// runs pure .ts modules).
import type { WeeklyReview } from '../hooks/useBriefing.ts';

export const WEEKLY_REVIEW_CACHE_STORAGE_KEY = 'normos.weeklyReviewCache.v1';
// Bounded retention: an unbounded cache would grow forever across a long
// install lifetime. 10 entries comfortably covers "the last several weeks'
// reviews" (the only realistic offline-reopen scenario) without unbounded
// storage growth.
export const WEEKLY_REVIEW_CACHE_MAX_ENTRIES = 10;

/** Map -> a bounded, JSON-serializable array of [key, review] pairs, keeping
 *  the most-recently-INSERTED entries when the map exceeds the retention
 *  limit. Note: JS `Map` iteration order is insertion order — re-`set`ting an
 *  EXISTING key updates its value in place but does NOT move it to the end,
 *  so eviction here is FIFO-by-first-insertion, not true LRU-by-last-use. */
export function serializeWeeklyReviewCache(cache: Map<string, WeeklyReview>, maxEntries = WEEKLY_REVIEW_CACHE_MAX_ENTRIES): string {
  const entries = Array.from(cache.entries());
  const bounded = entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries;
  return JSON.stringify(bounded);
}

/** The inverse of serializeWeeklyReviewCache — never throws; malformed or
 *  missing storage (a fresh install, a corrupted write, a pre-this-feature
 *  install) degrades to an empty cache, never a crash. */
export function deserializeWeeklyReviewCache(raw: string | null | undefined): Map<string, WeeklyReview> {
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    const entries = parsed.filter(
      (e): e is [string, WeeklyReview] => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && e[1] != null && typeof e[1] === 'object'
    );
    return new Map(entries);
  } catch {
    return new Map();
  }
}
