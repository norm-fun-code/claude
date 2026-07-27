// On My Radar audit item 8 — Chief Brief loading state machine.
//   node --experimental-strip-types --test src/lib/chiefBriefState.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChiefBriefState, hasBeenPendingTooLong } from './chiefBriefState.ts';

test('a fresh brief with nothing in flight is "ready"', () => {
  assert.equal(resolveChiefBriefState({ brief: { synthesis: 's' }, pending: false, refreshing: false, error: false }), 'ready');
});

test('no brief ever loaded, nothing failed yet, is "initial_loading" — never a blank/empty card', () => {
  assert.equal(resolveChiefBriefState({ brief: null, pending: true, refreshing: false, error: false }), 'initial_loading');
  assert.equal(resolveChiefBriefState({ brief: null, pending: false, refreshing: false, error: false }), 'initial_loading');
});

test('a good brief plus an explicit refresh in flight keeps showing the last-good content ("refreshing_with_last_good"), never blanks it', () => {
  assert.equal(resolveChiefBriefState({ brief: { synthesis: 's' }, pending: false, refreshing: true, error: false }), 'refreshing_with_last_good');
});

test('a good (carried-forward) brief while the server is still assembling a fresh one is ALSO "refreshing_with_last_good", not "initial_loading"', () => {
  assert.equal(resolveChiefBriefState({ brief: { synthesis: 's' }, pending: true, refreshing: false, error: false }), 'refreshing_with_last_good');
});

test('a good brief whose last refresh attempt failed is "failed_with_last_good" — content stays, with a retry affordance', () => {
  assert.equal(resolveChiefBriefState({ brief: { synthesis: 's' }, pending: false, refreshing: false, error: true }), 'failed_with_last_good');
});

test('an in-flight refresh takes priority over a stale error from a PRIOR attempt', () => {
  assert.equal(resolveChiefBriefState({ brief: { synthesis: 's' }, pending: false, refreshing: true, error: true }), 'refreshing_with_last_good');
});

test('no brief and the last attempt failed is "failed_empty" — never an indefinite pending spinner', () => {
  assert.equal(resolveChiefBriefState({ brief: null, pending: false, refreshing: false, error: true }), 'failed_empty');
  assert.equal(resolveChiefBriefState({ brief: null, pending: true, refreshing: false, error: true }), 'failed_empty');
});

test('hasBeenPendingTooLong is false before the threshold and true at/after it', () => {
  const start = 1_000_000;
  assert.equal(hasBeenPendingTooLong(start, start), false);
  assert.equal(hasBeenPendingTooLong(start, start + 10_000), false);
  assert.equal(hasBeenPendingTooLong(start, start + 44_999), false);
  assert.equal(hasBeenPendingTooLong(start, start + 45_000), true);
  assert.equal(hasBeenPendingTooLong(start, start + 90_000), true);
});

test('hasBeenPendingTooLong is false when nothing has started pending', () => {
  assert.equal(hasBeenPendingTooLong(null, Date.now()), false);
});

test('a custom threshold is respected', () => {
  const start = 0;
  assert.equal(hasBeenPendingTooLong(start, 5_000, 10_000), false);
  assert.equal(hasBeenPendingTooLong(start, 10_000, 10_000), true);
});
