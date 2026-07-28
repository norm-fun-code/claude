const test = require('node:test');
const assert = require('node:assert/strict');
const idempotency = require('../src/chat/voiceIdempotency');

test.beforeEach(() => idempotency._reset());

test('required: the same key runs fn exactly once — a second call returns the cached result, not a re-execution', async () => {
  let calls = 0;
  const key = idempotency.keyFor({ sessionId: 's1', turnId: 't1', action: 'log_habit', argsHash: 'x' });
  const first = await idempotency.once(key, async () => { calls += 1; return { done: true, calls }; });
  const second = await idempotency.once(key, async () => { calls += 1; return { done: true, calls }; });
  assert.equal(calls, 1, 'fn must only run once for the same key');
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.deepEqual(second.result, first.result);
});

test('a different key (different turn/action) is NOT deduped against another turn', async () => {
  let calls = 0;
  const keyA = idempotency.keyFor({ sessionId: 's1', turnId: 't1', action: 'log_habit', argsHash: 'x' });
  const keyB = idempotency.keyFor({ sessionId: 's1', turnId: 't2', action: 'log_habit', argsHash: 'x' });
  await idempotency.once(keyA, async () => { calls += 1; });
  await idempotency.once(keyB, async () => { calls += 1; });
  assert.equal(calls, 2);
});

test('a throwing call is never cached — a genuine failure remains retryable', async () => {
  const key = idempotency.keyFor({ sessionId: 's1', turnId: 't1', action: 'log_habit', argsHash: 'x' });
  await assert.rejects(() => idempotency.once(key, async () => { throw new Error('boom'); }));
  let calls = 0;
  const { fromCache } = await idempotency.once(key, async () => { calls += 1; return 'ok'; });
  assert.equal(calls, 1, 'the retry after a failure must actually run, not be treated as cached');
  assert.equal(fromCache, false);
});

test('hashArgs is stable for the same object shape and differs for different args', () => {
  assert.equal(idempotency.hashArgs({ a: 1, b: 'x' }), idempotency.hashArgs({ a: 1, b: 'x' }));
  assert.notEqual(idempotency.hashArgs({ a: 1 }), idempotency.hashArgs({ a: 2 }));
});
