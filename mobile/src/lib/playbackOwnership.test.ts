// Focused tests for the ownership/request-state logic extracted for item 3
// of the audit (narration playback ownership + cancellation). This project
// has no mobile test framework — playbackOwnership.ts is deliberately pure
// and dependency-free (no expo-av/expo-file-system) so it's directly
// runnable under plain Node's built-in test runner with TypeScript type
// stripping:
//
//   node --experimental-strip-types --test src/lib/playbackOwnership.test.ts
//
// (also wired up as `npm test` in mobile/package.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnershipRegistry, createRequestGuard } from './playbackOwnership.ts';

// ── createOwnershipRegistry ─────────────────────────────────────────────

test('ownership: claim() registers the first owner without evicting anyone', () => {
  const reg = createOwnershipRegistry();
  const a = Symbol('a');
  let aEvicted = false;
  reg.claim(a, () => { aEvicted = true; });
  assert.equal(reg.isOwner(a), true);
  assert.equal(aEvicted, false, 'the very first claim has no previous owner to evict');
});

test('ownership: a SECOND claim by a DIFFERENT owner evicts the first (fires its notifier, transfers isOwner)', () => {
  const reg = createOwnershipRegistry();
  const a = Symbol('a');
  const b = Symbol('b');
  let aEvicted = false;
  reg.claim(a, () => { aEvicted = true; });
  reg.claim(b, () => {});
  assert.equal(aEvicted, true, 'the previous owner\'s own notifier must fire so its UI resets');
  assert.equal(reg.isOwner(a), false, 'the evicted owner must no longer read as the owner');
  assert.equal(reg.isOwner(b), true, 'the new owner must now be the current owner');
});

test('ownership: re-claiming with the SAME owner id does not evict itself (no self-notify)', () => {
  const reg = createOwnershipRegistry();
  const a = Symbol('a');
  let notifyCount = 0;
  reg.claim(a, () => { notifyCount++; });
  reg.claim(a, () => { notifyCount++; }); // e.g. re-registering a fresh resetSelf closure
  assert.equal(notifyCount, 0, 'claiming the SAME owner again must not fire an eviction notifier');
  assert.equal(reg.isOwner(a), true);
});

test('ownership: isOwner() is false for an id that was never claimed', () => {
  const reg = createOwnershipRegistry();
  const a = Symbol('a');
  assert.equal(reg.isOwner(a), false);
});

test('ownership: clear() unconditionally fires the current notifier and clears ownership — "only the owner may stop it" guarantee, part 1', () => {
  const reg = createOwnershipRegistry();
  const a = Symbol('a');
  let notified = false;
  reg.claim(a, () => { notified = true; });
  reg.clear();
  assert.equal(notified, true);
  assert.equal(reg.isOwner(a), false);
});

test('ownership: after eviction, the OLD owner\'s clear() must be a caller-side no-op — explicit-ownership guarantee, part 2', () => {
  // This mirrors lib/voice.ts's releaseIfOwner(): callers MUST check
  // isOwner() themselves before calling clear() — clear() itself is always
  // unconditional (that's how the CURRENT owner legitimately releases). The
  // guarantee lives in the isOwner() check the caller performs, exercised
  // here directly.
  const reg = createOwnershipRegistry();
  const a = Symbol('a');
  const b = Symbol('b');
  let aNotified = false;
  let bNotified = false;
  reg.claim(a, () => { aNotified = true; });
  reg.claim(b, () => { bNotified = true; }); // b pre-empts a; a's notifier already fired once here
  aNotified = false; // reset to isolate the next assertion

  // Card A's cleanup effect runs late (e.g. after B already started) and
  // checks ownership first, exactly like releaseIfOwner:
  const aStillOwns = reg.isOwner(a);
  assert.equal(aStillOwns, false, 'A must recognize it no longer owns playback');
  if (aStillOwns) reg.clear();
  assert.equal(bNotified, false, 'A\'s (correctly skipped) release must never affect B\'s ownership or fire B\'s notifier');
  assert.equal(reg.isOwner(b), true, 'B must remain the owner after A\'s no-op release attempt');
});

test('ownership: three-way preemption chain — each eviction notifies exactly the immediately-previous owner, never an earlier one twice', () => {
  const reg = createOwnershipRegistry();
  const a = Symbol('a');
  const b = Symbol('b');
  const c = Symbol('c');
  const notified: string[] = [];
  reg.claim(a, () => notified.push('a'));
  reg.claim(b, () => notified.push('b'));
  reg.claim(c, () => notified.push('c'));
  assert.deepEqual(notified, ['a', 'b'], 'a is notified when b claims; b is notified when c claims; c is still current, never self-notified');
  assert.equal(reg.isOwner(c), true);
});

// ── createRequestGuard ───────────────────────────────────────────────────

test('requestGuard: begin() returns increasing ids; the most recent id is never stale', () => {
  const guard = createRequestGuard();
  const id1 = guard.begin();
  assert.equal(guard.isStale(id1), false);
  const id2 = guard.begin();
  assert.notEqual(id1, id2);
  assert.equal(guard.isStale(id2), false);
});

test('requestGuard: an OLDER id becomes stale the instant a NEWER request begins — the rapid-double-tap guarantee', () => {
  const guard = createRequestGuard();
  const id1 = guard.begin();
  assert.equal(guard.isStale(id1), false, 'sanity: id1 is current before anything supersedes it');
  const id2 = guard.begin();
  assert.equal(guard.isStale(id1), true, 'id1 must be stale the moment id2 begins — synchronously, not on next tick');
  assert.equal(guard.isStale(id2), false);
});

test('requestGuard: invalidate() makes EVERY id — past AND future — read as stale', () => {
  const guard = createRequestGuard();
  const id1 = guard.begin();
  guard.invalidate();
  assert.equal(guard.isStale(id1), true, 'the in-flight request at time of unmount must become stale');
  const id2 = guard.begin();
  assert.equal(guard.isStale(id2), true, 'a request begun AFTER invalidation must also read as stale — nothing can un-invalidate the guard');
});

test('requestGuard: isLive() reflects invalidation independent of any specific request id', () => {
  const guard = createRequestGuard();
  assert.equal(guard.isLive(), true);
  guard.invalidate();
  assert.equal(guard.isLive(), false);
});

test('requestGuard: two begin() calls in the SAME synchronous tick still produce two distinct ids (no batching ambiguity)', () => {
  const guard = createRequestGuard();
  const ids = [guard.begin(), guard.begin(), guard.begin()];
  assert.equal(new Set(ids).size, 3, 'every begin() call, even fired back-to-back with no await between them, must get a unique id');
  assert.equal(guard.isStale(ids[0]), true);
  assert.equal(guard.isStale(ids[1]), true);
  assert.equal(guard.isStale(ids[2]), false, 'only the LAST of the rapid-fire calls is current');
});
