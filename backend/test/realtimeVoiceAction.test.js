// Confirmation-policy parity fix for chat/realtimeTools.js's
// execute_normos_action direct-tool path (previously the ONLY voice path
// that bypassed chat/actionPolicy.js's needsConfirmation() entirely — a
// swap_workout/add_chapter executed immediately on a spoken restatement,
// unlike deepAsk() and routes/voice.js which both already gated on it). All
// deps stubbed — no DB/network.
const test = require('node:test');
const assert = require('node:assert/strict');

const realtimeTools = require('../src/chat/realtimeTools');
const executeActionModule = require('../src/chat/executeAction');
const idempotency = require('../src/chat/voiceIdempotency');

const ORIG_EXECUTE = executeActionModule.executeAction;

function stubExecuteAction(fn) { executeActionModule.executeAction = fn; }
function restore() { executeActionModule.executeAction = ORIG_EXECUTE; }

test.beforeEach(() => idempotency._reset());
test.afterEach(restore);

test('required: a confirmation-required action (swap_workout) is NOT executed without confirmed:true — returns needsConfirmation instead', async () => {
  let calls = 0;
  stubExecuteAction(async () => { calls += 1; return { done: true, description: 'swapped' }; });

  const result = await realtimeTools.runTool('execute_normos_action', { type: 'swap_workout', workoutId: 'zone2' }, { sessionId: 's1', turnId: 't1', now: new Date() });

  assert.equal(calls, 0, 'executeAction must never run before confirmation');
  assert.equal(result.needsConfirmation, true);
  assert.equal(result.done, false);
  assert.ok(result.title);
});

test('required: the SAME action called again with confirmed:true executes exactly once', async () => {
  let calls = 0;
  stubExecuteAction(async () => { calls += 1; return { done: true, description: 'swapped' }; });

  const first = await realtimeTools.runTool('execute_normos_action', { type: 'swap_workout', workoutId: 'zone2' }, { sessionId: 's1', turnId: 't1', now: new Date() });
  assert.equal(first.needsConfirmation, true);

  const confirmed = await realtimeTools.runTool('execute_normos_action', { type: 'swap_workout', workoutId: 'zone2', confirmed: true }, { sessionId: 's1', turnId: 't1', now: new Date() });
  assert.equal(confirmed.done, true);
  assert.equal(calls, 1);

  // A duplicate confirmed call for the SAME turn (e.g. a network retry, or
  // the model re-issuing it) must not re-execute — idempotency dedup.
  const duplicate = await realtimeTools.runTool('execute_normos_action', { type: 'swap_workout', workoutId: 'zone2', confirmed: true }, { sessionId: 's1', turnId: 't1', now: new Date() });
  assert.equal(calls, 1, 'the duplicate call must be served from the idempotency cache, not re-executed');
  assert.deepEqual(duplicate, confirmed);
});

test('an IMMEDIATE action (log_habit) executes directly, no confirmation gate', async () => {
  let calls = 0;
  stubExecuteAction(async () => { calls += 1; return { done: true, description: 'logged' }; });

  const result = await realtimeTools.runTool('execute_normos_action', { type: 'log_habit', habit: 'gratitude' }, { sessionId: 's2', turnId: 't1', now: new Date() });
  assert.equal(result.done, true);
  assert.equal(calls, 1);
});

test('a network retry of the exact same immediate action (same turn) does not double-execute', async () => {
  let calls = 0;
  stubExecuteAction(async () => { calls += 1; return { done: true, description: 'logged', callNumber: calls }; });

  const first = await realtimeTools.runTool('execute_normos_action', { type: 'log_habit', habit: 'exercise' }, { sessionId: 's3', turnId: 't1', now: new Date() });
  const retry = await realtimeTools.runTool('execute_normos_action', { type: 'log_habit', habit: 'exercise' }, { sessionId: 's3', turnId: 't1', now: new Date() });
  assert.equal(calls, 1);
  assert.deepEqual(retry, first);
});

test('the SAME action on a DIFFERENT turn is not deduped — a genuinely new utterance still executes', async () => {
  let calls = 0;
  stubExecuteAction(async () => { calls += 1; return { done: true, description: 'logged' }; });

  await realtimeTools.runTool('execute_normos_action', { type: 'log_habit', habit: 'exercise' }, { sessionId: 's4', turnId: 't1', now: new Date() });
  await realtimeTools.runTool('execute_normos_action', { type: 'log_habit', habit: 'exercise' }, { sessionId: 's4', turnId: 't2', now: new Date() });
  assert.equal(calls, 2);
});

test('required: voice History vs Memory separation — executing a voice action never mutates the durable beliefs store', async () => {
  const beliefsStore = require('../src/store/beliefs');
  const origUpsert = beliefsStore.upsertBelief;
  let beliefWrites = 0;
  beliefsStore.upsertBelief = async (...args) => { beliefWrites += 1; return null; };
  let executeCalls = 0;
  stubExecuteAction(async () => { executeCalls += 1; return { done: true, description: 'logged' }; });
  try {
    await realtimeTools.runTool('execute_normos_action', { type: 'log_habit', habit: 'gratitude' }, { sessionId: 's5', turnId: 't1', now: new Date() });
    await realtimeTools.runTool('execute_normos_action', { type: 'log_gratitude_text', text: 'grateful for today' }, { sessionId: 's5', turnId: 't2', now: new Date() });
    assert.equal(executeCalls, 2, 'sanity: the actions actually ran');
    assert.equal(beliefWrites, 0, 'a conversational voice action must never write to the durable beliefs/Memory store — only History');
  } finally {
    beliefsStore.upsertBelief = origUpsert;
  }
});
