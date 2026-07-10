// Gemini TTS (synthesize()) resilience. Live bug reported via the mobile
// "Listen" button on the Chief Brief: it took a long time to load, sometimes
// flashed "Unavailable", then a second tap played fine. Railway logs showed
// "[briefing audio] TTS failed: TTS failed: timeout of ...ceeded". Root
// cause: synthesize()'s model-fallback loop `break`d out of the ENTIRE loop
// on any error that wasn't a plain 404/400 "model doesn't exist" — a single
// timed-out (or otherwise transient) call on the FIRST candidate model
// killed the whole request with zero fallback attempted, no retry at all.
// Now mirrors transcribe()'s already-proven retry structure: every model in
// the fallback list gets tried regardless of error type, and only the LAST
// model gets a same-model retry-with-backoff on a transient failure. Mocks
// axios.post since this calls the raw HTTP API.
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_TTS_BACKOFF_MS = '0'; // don't slow the test suite
const voice = require('../src/services/voice');

const ORIGINAL_POST = axios.post;
test.afterEach(() => { axios.post = ORIGINAL_POST; });

function okResponse() {
  return {
    data: {
      candidates: [{
        content: { parts: [{ inlineData: { data: Buffer.from('fake-pcm').toString('base64'), mimeType: 'audio/L16;codec=pcm;rate=24000' } }] },
      }],
    },
  };
}
function errTimeout() {
  const e = new Error('timeout of 45000ms exceeded');
  e.code = 'ECONNABORTED';
  return e;
}
function err503() {
  const e = new Error('Request failed with status code 503');
  e.response = { status: 503, data: { error: { message: 'The model is overloaded.' } } };
  return e;
}
function err400() {
  const e = new Error('Request failed with status code 400');
  e.response = { status: 400, data: { error: { message: 'model not found' } } };
  return e;
}
function modelOf(url) {
  const m = String(url).match(/\/models\/([^:]+):/);
  return m ? m[1] : null;
}

test('synthesize: the primary model succeeds on the first try — one call, no fallback', async () => {
  const calls = [];
  axios.post = async (url) => { calls.push(modelOf(url)); return okResponse(); };
  const result = await voice.synthesize('hello world');
  assert.equal(result.mime, 'audio/wav');
  assert.equal(calls.length, 1, 'the happy path must be a single fast call');
});

test('synthesize: a timeout on the primary (non-last) model falls straight to the fallback, not a dead end', async () => {
  // This is the exact live bug: before the fix, this single timeout on the
  // FIRST model aborted synthesize() entirely with no fallback attempted.
  const calls = [];
  let first = true;
  axios.post = async (url) => {
    calls.push(modelOf(url));
    if (first) { first = false; throw errTimeout(); }
    return okResponse();
  };
  const result = await voice.synthesize('hello world');
  assert.equal(result.mime, 'audio/wav', 'must recover via the fallback model instead of throwing');
  assert.equal(calls.length, 2, 'primary tried once (not last -> no same-model retry), then fell through to the fallback');
});

test('synthesize: only the LAST model gets a same-model retry on a transient error', async () => {
  const calls = [];
  axios.post = async (url) => { calls.push(modelOf(url)); throw err503(); };
  await assert.rejects(() => voice.synthesize('hello world'), (e) => /TTS failed/.test(e.message));
  // 3 candidate models; only the last gets tried twice = 4 calls total.
  assert.equal(calls.length, 4);
  assert.equal(calls[calls.length - 1], calls[calls.length - 2], 'the last model must be retried once');
});

test('synthesize: "model doesn\'t exist" (404/400) on an early model falls through to the next candidate', async () => {
  const calls = [];
  let count = 0;
  axios.post = async (url) => {
    calls.push(modelOf(url));
    count++;
    if (count === 1) throw err400();
    return okResponse();
  };
  const result = await voice.synthesize('hello world');
  assert.equal(result.mime, 'audio/wav');
  assert.equal(calls.length, 2, 'a bad-model-id error must not stop the fallback chain');
});
