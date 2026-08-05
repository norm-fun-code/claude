// On My Radar audit item 8 — Chief Brief loading state machine.
//   node --experimental-strip-types --test src/lib/chiefBriefState.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChiefBriefState, hasBeenPendingTooLong, describeChiefBriefFailure, resolvePendingSince } from './chiefBriefState.ts';

test('a fresh brief with nothing in flight is "ready"', () => {
  assert.equal(resolveChiefBriefState({ brief: { synthesis: 's' }, pending: false, refreshing: false, error: false }), 'ready');
});

test('no brief ever loaded but the server says a build is genuinely pending is "initial_loading"', () => {
  assert.equal(resolveChiefBriefState({ brief: null, pending: true, refreshing: false, error: false }), 'initial_loading');
});

// Morning-notification lifecycle fix: "no brief, no error, no pending, no
// active job" used to fall through to 'initial_loading' by default — an
// indefinite skeleton with zero server-reported evidence anything was
// happening. This is the exact mobile-side half of the production bug
// ("Built 23h ago" above a skeleton with no active job behind it). A
// skeleton must only render when there's positive evidence of activity.
test('required: no brief, no error, nothing pending, and no active job is "failed_empty" — never an indefinite skeleton with no activity behind it', () => {
  assert.equal(resolveChiefBriefState({ brief: null, pending: false, refreshing: false, error: false }), 'failed_empty');
  assert.equal(resolveChiefBriefState({ brief: null, pending: false, refreshing: false, error: false, buildState: null }), 'failed_empty');
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

// ---------------------------------------------------------------------------
// Morning-lifecycle follow-up: a COMPLETED build whose Chief Brief was
// unusable must never render as "loading". The production report was a
// skeleton pulsing at 12:04pm for a build cut at 9am — HTTP 200, no client
// error, chiefBrief null — which the original state machine could only map to
// 'initial_loading' because 'failed_empty' required a fetch error.
// ---------------------------------------------------------------------------

test('required: the exact production bug — no brief, no client error, server says the build FAILED is "failed_empty", not a forever skeleton', () => {
  assert.equal(
    resolveChiefBriefState({ brief: null, pending: true, refreshing: false, error: false, quality: 'failed' }),
    'failed_empty'
  );
});

test('required: a degraded (finished-but-too-thin) build is also a completed failure, not "loading"', () => {
  assert.equal(
    resolveChiefBriefState({ brief: null, pending: true, refreshing: false, error: false, quality: 'degraded' }),
    'failed_empty'
  );
});

test('a durable build job in a terminal failed state is "failed_empty" even with no quality verdict', () => {
  assert.equal(
    resolveChiefBriefState({ brief: null, pending: true, refreshing: false, error: false, buildState: 'failed' }),
    'failed_empty'
  );
});

test('a build genuinely in flight server-side still earns the skeleton — for every in-flight job state', () => {
  for (const buildState of ['waiting_for_sleep', 'queued', 'building', 'retry_wait'] as const) {
    assert.equal(
      resolveChiefBriefState({ brief: null, pending: true, refreshing: false, error: false, buildState }),
      'initial_loading',
      `${buildState} must render as loading`
    );
  }
});

test('an in-flight build outranks a stale failed verdict — tapping Retry shows progress immediately', () => {
  assert.equal(
    resolveChiefBriefState({ brief: null, pending: true, refreshing: true, error: false, quality: 'failed' }),
    'initial_loading'
  );
  assert.equal(
    resolveChiefBriefState({ brief: null, pending: true, refreshing: false, error: false, quality: 'failed', buildState: 'building' }),
    'initial_loading'
  );
});

test('with no verdict available at all, the time bound still stops the skeleton running forever', () => {
  // Pre-quality-contract cached build, or a status endpoint we could not reach.
  assert.equal(
    resolveChiefBriefState({ brief: null, pending: true, refreshing: false, error: false, pendingTooLong: false }),
    'initial_loading'
  );
  assert.equal(
    resolveChiefBriefState({ brief: null, pending: true, refreshing: false, error: false, pendingTooLong: true }),
    'failed_empty'
  );
});

test('a fresh quality verdict never forces a failure state (only degraded/failed do)', () => {
  assert.equal(
    resolveChiefBriefState({ brief: null, pending: true, refreshing: false, error: false, quality: 'fresh' }),
    'initial_loading'
  );
});

test('a carried-forward good brief is never blanked by a degraded verdict for THIS build', () => {
  // `quality` always describes this build's own attempt, never the carried
  // card — content on screen must survive it.
  assert.equal(
    resolveChiefBriefState({ brief: { synthesis: 's' }, pending: true, refreshing: false, error: false, quality: 'degraded' }),
    'refreshing_with_last_good'
  );
});

test('describeChiefBriefFailure returns distinct, non-empty, code-free copy per cause', () => {
  const persistence = describeChiefBriefFailure({ persistenceFailed: true });
  const failed = describeChiefBriefFailure({ quality: 'failed' });
  const degraded = describeChiefBriefFailure({ quality: 'degraded' });
  const provider = describeChiefBriefFailure({ reasonCodes: ['provider_failed'] });
  const unknown = describeChiefBriefFailure({});
  const all = [persistence, failed, degraded, provider, unknown];
  assert.equal(new Set(all).size, 5, 'each cause gets its own sentence');
  for (const s of all) {
    assert.ok(s.length > 0);
    // Never leak raw diagnostic codes into user-facing copy.
    assert.doesNotMatch(s, /_|reasonCode|underfilled|provider_failed/);
  }
});

test('describeChiefBriefFailure is total — never throws on missing/odd input', () => {
  assert.ok(describeChiefBriefFailure().length > 0);
  assert.ok(describeChiefBriefFailure({ reasonCodes: null }).length > 0);
  assert.ok(describeChiefBriefFailure({ reasonCodes: [] }).length > 0);
  // A malformed array (non-strings) must not blow up the card.
  assert.ok(describeChiefBriefFailure({ reasonCodes: [null as unknown as string, 1 as unknown as string] }).length > 0);
});

test('underfilled reason codes read as degraded even without an explicit quality status', () => {
  assert.equal(
    describeChiefBriefFailure({ reasonCodes: ['synthesis_underfilled'] }),
    describeChiefBriefFailure({ quality: 'degraded' })
  );
});

// ---------------------------------------------------------------------------
// Bug report: "it builds the brief, I close the app, reopen the app, and
// nothing is there." Root cause: hasBeenPendingTooLong's 45s bound was fed by
// a component-local "first render with no brief" timestamp that reset on
// every BriefCard remount — which happens on every app close/reopen (and
// every tab switch), so the skeleton fail-safe could never actually fire
// across the one action a waiting user is most likely to take.
// resolvePendingSince is the durable (AsyncStorage-backed, via useBriefing.ts)
// replacement anchor these tests cover.
// ---------------------------------------------------------------------------

test('required: a brief present clears the anchor (nothing to time-bound)', () => {
  assert.equal(resolvePendingSince({ day: '2026-07-29', ts: 1_000 }, true, '2026-07-29', 50_000), null);
  assert.equal(resolvePendingSince(null, true, '2026-07-29', 50_000), null);
});

test('required: no brief and nothing stored yet anchors fresh at "now"', () => {
  assert.equal(resolvePendingSince(null, false, '2026-07-29', 12_345), 12_345);
});

test('required: no brief and a same-day stored anchor is REUSED, not reset — this is the exact fix for the relaunch bug', () => {
  const stored = { day: '2026-07-29', ts: 1_000 };
  // Simulates the app being closed and reopened 5 minutes later, same day,
  // still no brief: the anchor must be the ORIGINAL ts, not "now".
  assert.equal(resolvePendingSince(stored, false, '2026-07-29', 1_000 + 5 * 60_000), 1_000);
});

test('required: a stored anchor from a DIFFERENT calendar day is discarded and re-anchored fresh', () => {
  const stored = { day: '2026-07-28', ts: 1_000 };
  assert.equal(resolvePendingSince(stored, false, '2026-07-29', 99_999), 99_999);
});

test('end-to-end: repeated relaunches while a build genuinely stays pending eventually cross the 45s threshold instead of resetting every time', () => {
  const day = '2026-07-29';
  let stored: { day: string; ts: number } | null = null;
  // Relaunch 1: nothing stored yet — anchors at t=0.
  // Non-null: resolvePendingSince(_, hasBrief: false, ...) always returns a
  // number, never null (only the `hasBrief === true` branch returns null).
  let ts = resolvePendingSince(stored, false, day, 0)!;
  stored = { day, ts };
  assert.equal(hasBeenPendingTooLong(ts, 0), false);
  // Relaunch 2, 20s later: still no brief — must reuse t=0, not reset to 20s.
  ts = resolvePendingSince(stored, false, day, 20_000)!;
  stored = { day, ts };
  assert.equal(ts, 0);
  assert.equal(hasBeenPendingTooLong(ts, 20_000), false);
  // Relaunch 3, 50s after the ORIGINAL anchor: now past the 45s threshold —
  // the old mount-local bug would have reset the clock on every relaunch and
  // never reached this.
  ts = resolvePendingSince(stored, false, day, 50_000)!;
  assert.equal(ts, 0);
  assert.equal(hasBeenPendingTooLong(ts, 50_000), true);
});

// Production incident (Aug 5 2026): a brief was built, published and pushed
// at 7:35am; the server had a publishable row available continuously all day
// (verified via /api/diag/daily-briefing-rows — all 10 of that day's stored
// rows were publishable). Opening the app at 2:55pm still showed the hard
// "Couldn't put together today's brief." failure. Cause: `pendingSince` is
// deliberately DURABLE across relaunches and re-anchors only on a new
// calendar day, so once any briefless moment occurred early that morning,
// `pendingTooLong` stayed true for the rest of the day. On the later cold
// launch the cached payload hydrated first (chiefBrief null, pending true —
// briefingMerge.ts's migrateV1Cache), and the card resolved straight to
// failed_empty BEFORE the in-flight first fetch had returned anything.
test('required: no brief + hours-old pendingTooLong, but the first fetch of this session has NOT come back yet -> loading, never a claimed failure', () => {
  const state = resolveChiefBriefState({
    brief: null, pending: true, refreshing: false, error: false,
    quality: null, buildState: null,
    pendingTooLong: true, // anchored hours earlier the same day
    awaitingFirstFetch: true,
  });
  assert.equal(state, 'initial_loading');
});

test('required: awaitingFirstFetch does NOT mask a real fetch error from this session', () => {
  const state = resolveChiefBriefState({
    brief: null, pending: true, refreshing: false, error: true,
    quality: null, buildState: null, pendingTooLong: true, awaitingFirstFetch: true,
  });
  assert.equal(state, 'failed_empty', 'a genuine error observed this session must still surface');
});

test('required: once the first fetch HAS come back and there is still nothing, the honest failed state returns', () => {
  const state = resolveChiefBriefState({
    brief: null, pending: true, refreshing: false, error: false,
    quality: null, buildState: null, pendingTooLong: true, awaitingFirstFetch: false,
  });
  assert.equal(state, 'failed_empty', 'pendingTooLong must still escalate once we have actually heard from the server');
});

test('required: awaitingFirstFetch never overrides content we already have', () => {
  const state = resolveChiefBriefState({
    brief: { synthesis: 'x' }, pending: false, refreshing: false, error: false,
    quality: null, buildState: null, pendingTooLong: true, awaitingFirstFetch: true,
  });
  assert.equal(state, 'ready', 'a hydrated last-good brief still renders immediately');
});
