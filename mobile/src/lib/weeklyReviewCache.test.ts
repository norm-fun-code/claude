// Weekly-review UUID hardening pass — required regression tests for the
// bounded, persisted weekly-review cache's pure serialize/deserialize logic.
// Run: node --experimental-strip-types --test src/lib/weeklyReviewCache.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeWeeklyReviewCache, deserializeWeeklyReviewCache, WEEKLY_REVIEW_CACHE_MAX_ENTRIES } from './weeklyReviewCache.ts';

function review(headline: string) {
  return { headline, narrative: 'n' };
}

test('required: a serialized cache round-trips through deserialize with identical entries', () => {
  const cache = new Map([
    ['id:a1', review('A')],
    ['week:2026-07-13', review('B')],
  ]);
  const raw = serializeWeeklyReviewCache(cache);
  const restored = deserializeWeeklyReviewCache(raw);
  assert.deepEqual(Array.from(restored.entries()), Array.from(cache.entries()));
});

test('required: deserialize never throws on missing, null, or corrupted storage — always degrades to an empty cache', () => {
  assert.equal(deserializeWeeklyReviewCache(null).size, 0);
  assert.equal(deserializeWeeklyReviewCache(undefined).size, 0);
  assert.equal(deserializeWeeklyReviewCache('').size, 0);
  assert.equal(deserializeWeeklyReviewCache('not json{{{').size, 0);
  assert.equal(deserializeWeeklyReviewCache('{"not":"an array"}').size, 0);
  assert.equal(deserializeWeeklyReviewCache('[["only-one-element"]]').size, 0);
  assert.equal(deserializeWeeklyReviewCache('[[1, {}]]').size, 0, 'a non-string key must be dropped');
  assert.equal(deserializeWeeklyReviewCache('[["k", null]]').size, 0, 'a null review value must be dropped');
});

test('required: bounded retention — serializing more than the max keeps only the most-recently-set entries, never grows unbounded', () => {
  const cache = new Map<string, ReturnType<typeof review>>();
  for (let i = 0; i < WEEKLY_REVIEW_CACHE_MAX_ENTRIES + 5; i++) {
    cache.set(`id:${i}`, review(`R${i}`));
  }
  const restored = deserializeWeeklyReviewCache(serializeWeeklyReviewCache(cache));
  assert.equal(restored.size, WEEKLY_REVIEW_CACHE_MAX_ENTRIES);
  // The oldest entries (0..4) must have been dropped; the most recent ones survive.
  assert.equal(restored.has('id:0'), false);
  assert.equal(restored.has(`id:${WEEKLY_REVIEW_CACHE_MAX_ENTRIES + 4}`), true);
});

test('required: re-setting an EXISTING key updates its value in place without moving it in eviction order (true JS Map semantics — first-inserted is still first-evicted)', () => {
  const cache = new Map<string, ReturnType<typeof review>>();
  for (let i = 0; i < WEEKLY_REVIEW_CACHE_MAX_ENTRIES; i++) cache.set(`id:${i}`, review(`R${i}`));
  // Re-touching the OLDEST entry's value does NOT move it to the end (Map.set
  // on an existing key preserves original insertion position) — it is still
  // the first one evicted once a new entry pushes the cache over the limit.
  cache.set('id:0', review('R0-updated'));
  cache.set(`id:${WEEKLY_REVIEW_CACHE_MAX_ENTRIES}`, review('new'));
  const restored = deserializeWeeklyReviewCache(serializeWeeklyReviewCache(cache));
  assert.equal(restored.has('id:0'), false, 'id:0 was still the first-inserted entry, so it is evicted despite the value update');
  assert.equal(restored.has('id:1'), true, 'the next-oldest entry survives — eviction is strictly by original insertion order');
  assert.equal(restored.has(`id:${WEEKLY_REVIEW_CACHE_MAX_ENTRIES}`), true);
});
