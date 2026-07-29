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

test('required: two SIMULTANEOUS calls with the same key execute fn exactly once (Promise.all)', async () => {
  let calls = 0;
  const key = idempotency.keyFor({ sessionId: 's1', turnId: 't1', action: 'log_habit', argsHash: 'x' });
  const fn = async () => {
    calls += 1;
    // Yield so both concurrent callers are guaranteed to have already
    // issued their `once()` call before either sees a resolved result —
    // this is the exact race the fix closes (both must join the SAME
    // in-flight Promise, not both pass the "is anything cached yet" check).
    await new Promise((r) => setImmediate(r));
    return { done: true, calls };
  };
  const [a, b] = await Promise.all([idempotency.once(key, fn), idempotency.once(key, fn)]);
  assert.equal(calls, 1, 'fn must execute exactly once across two simultaneous calls');
  assert.deepEqual(a.result, b.result);
  // Exactly one of the two callers observes fromCache:false (the one that
  // actually ran fn); the other joined its in-flight Promise.
  assert.equal([a.fromCache, b.fromCache].filter((v) => v === false).length, 1);
  assert.equal([a.fromCache, b.fromCache].filter((v) => v === true).length, 1);
});

test('required: a failed in-flight call is removed so a subsequent retry actually runs, even when a concurrent joiner was waiting on it', async () => {
  let calls = 0;
  const key = idempotency.keyFor({ sessionId: 's1', turnId: 't1', action: 'log_habit', argsHash: 'x' });
  const failingFn = async () => { calls += 1; await new Promise((r) => setImmediate(r)); throw new Error('boom'); };
  const results = await Promise.allSettled([idempotency.once(key, failingFn), idempotency.once(key, failingFn)]);
  assert.equal(calls, 1, 'the failing fn must still only run once for two simultaneous callers');
  assert.ok(results.every((r) => r.status === 'rejected'), 'both concurrent joiners see the failure');

  const { fromCache } = await idempotency.once(key, async () => { calls += 1; return 'ok'; });
  assert.equal(calls, 2, 'a retry after both concurrent calls failed must actually run');
  assert.equal(fromCache, false);
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
