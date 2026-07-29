// Rebuild resumability hardening pass — required regression tests for the
// pure decision logic (see useBriefing.ts for how these wire into
// AsyncStorage + fetch).
//   node --experimental-strip-types --test src/lib/rebuildResume.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveResumeDecision, isValidReadyResult, classifyTriggerResponse, MAX_RESUME_AGE_MS,
  type RebuildIdentity,
} from './rebuildResume.ts';

// ── resolveResumeDecision ──

test('required 5: a persisted identity with a real buildId resumes polling that EXACT build', () => {
  const identity: RebuildIdentity = { buildId: 'build_123', localDay: '2026-07-29', startedAt: Date.now() - 10000 };
  const decision = resolveResumeDecision(identity, '2026-07-29');
  assert.deepEqual(decision, { kind: 'poll', buildId: 'build_123' });
});

test('required 6: a persisted identity with buildId:null (lock_contended marker) resumes by retrying the trigger, never by polling nothing', () => {
  const identity: RebuildIdentity = { buildId: null, localDay: '2026-07-29', startedAt: Date.now() - 5000 };
  const decision = resolveResumeDecision(identity, '2026-07-29');
  assert.deepEqual(decision, { kind: 'retry_trigger' });
});

test('no persisted identity at all -> discard (nothing to resume)', () => {
  assert.deepEqual(resolveResumeDecision(null, '2026-07-29'), { kind: 'discard' });
  assert.deepEqual(resolveResumeDecision(undefined, '2026-07-29'), { kind: 'discard' });
});

test('a persisted identity from a PRIOR local day (app closed overnight) is discarded, never resumed', () => {
  const identity: RebuildIdentity = { buildId: 'build_yesterday', localDay: '2026-07-28', startedAt: Date.now() - 1000 };
  const decision = resolveResumeDecision(identity, '2026-07-29');
  assert.deepEqual(decision, { kind: 'discard' });
});

test('an absurdly old persisted identity (past MAX_RESUME_AGE_MS) is discarded even if same-day', () => {
  const now = Date.now();
  const identity: RebuildIdentity = { buildId: 'build_stale', localDay: '2026-07-29', startedAt: now - MAX_RESUME_AGE_MS - 1000 };
  const decision = resolveResumeDecision(identity, '2026-07-29', now);
  assert.deepEqual(decision, { kind: 'discard' });
});

test('an identity just under the max age is still resumed', () => {
  const now = Date.now();
  const identity: RebuildIdentity = { buildId: 'build_ok', localDay: '2026-07-29', startedAt: now - (MAX_RESUME_AGE_MS - 1000) };
  const decision = resolveResumeDecision(identity, '2026-07-29', now);
  assert.deepEqual(decision, { kind: 'poll', buildId: 'build_ok' });
});

// ── isValidReadyResult ──

test('required 7: a ready job\'s exact fetched content is accepted only when it matches the expected local day and carries a usable chiefBrief', () => {
  assert.equal(isValidReadyResult({ localDate: '2026-07-29', chiefBrief: { synthesis: 's' } }, '2026-07-29'), true);
});

test('required 8: a mismatched local day cannot appear successful, even with a usable chiefBrief', () => {
  assert.equal(isValidReadyResult({ localDate: '2026-07-28', chiefBrief: { synthesis: 's' } }, '2026-07-29'), false);
});

test('required 8: a missing/null chiefBrief cannot appear successful, even on the right day', () => {
  assert.equal(isValidReadyResult({ localDate: '2026-07-29', chiefBrief: null }, '2026-07-29'), false);
  assert.equal(isValidReadyResult({ localDate: '2026-07-29' }, '2026-07-29'), false);
});

test('null/undefined content is never valid', () => {
  assert.equal(isValidReadyResult(null, '2026-07-29'), false);
  assert.equal(isValidReadyResult(undefined, '2026-07-29'), false);
});

test('content with no localDate at all (older shape) is accepted as long as chiefBrief is usable — day-check only applies when the field is present', () => {
  assert.equal(isValidReadyResult({ chiefBrief: { synthesis: 's' } }, '2026-07-29'), true);
});

// ── classifyTriggerResponse ──

test('required 6: a real buildId always means poll it, regardless of alreadyRunning/retryable flags', () => {
  assert.deepEqual(classifyTriggerResponse({ buildId: 'build_1' }), { kind: 'poll', buildId: 'build_1' });
  assert.deepEqual(classifyTriggerResponse({ buildId: 'build_2', retryable: true }), { kind: 'poll', buildId: 'build_2' });
});

test('required 6: lock_contended (buildId:null, retryable:true) means retry the trigger, never poll a null id', () => {
  assert.deepEqual(classifyTriggerResponse({ buildId: null, retryable: true }), { kind: 'retry' });
});

test('no buildId and not retryable is an honest give-up, never fabricated as pollable', () => {
  assert.deepEqual(classifyTriggerResponse({ buildId: null, retryable: false }), { kind: 'give_up' });
  assert.deepEqual(classifyTriggerResponse({}), { kind: 'give_up' });
});
