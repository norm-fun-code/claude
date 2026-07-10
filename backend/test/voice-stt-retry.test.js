// Gemini STT (transcribe()) resilience. Live users hit consistent 503 "model
// overloaded" responses from the primary model (gemini-3.5-flash) — a
// well-documented Gemini behavior for new/preview models under load, NOT a
// reported outage. Retrying the SAME overloaded model (the old behavior)
// doesn't help and doubled the latency into a 60s spinner. Now: fast per-attempt
// timeout, a short backoff retry, then fall back to a more stable model — which
// is what actually recovers. Mocks axios.post since this calls the raw HTTP API.
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_STT_BACKOFF_MS = '0'; // don't slow the test suite
const voice = require('../src/services/voice');

const ORIGINAL_POST = axios.post;
test.afterEach(() => { axios.post = ORIGINAL_POST; });

function okResponse(text) {
  return { data: { candidates: [{ content: { parts: [{ text }] } }] } };
}
function err503() {
  const e = new Error('Request failed with status code 503');
  e.response = { status: 503, data: { error: { message: 'The model is overloaded.' } } };
  return e;
}
function modelOf(url) {
  const m = String(url).match(/\/models\/([^:]+):/);
  return m ? m[1] : null;
}

test('transcribe: first attempt on the primary model succeeds — one call, no fallback', async () => {
  const calls = [];
  axios.post = async (url) => { calls.push(modelOf(url)); return okResponse('log my morning TM'); };
  const text = await voice.transcribe('base64audio', 'audio/wav');
  assert.equal(text, 'log my morning TM');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'gemini-3.5-flash');
});

test('transcribe: a persistently 503-ing primary model falls back to the stable model, which succeeds', async () => {
  const calls = [];
  axios.post = async (url) => {
    const model = modelOf(url);
    calls.push(model);
    if (model === 'gemini-3.5-flash') throw err503();
    return okResponse('log my morning TM');
  };
  const text = await voice.transcribe('base64audio', 'audio/wav');
  assert.equal(text, 'log my morning TM', 'should transcribe via the fallback model');
  // primary tried twice (with backoff), then the fallback model succeeds.
  assert.deepEqual(calls, ['gemini-3.5-flash', 'gemini-3.5-flash', 'gemini-2.5-flash']);
});

test('transcribe: when every candidate model 503s, it throws (naming the models tried)', async () => {
  const calls = [];
  axios.post = async (url) => { calls.push(modelOf(url)); throw err503(); };
  await assert.rejects(
    () => voice.transcribe('base64audio', 'audio/wav'),
    (e) => /STT failed after trying gemini-3.5-flash, gemini-2.5-flash/.test(e.message)
  );
  // 2 models × 2 tries each.
  assert.equal(calls.length, 4);
});

test('transcribe: a non-transient error (bad request) skips retries on that model and tries the next', async () => {
  const calls = [];
  axios.post = async (url) => {
    const model = modelOf(url);
    calls.push(model);
    if (model === 'gemini-3.5-flash') {
      const e = new Error('Request failed with status code 400');
      e.response = { status: 400 };
      throw e;
    }
    return okResponse('log my morning TM');
  };
  const text = await voice.transcribe('base64audio', 'audio/wav');
  assert.equal(text, 'log my morning TM');
  // primary tried ONCE (non-transient → no retry), then fell through to fallback.
  assert.deepEqual(calls, ['gemini-3.5-flash', 'gemini-2.5-flash']);
});
