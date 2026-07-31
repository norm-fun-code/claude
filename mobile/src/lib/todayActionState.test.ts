import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalActionDate, planConflictResolution } from './todayActionState.ts';

test('a plan choice uses the canonical app day, not the travelling phone day', () => {
  // 11:30pm in New York on July 30, but already July 31 in UTC.
  const now = new Date('2026-07-31T03:30:00.000Z');
  assert.equal(canonicalActionDate(now, 'America/New_York'), '2026-07-30');
});

test('a failed override never looks successful, while a failed brief refresh is reported honestly after a successful override', () => {
  const failed = planConflictResolution('rejected', false);
  assert.equal(failed.kind, 'failed');
  assert.match(failed.message, /Nothing was changed/i);

  const unknown = planConflictResolution('unknown', false);
  assert.equal(unknown.kind, 'failed');
  assert.match(unknown.message, /Couldn’t confirm/i);

  const syncing = planConflictResolution('confirmed', false);
  assert.equal(syncing.kind, 'updated');
  assert.equal(syncing.briefSyncPending, true);
  assert.match(syncing.message ?? '', /Plan updated/i);

  const fresh = planConflictResolution('confirmed', true);
  assert.deepEqual(fresh, { kind: 'updated', briefSyncPending: false, message: null });
});
