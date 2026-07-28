import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionContext, createSessionId, createTurnId } from './voiceCoordinator.ts';

test('buildSessionContext carries activeTab, snapshot identity, selection, and language', () => {
  const now = new Date('2026-07-28T14:30:00.000Z');
  const ctx = buildSessionContext({
    tab: 'health',
    snapshotId: 'snap_abc',
    snapshotVersion: 3,
    selection: { kind: 'recovery', id: 'today' },
    sessionId: 'vs_1',
    language: 'en',
    now,
  });
  assert.equal(ctx.activeTab, 'health');
  assert.equal(ctx.snapshotId, 'snap_abc');
  assert.equal(ctx.snapshotVersion, 3);
  assert.deepEqual(ctx.selection, { kind: 'recovery', id: 'today' });
  assert.equal(ctx.localDateTime, now.toISOString());
  assert.equal(ctx.sessionId, 'vs_1');
  assert.equal(ctx.language, 'en');
});

test('buildSessionContext defaults selection to null and language to "en" when omitted', () => {
  const ctx = buildSessionContext({ tab: 'today', sessionId: 'vs_2' });
  assert.equal(ctx.selection, null);
  assert.equal(ctx.language, 'en');
  assert.equal(ctx.snapshotId, null);
  assert.equal(ctx.snapshotVersion, null);
});

test('createSessionId and createTurnId produce distinct, non-empty ids', () => {
  const a = createSessionId();
  const b = createSessionId();
  assert.notEqual(a, b);
  assert.ok(a.length > 5);
  const t1 = createTurnId();
  const t2 = createTurnId();
  assert.notEqual(t1, t2);
});
