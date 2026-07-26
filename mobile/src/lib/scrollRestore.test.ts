// Today Part 4 regression #19: "Returning to Today preserves scroll
// position."
//   node --experimental-strip-types --test src/lib/scrollRestore.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextScrollY } from './scrollRestore.ts';

test('nextScrollY: returning to today from another tab restores the saved offset', () => {
  assert.equal(nextScrollY('today', 'health', 842), 842);
});

test('nextScrollY: switching to a NON-today tab always snaps to 0, regardless of saved offset', () => {
  assert.equal(nextScrollY('health', 'today', 842), 0);
  assert.equal(nextScrollY('wealth', 'health', 842), 0);
});

test('nextScrollY: already on today (no transition) does not re-apply the saved offset', () => {
  assert.equal(nextScrollY('today', 'today', 842), 0);
});
