import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeliveryGeneration, deliverPublishedBriefing, needsBriefingDelivery } from './briefingDelivery.ts';
import { createBriefingDataCoordinator } from './briefingLifecycle.ts';
import { isValidReadyResult } from './rebuildResume.ts';
import type { BriefingData } from '../hooks/useBriefing.ts';
import { resolveChiefBriefState } from './chiefBriefState.ts';

const day = '2026-09-09';
const brief = (snapshotId = 'published') => ({ localDate: day, snapshotId, chiefBrief: { synthesis: 'Your actual brief', action: 'One useful thing' }, chiefBriefQuality: { status: 'fresh' } } as BriefingData);

test('a finished build being downloaded is not failed just because the old wait anchor expired', () => {
  assert.equal(resolveChiefBriefState({ brief: null, pending: true, refreshing: false, error: false, buildState: 'delivering', pendingTooLong: true }), 'initial_loading');
});

test('ready before the snapshot is readable: automatically retries and delivers the exact result to UI and cache', async () => {
  const events: string[] = [];
  const coordinator = createBriefingDataCoordinator({ onState: c => events.push(`screen:${c.snapshotId}`), persist: async c => { events.push(`cache:${c.snapshotId}`); } });
  let reads = 0;
  const result = await deliverPublishedBriefing({
    localDay: day, snapshotId: 'published', today: () => day, isCurrent: () => true,
    read: async () => { reads++; if (reads === 1) throw new Error('offline'); return reads === 2 ? null : brief(); },
    accept: c => { coordinator.commitIncoming(c); }, wait: async () => { events.push('retry'); },
  });
  await coordinator.flush();
  assert.equal(result?.snapshotId, 'published');
  assert.deepEqual(events, ['retry', 'retry', 'screen:published', 'cache:published']);
});

test('an undeliverable ready result leaves the last-good screen and cache untouched', async () => {
  const coordinator = createBriefingDataCoordinator({ onState: () => {}, persist: async () => {} });
  coordinator.hydrate(brief('last-good'));
  let reads = 0;
  const result = await deliverPublishedBriefing({
    localDay: day, snapshotId: 'new', today: () => day, isCurrent: () => true,
    read: async () => { reads++; return null; }, accept: c => { coordinator.commitIncoming(c); }, wait: async () => {},
  });
  assert.equal(result, null);
  assert.equal(reads, 3, 'bounded retries');
  assert.equal(coordinator.current()?.snapshotId, 'last-good');
});

test('a slow pre-background delivery cannot overwrite a newer push or resumed result', async () => {
  const generation = createDeliveryGeneration();
  const ticket = generation.next();
  let release!: (value: BriefingData) => void;
  let screen = 'previous';
  const pending = deliverPublishedBriefing({
    localDay: day, snapshotId: 'old', today: () => day, isCurrent: () => generation.isCurrent(ticket),
    read: () => new Promise(resolve => { release = resolve; }), accept: c => { screen = c.snapshotId!; }, wait: async () => {},
  });
  const resumed = generation.next();
  await deliverPublishedBriefing({ localDay: day, snapshotId: 'new', today: () => day, isCurrent: () => generation.isCurrent(resumed), read: async () => brief('new'), accept: c => { screen = c.snapshotId!; }, wait: async () => {} });
  release(brief('old'));
  assert.equal(await pending, null);
  assert.equal(screen, 'new');
});

test('cancelling during retry does not start another request', async () => {
  let current = true;
  let reads = 0;
  await deliverPublishedBriefing({ localDay: day, today: () => day, isCurrent: () => current, read: async () => { reads++; return null; }, accept: () => assert.fail('cancelled'), wait: async () => { current = false; } });
  assert.equal(reads, 1);
});

test('a build completing across midnight cannot restore yesterday onto Today', async () => {
  let today = day;
  const result = await deliverPublishedBriefing({ localDay: day, snapshotId: 'published', today: () => today, isCurrent: () => true, read: async () => { today = '2026-09-10'; return brief(); }, accept: () => assert.fail('wrong day'), wait: async () => {} });
  assert.equal(result, null);
});

test('ready means real content from the requested snapshot, never an empty object or failed quality', () => {
  assert.equal(isValidReadyResult(brief(), day, 'different'), false);
  assert.equal(isValidReadyResult({ ...brief(), chiefBrief: {} }, day), false);
  assert.equal(isValidReadyResult({ ...brief(), chiefBrief: { action: '   ' } }, day), false);
  assert.equal(isValidReadyResult({ ...brief(), chiefBriefQuality: { status: 'failed' } }, day), false);
  assert.equal(isValidReadyResult({ ...brief(), chiefBriefPending: true }, day), false);
  assert.equal(isValidReadyResult({ ...brief(), publishTier: 'hard_failed' }, day), false);
});

test('a grounded usable brief is deliverable even without premium quality', () => {
  const content = { ...brief(), chiefBriefQuality: { status: 'degraded' as const }, publishTier: 'grounded_usable' as const };
  assert.equal(isValidReadyResult(content, day, 'published'), true);
  assert.equal(needsBriefingDelivery(content, day), false);
});

test('a recent HTTP success cannot throttle foreground recovery when no current usable brief arrived', () => {
  assert.equal(needsBriefingDelivery(null, day), true);
  assert.equal(needsBriefingDelivery({ ...brief(), chiefBrief: null }, day), true);
  assert.equal(needsBriefingDelivery({ ...brief(), localDate: '2026-09-08' }, day), true);
  assert.equal(needsBriefingDelivery({ ...brief(), chiefBriefPending: true }, day), true);
  assert.equal(needsBriefingDelivery({ ...brief(), chiefBriefStale: true }, day), true);
  assert.equal(needsBriefingDelivery({ ...brief(), chiefBriefQuality: { status: 'failed' } }, day), true);
  assert.equal(needsBriefingDelivery(brief(), day), false);
});
