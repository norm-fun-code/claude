const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithTimeout } = require('../src/util/async');

test('fetchWithTimeout aborts a hung provider request and returns a terminal timeout error', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  let observedAbort = false;
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      observedAbort = true;
      const err = new Error('fetch aborted');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });

  await assert.rejects(
    () => fetchWithTimeout('https://provider.example.test', {}, 10, 'provider request'),
    (err) => err.code === 'ETIMEDOUT' && /provider request timed out after 10ms/.test(err.message),
  );
  assert.equal(observedAbort, true, 'the underlying network operation must be aborted, not merely ignored');
});
