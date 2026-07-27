// Chief Brief regression fix — mobile pure merge function. The 10 required
// regression scenarios (backend requirements mirror in
// backend/test/integration/chief-brief-persistence-lifecycle.test.js).
//   node --experimental-strip-types --test src/lib/briefingMerge.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBriefingResponse, migrateV1Cache, isUsableChiefBrief } from './briefingMerge.ts';
import type { BriefingData } from '../hooks/useBriefing.ts';

const GOOD_BRIEF = { synthesis: 's', action: 'a', risk: 'r', move: 'm', openQuestion: '' };

function base(overrides: Partial<BriefingData> = {}): BriefingData {
  return {
    date: 'Monday',
    localDate: '2026-07-27',
    chiefBrief: GOOD_BRIEF,
    chiefBriefStale: false,
    chiefBriefPending: false,
    weather: null,
    workout: { day: 'Mon', type: 'Pull', duration: null, hrTarget: null, protein: '', hrvNote: '' },
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

// ── 1. Cached good brief + incoming null/degraded response retains the good brief ──
test('1 — cached good brief + incoming null/degraded response retains the good brief', () => {
  const existing = base({ chiefBrief: GOOD_BRIEF, chiefBriefStale: false });
  const incoming = base({ chiefBrief: null, chiefBriefPending: true, chiefBriefQuality: { status: 'degraded' } });
  const merged = mergeBriefingResponse(existing, incoming);
  assert.deepEqual(merged.chiefBrief, GOOD_BRIEF);
  assert.equal(merged.chiefBriefPending, false);
  assert.equal(merged.chiefBriefStale, true);
});

// ── 2. Kill/reopen after a failed refresh still displays the same good brief ──
test('2 — kill/reopen after a failed refresh still displays the same good brief (cold-launch cache read, then merge against a failed refetch)', () => {
  // Cold launch hydrates `existing` straight from AsyncStorage (already the
  // last merged-safe state); the background refresh comes back degraded.
  const existing = base({ chiefBrief: GOOD_BRIEF });
  const failedRefetch = base({ chiefBrief: null, chiefBriefPending: true, chiefBriefQuality: { status: 'failed' } });
  const merged = mergeBriefingResponse(existing, failedRefetch);
  assert.deepEqual(merged.chiefBrief, GOOD_BRIEF);
});

// ── 3. Foreground refresh cannot overwrite last-good with null ──
test('3 — foreground refresh cannot overwrite last-good with null', () => {
  const existing = base({ chiefBrief: GOOD_BRIEF });
  const foregroundRefresh = base({ chiefBrief: null, chiefBriefPending: false, chiefBriefQuality: { status: 'failed' } });
  const merged = mergeBriefingResponse(existing, foregroundRefresh);
  assert.deepEqual(merged.chiefBrief, GOOD_BRIEF);
  assert.equal(merged.chiefBriefStale, true);
});

// ── 4. Failed scoped retry retains last-good ──
test('4 — a failed scoped Chief Brief retry retains last-good', () => {
  const existing = base({ chiefBrief: GOOD_BRIEF });
  const failedScopedRetry = base({
    chiefBrief: null, chiefBriefPending: true,
    chiefBriefAttempt: { state: 'degraded', attemptedAt: '2026-07-27T12:00:00Z', reasonCodes: ['synthesis_underfilled'], persistenceFailed: false },
  });
  const merged = mergeBriefingResponse(existing, failedScopedRetry);
  assert.deepEqual(merged.chiefBrief, GOOD_BRIEF);
  // Attempt state reflects the incoming (latest) attempt, not stale success.
  assert.equal(merged.chiefBriefAttempt?.state, 'degraded');
});

// ── 5. Good incoming brief replaces last-good ──
test('5 — a good incoming brief replaces last-good', () => {
  const existing = base({ chiefBrief: GOOD_BRIEF });
  const NEW_BRIEF = { synthesis: 'fresh new synthesis', action: 'a2', risk: 'r2', move: 'm2', openQuestion: '' };
  const incoming = base({ chiefBrief: NEW_BRIEF, chiefBriefStale: false });
  const merged = mergeBriefingResponse(existing, incoming);
  assert.deepEqual(merged.chiefBrief, NEW_BRIEF);
  assert.equal(merged.chiefBriefStale, false);
});

// ── 6. Previous-day cached brief is not shown as current ──
test('6 — a previous-day cached brief is not carried forward as current when the incoming response has no brief', () => {
  const existing = base({ chiefBrief: GOOD_BRIEF, localDate: '2026-07-26' }); // yesterday
  const incoming = base({ chiefBrief: null, chiefBriefPending: true, localDate: '2026-07-27' }); // today, but empty
  const merged = mergeBriefingResponse(existing, incoming);
  assert.equal(merged.chiefBrief, null, 'yesterday\'s brief must never be shown as today\'s just because it was the last thing cached');
  assert.equal(merged.chiefBriefPending, true);
});

// ── 7. Late failed status probe cannot override a newer successful request ──
test('7 — a late failed status probe cannot override a newer successful request (useBriefing race-safety, exercised at the merge level)', () => {
  // The merge function itself is what a late probe's caller (if it were ever
  // routed through merge) would be bound by: a failed/empty "response" can
  // never beat an existing good brief. useBriefing.ts additionally never
  // routes probeBuildState's result through setData at all (it only ever
  // touches buildState/buildFailure), and guards it with the SAME
  // reqIdRef-based staleness check fetchBriefing uses — this test documents
  // the merge-level half of that guarantee.
  const existing = base({ chiefBrief: GOOD_BRIEF });
  const lateFailedProbeShapedResponse = base({ chiefBrief: null, chiefBriefPending: true });
  const merged = mergeBriefingResponse(existing, lateFailedProbeShapedResponse);
  assert.deepEqual(merged.chiefBrief, GOOD_BRIEF);
});

// ── 8. Corrupt/poisoned v1 cache migrates safely ──
test('8 — a poisoned v1 cache (chiefBrief: null) migrates to v2 with the Chief Brief dropped, other fields intact', () => {
  const poisoned = base({ chiefBrief: null, chiefBriefPending: true, weather: { temp: 70 } as unknown as BriefingData['weather'] });
  const migrated = migrateV1Cache(poisoned, '2026-07-27');
  assert.equal(migrated?.chiefBrief, null);
  assert.equal(migrated?.chiefBriefPending, true);
  assert.deepEqual(migrated?.weather, { temp: 70 });
});

test('8b — a structurally valid SAME-DAY v1 cache survives migration untouched', () => {
  const good = base({ chiefBrief: GOOD_BRIEF, localDate: '2026-07-27' });
  const migrated = migrateV1Cache(good, '2026-07-27');
  assert.deepEqual(migrated?.chiefBrief, GOOD_BRIEF);
});

test('8c — a v1 cache from a PREVIOUS day is dropped during migration, not shown as today\'s', () => {
  const yesterdayGood = base({ chiefBrief: GOOD_BRIEF, localDate: '2026-07-26' });
  const migrated = migrateV1Cache(yesterdayGood, '2026-07-27');
  assert.equal(migrated?.chiefBrief, null);
});

test('8d — a null v1 cache (never existed) migrates to null, not a crash', () => {
  assert.equal(migrateV1Cache(null, '2026-07-27'), null);
});

// ── 9. Failure card appears only when no usable same-day brief exists ──
test('9 — the merge result has no brief (failure-card territory) ONLY when neither side had one', () => {
  const noExisting = null;
  const emptyIncoming = base({ chiefBrief: null, chiefBriefPending: true });
  const merged = mergeBriefingResponse(noExisting, emptyIncoming);
  assert.equal(merged.chiefBrief, null);

  // But if EITHER side has a usable brief, it must survive.
  const withExisting = base({ chiefBrief: GOOD_BRIEF });
  const merged2 = mergeBriefingResponse(withExisting, emptyIncoming);
  assert.deepEqual(merged2.chiefBrief, GOOD_BRIEF);
});

// ── 10. Existing Radar/Today payload fields still refresh even when Chief Brief content is retained ──
test('10 — Today/Radar/weather fields still refresh from the incoming response even when Chief Brief content is retained', () => {
  const existing = base({
    chiefBrief: GOOD_BRIEF,
    weather: { temp: 60 } as unknown as BriefingData['weather'],
    todayCommandCenter: { snapshotId: 'old' } as unknown as BriefingData['todayCommandCenter'],
  });
  const incoming = base({
    chiefBrief: null, chiefBriefPending: true,
    weather: { temp: 75 } as unknown as BriefingData['weather'],
    todayCommandCenter: { snapshotId: 'new' } as unknown as BriefingData['todayCommandCenter'],
  });
  const merged = mergeBriefingResponse(existing, incoming);
  assert.deepEqual(merged.chiefBrief, GOOD_BRIEF, 'Chief Brief content is retained');
  assert.deepEqual(merged.weather, { temp: 75 }, 'weather still refreshes from incoming');
  assert.deepEqual(merged.todayCommandCenter, { snapshotId: 'new' }, 'todayCommandCenter still refreshes from incoming');
});

// ── isUsableChiefBrief pure predicate ──
test('isUsableChiefBrief requires at least one real prose field, rejects null/empty', () => {
  assert.equal(isUsableChiefBrief(null), false);
  assert.equal(isUsableChiefBrief(undefined), false);
  assert.equal(isUsableChiefBrief({} as never), false);
  assert.equal(isUsableChiefBrief({ synthesis: '' } as never), false);
  assert.equal(isUsableChiefBrief(GOOD_BRIEF), true);
});

// ── Production-like end-to-end regression sequence (mobile half) ──
test('e2e — cold-launch hydration from a merged-safe cache, then a degraded background refresh, keeps the morning brief on screen', () => {
  const morningBrief = { synthesis: 'the morning plan', action: 'a', risk: 'r', move: 'm', openQuestion: '' };
  // Step 1: this morning's successful fetch merged (trivially, nothing to
  // protect yet) and got cached.
  const afterMorningFetch = mergeBriefingResponse(null, base({ chiefBrief: morningBrief }));
  assert.deepEqual(afterMorningFetch.chiefBrief, morningBrief);

  // Step 2: "kill and reopen the app" — cold launch hydrates from the cached
  // (already merged-safe) v2 state directly; no merge needed for that read.
  const coldLaunchState = afterMorningFetch;

  // Step 3: a background refresh comes back degraded.
  const degradedRefresh = base({ chiefBrief: null, chiefBriefPending: true, chiefBriefQuality: { status: 'degraded' } });
  const afterDegradedRefresh = mergeBriefingResponse(coldLaunchState, degradedRefresh);

  assert.deepEqual(afterDegradedRefresh.chiefBrief, morningBrief, 'the identical morning Chief Brief remains visible');
  assert.equal(afterDegradedRefresh.chiefBriefStale, true, 'failed-attempt status is shown non-destructively');
  assert.equal(afterDegradedRefresh.chiefBriefPending, false);
});
