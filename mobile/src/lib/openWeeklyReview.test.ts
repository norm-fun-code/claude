// Weekly review CTA fix — required regression tests for the canonical
// openWeeklyReview action's pure source-resolution logic.
// Run: node --experimental-strip-types --test src/lib/openWeeklyReview.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWeeklyReviewSource, currentSatisfies, weeklyReviewCacheKey, isValidReviewId } from './openWeeklyReview.ts';

// Weekly-review UUID hardening pass: backend/src/store/briefings.js's `id`
// is a Postgres UUID string (never a number) — these fixtures use realistic
// UUIDs instead of small integers (42, 7) so the tests can never pass by
// accident against a type that no longer matches production.
const CURRENT_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const OTHER_ID = 'b2c3d4e5-f6a7-4890-9bcd-ef0123456789';
const CURRENT = { id: CURRENT_ID, weekStart: '2026-07-20' };

test('required: no identity requested (Today/Weekly-Focus "open whatever is current") uses the current payload immediately, no fetch', () => {
  const src = resolveWeeklyReviewSource(CURRENT, {}, () => false);
  assert.deepEqual(src, { kind: 'current' });
});

test('required: a matching reviewId uses the current payload immediately — never re-fetches a review already in hand', () => {
  const src = resolveWeeklyReviewSource(CURRENT, { reviewId: CURRENT_ID }, () => { throw new Error('cacheHas must not be consulted when current already matches'); });
  assert.deepEqual(src, { kind: 'current' });
});

test('required: a matching weekStart (no reviewId given) also uses the current payload immediately', () => {
  const src = resolveWeeklyReviewSource(CURRENT, { weekStart: '2026-07-20' }, () => false);
  assert.deepEqual(src, { kind: 'current' });
});

test('required: a reviewId that does NOT match current, and not cached, resolves to a fetch by id — never by title/position', () => {
  const src = resolveWeeklyReviewSource(CURRENT, { reviewId: OTHER_ID }, () => false);
  assert.deepEqual(src, { kind: 'fetch', cacheKey: `id:${OTHER_ID}`, query: { id: OTHER_ID } });
});

test('required: a weekStart that does not match current, and not cached, resolves to a fetch by weekStart', () => {
  const src = resolveWeeklyReviewSource(CURRENT, { weekStart: '2026-07-13' }, () => false);
  assert.deepEqual(src, { kind: 'fetch', cacheKey: 'week:2026-07-13', query: { weekStart: '2026-07-13' } });
});

test('required: a non-matching identity that IS already cached (a previously fetched review) is served from cache — no network request', () => {
  const src = resolveWeeklyReviewSource(CURRENT, { reviewId: OTHER_ID }, (key) => key === `id:${OTHER_ID}`);
  assert.deepEqual(src, { kind: 'cached', cacheKey: `id:${OTHER_ID}` });
});

test('required: no current review and no identity (cold-launch push before any briefing has loaded) degrades to "current" (null) rather than fetching by nothing', () => {
  const src = resolveWeeklyReviewSource(null, {}, () => false);
  assert.deepEqual(src, { kind: 'current' });
});

test('currentSatisfies: false when current is missing entirely', () => {
  assert.equal(currentSatisfies(null, { reviewId: CURRENT_ID }), false);
});

test('currentSatisfies: false when an identity is requested but current has neither id nor weekStart set (an old cached payload)', () => {
  assert.equal(currentSatisfies({ id: null, weekStart: null }, { reviewId: CURRENT_ID }), false);
});

test('weeklyReviewCacheKey: null when neither reviewId nor weekStart is given', () => {
  assert.equal(weeklyReviewCacheKey({}), null);
});

test('weeklyReviewCacheKey: prefers reviewId over weekStart when both are given', () => {
  assert.equal(weeklyReviewCacheKey({ reviewId: OTHER_ID, weekStart: '2026-01-01' }), `id:${OTHER_ID}`);
});

test('required: a reviewId that does NOT match current is never silently satisfied by a matching weekStart alone — a regenerated review for the same week must not be substituted for the exact one requested', () => {
  // Exactly the shape a weekly-review push notification carries: both
  // reviewId AND weekStart. `current` shares the SAME weekStart (e.g. the
  // review was regenerated after the push was sent, so a newer review for
  // that same week is already in memory) but a DIFFERENT id.
  const regenerated = { id: OTHER_ID, weekStart: '2026-07-20' };
  const src = resolveWeeklyReviewSource(regenerated, { reviewId: CURRENT_ID, weekStart: '2026-07-20' }, () => false);
  assert.notEqual(src.kind, 'current', 'must not silently accept the regenerated review just because the week matches');
  assert.deepEqual(src, { kind: 'fetch', cacheKey: `id:${CURRENT_ID}`, query: { id: CURRENT_ID } });
});

// ── Required regression (weekly-review UUID hardening pass) ──────────────
test('required: isValidReviewId accepts a genuine UUID string and rejects a legacy numeric id, a push notification\'s string-encoded number, and non-UUID garbage', () => {
  assert.equal(isValidReviewId(CURRENT_ID), true);
  assert.equal(isValidReviewId(42), false, 'a legacy numeric id must never be trusted as a UUID identity');
  assert.equal(isValidReviewId('42'), false, 'a push payload that stringified a legacy numeric id must not pass either');
  assert.equal(isValidReviewId('not-a-uuid'), false);
  assert.equal(isValidReviewId(null), false);
  assert.equal(isValidReviewId(undefined), false);
});
