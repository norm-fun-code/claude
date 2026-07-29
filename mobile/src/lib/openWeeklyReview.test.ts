// Weekly review CTA fix — required regression tests for the canonical
// openWeeklyReview action's pure source-resolution logic.
// Run: node --experimental-strip-types --test src/lib/openWeeklyReview.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWeeklyReviewSource, currentSatisfies, weeklyReviewCacheKey } from './openWeeklyReview.ts';

const CURRENT = { id: 42, weekStart: '2026-07-20' };

test('required: no identity requested (Today/Weekly-Focus "open whatever is current") uses the current payload immediately, no fetch', () => {
  const src = resolveWeeklyReviewSource(CURRENT, {}, () => false);
  assert.deepEqual(src, { kind: 'current' });
});

test('required: a matching reviewId uses the current payload immediately — never re-fetches a review already in hand', () => {
  const src = resolveWeeklyReviewSource(CURRENT, { reviewId: 42 }, () => { throw new Error('cacheHas must not be consulted when current already matches'); });
  assert.deepEqual(src, { kind: 'current' });
});

test('required: a matching weekStart (no reviewId given) also uses the current payload immediately', () => {
  const src = resolveWeeklyReviewSource(CURRENT, { weekStart: '2026-07-20' }, () => false);
  assert.deepEqual(src, { kind: 'current' });
});

test('required: a reviewId that does NOT match current, and not cached, resolves to a fetch by id — never by title/position', () => {
  const src = resolveWeeklyReviewSource(CURRENT, { reviewId: 7 }, () => false);
  assert.deepEqual(src, { kind: 'fetch', cacheKey: 'id:7', query: { id: 7 } });
});

test('required: a weekStart that does not match current, and not cached, resolves to a fetch by weekStart', () => {
  const src = resolveWeeklyReviewSource(CURRENT, { weekStart: '2026-07-13' }, () => false);
  assert.deepEqual(src, { kind: 'fetch', cacheKey: 'week:2026-07-13', query: { weekStart: '2026-07-13' } });
});

test('required: a non-matching identity that IS already cached (a previously fetched review) is served from cache — no network request', () => {
  const src = resolveWeeklyReviewSource(CURRENT, { reviewId: 7 }, (key) => key === 'id:7');
  assert.deepEqual(src, { kind: 'cached', cacheKey: 'id:7' });
});

test('required: no current review and no identity (cold-launch push before any briefing has loaded) degrades to "current" (null) rather than fetching by nothing', () => {
  const src = resolveWeeklyReviewSource(null, {}, () => false);
  assert.deepEqual(src, { kind: 'current' });
});

test('currentSatisfies: false when current is missing entirely', () => {
  assert.equal(currentSatisfies(null, { reviewId: 1 }), false);
});

test('currentSatisfies: false when an identity is requested but current has neither id nor weekStart set (an old cached payload)', () => {
  assert.equal(currentSatisfies({ id: null, weekStart: null }, { reviewId: 1 }), false);
});

test('weeklyReviewCacheKey: null when neither reviewId nor weekStart is given', () => {
  assert.equal(weeklyReviewCacheKey({}), null);
});

test('weeklyReviewCacheKey: prefers reviewId over weekStart when both are given', () => {
  assert.equal(weeklyReviewCacheKey({ reviewId: 5, weekStart: '2026-01-01' }), 'id:5');
});
