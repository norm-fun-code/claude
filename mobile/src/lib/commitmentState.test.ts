import test from 'node:test';
import assert from 'node:assert/strict';
import { hidePendingCommitments, removeCommitment, restoreCommitment } from './commitmentState.ts';

const a = { id: 1, title: 'A' };
const b = { id: 2, title: 'B' };

test('a failed first commitment does not resurrect a different commitment that already succeeded', () => {
  const afterAStarts = removeCommitment([a, b], a.id);
  const afterBStarts = removeCommitment(afterAStarts, b.id);
  // B commits successfully. A then fails: restore only A, not A's old [A,B]
  // snapshot (which was the production race).
  assert.deepEqual(restoreCommitment(afterBStarts, a, 0), [a]);
});

test('a stale list response cannot re-show a commitment whose mutation is still pending', () => {
  assert.deepEqual(hidePendingCommitments([a, b], new Set([a.id])), [b]);
});

test('restoring is idempotent and keeps the original relative slot when possible', () => {
  assert.deepEqual(restoreCommitment([b], a, 0), [a, b]);
  assert.deepEqual(restoreCommitment([a, b], a, 0), [a, b]);
});
