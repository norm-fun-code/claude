// Server-authoritative barge-in acceptance tests (product-audit hardening
// pass, item 2). Before this, turn staleness was checked ONLY client-side,
// AFTER a mutating tool call's HTTP response had already arrived — the
// mutation had already committed server-side by then. These tests exercise
// the real production path — realtimeTools.runTool('execute_normos_action')
// — against chat/realtimeTurnAuthority.js's server-side "which turn is
// current" tracker, stubbing only executeAction/beliefsStore (no DB/network).
const test = require('node:test');
const assert = require('node:assert/strict');

const realtimeTools = require('../src/chat/realtimeTools');
const executeActionModule = require('../src/chat/executeAction');
const idempotency = require('../src/chat/voiceIdempotency');
const turnAuthority = require('../src/chat/realtimeTurnAuthority');

const ORIG_EXECUTE = executeActionModule.executeAction;
function stubExecuteAction(fn) { executeActionModule.executeAction = fn; }

test.beforeEach(() => { idempotency._reset(); turnAuthority._reset(); });
test.afterEach(() => { executeActionModule.executeAction = ORIG_EXECUTE; });

test('required (a): two simultaneous identical mutating tool calls write exactly once', async () => {
  let calls = 0;
  stubExecuteAction(async () => {
    calls += 1;
    await new Promise((r) => setImmediate(r));
    return { done: true, description: 'logged', callNumber: calls };
  });

  const args = { type: 'log_habit', habit: 'exercise' };
  const ctx = { sessionId: 's1', turnId: 't1', now: new Date() };
  const [a, b] = await Promise.all([
    realtimeTools.runTool('execute_normos_action', args, ctx),
    realtimeTools.runTool('execute_normos_action', args, ctx),
  ]);
  assert.equal(calls, 1, 'executeAction must run exactly once for two simultaneous identical calls');
  assert.deepEqual(a, b);
});

test('required (b): a turn superseded before the call arrives never writes — rejected with cancelled:true', async () => {
  let calls = 0;
  stubExecuteAction(async () => { calls += 1; return { done: true, description: 'logged' }; });

  // The client barges in / accepts a new turn (turnId 2) and tells the
  // backend BEFORE the stale turn-1 tool call is issued — the real-world
  // "cancellation arrived in time" case.
  turnAuthority.advanceTurn('s1', '2');

  const result = await realtimeTools.runTool(
    'execute_normos_action',
    { type: 'log_habit', habit: 'exercise' },
    { sessionId: 's1', turnId: '1', now: new Date() }
  );

  assert.equal(calls, 0, 'a superseded turn must never reach executeAction');
  assert.equal(result.cancelled, true);
  assert.equal(result.done, false);
});

test('required (c): a write already committed before a late-arriving cancellation is reported honestly, not as cancelled', async () => {
  let calls = 0;
  let advancedDuringWrite = false;
  stubExecuteAction(async () => {
    calls += 1;
    // Simulate the barge-in landing WHILE the mutation is already
    // in-flight/committing — authorization was already checked and passed
    // before executeAction started, so this must NOT retroactively cancel it.
    turnAuthority.advanceTurn('s1', '2');
    advancedDuringWrite = true;
    return { done: true, description: 'logged for real' };
  });

  const result = await realtimeTools.runTool(
    'execute_normos_action',
    { type: 'log_habit', habit: 'exercise' },
    { sessionId: 's1', turnId: '1', now: new Date() }
  );

  assert.equal(calls, 1, 'the write must actually execute — authorization was valid when it started');
  assert.ok(advancedDuringWrite, 'sanity: the race actually happened during the write');
  assert.equal(result.cancelled, undefined, 'a committed write must never be reported as cancelled');
  assert.equal(result.done, true);
  assert.equal(result.description, 'logged for real');
});

test('required (d): a failed write remains retryable — the idempotency entry is not poisoned by the failure', async () => {
  let calls = 0;
  stubExecuteAction(async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient DB error');
    return { done: true, description: 'logged on retry' };
  });

  const args = { type: 'log_habit', habit: 'exercise' };
  const ctx = { sessionId: 's1', turnId: 't1', now: new Date() };

  await assert.rejects(() => realtimeTools.runTool('execute_normos_action', args, ctx));
  assert.equal(calls, 1);

  const retry = await realtimeTools.runTool('execute_normos_action', args, ctx);
  assert.equal(calls, 2, 'a retry after a genuine failure must actually run, not be blocked or silently cached');
  assert.equal(retry.done, true);
  assert.equal(retry.description, 'logged on retry');
});

test('a turn that was never advanced (no barge-in occurred) is always authorized — the common case adds no false rejections', async () => {
  let calls = 0;
  stubExecuteAction(async () => { calls += 1; return { done: true, description: 'logged' }; });

  const result = await realtimeTools.runTool(
    'execute_normos_action',
    { type: 'log_habit', habit: 'exercise' },
    { sessionId: 's1', turnId: '1', now: new Date() }
  );
  assert.equal(calls, 1);
  assert.equal(result.cancelled, undefined);
  assert.equal(result.done, true);
});

test('a confirmation-required action still gates on confirmed:true even when the turn is fully authorized — the two checks are independent', async () => {
  let calls = 0;
  stubExecuteAction(async () => { calls += 1; return { done: true, description: 'swapped' }; });

  const result = await realtimeTools.runTool(
    'execute_normos_action',
    { type: 'swap_workout', workoutId: 'zone2' },
    { sessionId: 's1', turnId: '1', now: new Date() }
  );
  assert.equal(calls, 0);
  assert.equal(result.needsConfirmation, true);
});
