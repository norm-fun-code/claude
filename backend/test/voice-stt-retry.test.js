// Gemini STT (transcribe()) had no retry — a live user hit both symptoms this
// causes: a 503 (overloaded) killed the whole /voice/ask request before ask()
// ever ran ("didn't register at all"), and a slow-but-successful call took
// 30+ seconds. Confirmed via Railway logs (503s and a 45000ms axios timeout
// on this exact call). One immediate retry on transient failure recovers
// most of these instead of losing the voice turn outright.
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.GEMINI_API_KEY = 'test-key';
const voice = require('../src/services/voice');

const ORIGINAL_POST = axios.post;
test.afterEach(() => { axios.post = ORIGINAL_POST; });

function okResponse(text) {
  return { data: { candidates: [{ content: { parts: [{ text }] } }] } };
}

test('transcribe: retries once on a transient 503 and succeeds', async () => {
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('Request failed with status code 503');
      err.response = { status: 503 };
      throw err;
    }
    return okResponse('log my afternoon TM');
  };
  const text = await voice.transcribe('base64audio', 'audio/wav');
  assert.equal(text, 'log my afternoon TM');
  assert.equal(calls, 2);
});

test('transcribe: retries once on an axios client timeout', async () => {
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    if (calls === 1) throw new Error('timeout of 45000ms exceeded');
    return okResponse('instead of push log a walk');
  };
  const text = await voice.transcribe('base64audio', 'audio/wav');
  assert.equal(text, 'instead of push log a walk');
  assert.equal(calls, 2);
});

test('transcribe: a second consecutive transient failure still throws (no infinite retry)', async () => {
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    const err = new Error('Request failed with status code 503');
    err.response = { status: 503 };
    throw err;
  };
  await assert.rejects(() => voice.transcribe('base64audio', 'audio/wav'));
  assert.equal(calls, 2);
});

test('transcribe: a non-transient error (e.g. bad request) throws immediately without retrying', async () => {
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    const err = new Error('Request failed with status code 400');
    err.response = { status: 400 };
    throw err;
  };
  await assert.rejects(() => voice.transcribe('base64audio', 'audio/wav'));
  assert.equal(calls, 1);
});
