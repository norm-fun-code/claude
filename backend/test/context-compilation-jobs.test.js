const test = require('node:test');
const assert = require('node:assert/strict');
const { retryDelayMs, MAX_ATTEMPTS } = require('../src/store/contextCompilationJobs');

test('context-compilation retry backoff is bounded and increases after transient failures', () => {
  assert.equal(retryDelayMs(1), 30_000);
  assert.equal(retryDelayMs(2), 60_000);
  assert.ok(retryDelayMs(5) > retryDelayMs(2));
  assert.ok(retryDelayMs(999) <= 60 * 60 * 1000, 'a broken provider cannot create an unbounded delay');
  assert.equal(MAX_ATTEMPTS, 5, 'terminal failure is explicit after a finite retry budget');
});
