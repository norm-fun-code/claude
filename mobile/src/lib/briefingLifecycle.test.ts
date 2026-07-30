import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFetchedBriefingResponse,
  createBriefingDataCoordinator,
  createImmediateRequestGate,
} from './briefingLifecycle.ts';
import type { BriefingData } from '../hooks/useBriefing.ts';

const GOOD_BRIEF = {
  synthesis: 'Protect the morning plan.',
  action: 'Start with the commitment.',
  risk: 'None.',
  move: 'Begin.',
  openQuestion: '',
};

function base(overrides: Partial<BriefingData> = {}): BriefingData {
  return {
    date: 'Thursday',
    localDate: '2026-07-30',
    currentLocalDate: '2026-07-30',
    dayState: 'current',
    chiefBrief: GOOD_BRIEF,
    chiefBriefStale: false,
    chiefBriefPending: false,
    weather: null,
    workout: { day: 'Thu', type: 'Recovery', duration: null, hrTarget: null, protein: '' },
    calendar: [],
    financeSummary: [],
    quoteInsight: '',
    notionInsight: '',
    quote: '',
    notionText: '',
    notionPageTitle: '',
    leverageActions: [],
    insights: [],
    forecasts: [],
    relevantHighlight: null,
    weeklyReview: null,
    wealth: null,
    ...overrides,
  } as BriefingData;
}

test('failed refresh sends the exact same last-good-safe object to state and durable cache', async () => {
  const states: BriefingData[] = [];
  const writes: BriefingData[] = [];
  const coordinator = createBriefingDataCoordinator({
    onState: (next) => states.push(next),
    persist: async (next) => { writes.push(next); },
  });

  coordinator.hydrate(base());
  const committed = coordinator.commitIncoming(base({
    chiefBrief: null,
    chiefBriefPending: true,
    chiefBriefQuality: { status: 'failed' },
  }));
  await coordinator.flush();

  assert.strictEqual(states.at(-1), committed);
  assert.strictEqual(writes.at(-1), committed);
  assert.deepEqual(committed.chiefBrief, GOOD_BRIEF);
  assert.equal(committed.chiefBriefStale, true);

  // Equivalent to killing and reopening after AsyncStorage serialized the
  // committed value: a brand-new lifecycle owner hydrates the same card.
  const reopenedStates: BriefingData[] = [];
  const reopenedCoordinator = createBriefingDataCoordinator({
    onState: (next) => reopenedStates.push(next),
    persist: async () => undefined,
  });
  const reopened = JSON.parse(JSON.stringify(writes.at(-1))) as BriefingData;
  assert.equal(reopenedCoordinator.hydrate(reopened), true);
  assert.deepEqual(reopenedStates.at(-1)?.chiefBrief, GOOD_BRIEF);
});

test('cache writes are serialized so a slower old write cannot overwrite the newest briefing', async () => {
  const order: string[] = [];
  let releaseFirst: (() => void) | null = null;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let call = 0;
  const coordinator = createBriefingDataCoordinator({
    onState: () => undefined,
    persist: async (next) => {
      call += 1;
      order.push(`start:${next.snapshotId}`);
      if (call === 1) await firstBlocked;
      order.push(`finish:${next.snapshotId}`);
    },
  });

  coordinator.commitIncoming(base({ snapshotId: 'old' }));
  coordinator.commitIncoming(base({ snapshotId: 'new' }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['start:old']);

  releaseFirst!();
  await coordinator.flush();
  assert.deepEqual(order, ['start:old', 'finish:old', 'start:new', 'finish:new']);
  assert.equal(coordinator.current()?.snapshotId, 'new');
});

test('late cold-launch hydration cannot replace a verified live result', () => {
  const states: BriefingData[] = [];
  const coordinator = createBriefingDataCoordinator({
    onState: (next) => states.push(next),
    persist: async () => undefined,
  });
  const fresh = base({ snapshotId: 'fresh' });
  coordinator.replaceVerified(fresh);

  const hydrated = coordinator.hydrate(base({ snapshotId: 'stale-cache' }));
  assert.equal(hydrated, false);
  assert.strictEqual(coordinator.current(), fresh);
  assert.equal(states.at(-1)?.snapshotId, 'fresh');
});

test('immediate request gate rejects two triggers before React can rerender', () => {
  const gate = createImmediateRequestGate();
  assert.equal(gate.tryEnter(), true);
  assert.equal(gate.tryEnter(), false);
  assert.equal(gate.isActive(), true);
  gate.leave();
  assert.equal(gate.tryEnter(), true);
});

test('full failed-fetch lifecycle preserves cache and automatically follows the self-heal job', async () => {
  const stored: BriefingData[] = [];
  const events: string[] = [];
  const coordinator = createBriefingDataCoordinator({
    onState: () => undefined,
    persist: async (next) => { stored.push(JSON.parse(JSON.stringify(next))); },
  });
  coordinator.hydrate(base({ snapshotId: 'last-good' }));

  const result = await applyFetchedBriefingResponse(
    base({
      snapshotId: 'failed-attempt',
      chiefBrief: null,
      chiefBriefPending: true,
      chiefBriefQuality: { status: 'failed' },
      recoveryBuildId: 'recovery_123',
      currentLocalDate: '2026-07-30',
    }),
    coordinator,
    async (identity) => {
      events.push(`persist:${identity.buildId}:${identity.localDay}`);
    },
    (buildId, localDay) => {
      events.push(`poll:${buildId}:${localDay}`);
    }
  );

  assert.equal(result.adoptedRecoveryBuild, true);
  assert.deepEqual(result.merged.chiefBrief, GOOD_BRIEF);
  assert.deepEqual(stored.at(-1)?.chiefBrief, GOOD_BRIEF);
  assert.deepEqual(events, [
    'persist:recovery_123:2026-07-30',
    'poll:recovery_123:2026-07-30',
  ]);
});
