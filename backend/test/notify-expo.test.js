const test = require('node:test');
const assert = require('node:assert/strict');
const { sendPush } = require('../src/notify/expo');

test('Expo push delivery is issued with a cancellable deadline signal', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  let signal = null;
  global.fetch = async (_url, opts) => {
    signal = opts.signal;
    return {
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    };
  };

  const result = await sendPush(['ExponentPushToken[test]'], { title: 'Ready', body: 'Your brief is ready.' });
  assert.equal(result.sent, 1);
  assert.ok(signal instanceof AbortSignal, 'Expo fetch must have a transport-abort signal');
  assert.equal(signal.aborted, false);
});
