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

test('synthesize: returns which model actually produced the audio, for prewarm/backfill logging', async () => {
  let first = true;
  axios.post = async () => {
    if (first) { first = false; throw errTimeout(); }
    return okResponse();
  };
  const result = await voice.synthesize('hello world');
  assert.equal(result.model, 'gemini-2.5-pro-preview-tts', 'must report the SECOND (fallback) model, not the first that failed');
});

// ── Wisdom Listen timeout fix: a primary-model timeout must fall back and
// succeed comfortably within the client's terminal deadline, not merely
// "eventually" — the live bug was one slow/hanging model alone eating
// nearly the ENTIRE overall budget, leaving no real room for a fallback. ──

// ── Live production bug, confirmed via Railway logs: the model list itself
// contained an invalid model id ('gemini-3.5-flash-tts' — Gemini returned a
// 404 "is not found for API version v1beta, or is not supported for
// generateContent" on every single call). No timeout tuning fixes calling a
// nonexistent model — this regression test pins the model list to the real
// current model ids so a future edit can't silently reintroduce a typo'd or
// retired one. ──────────────────────────────────────────────────────────

test('synthesize: the configured model list never regresses to the retired/nonexistent "gemini-3.5-flash-tts" id', async () => {
  const calls = [];
  axios.post = async (url) => { calls.push(String(url).match(/\/models\/([^:]+):/)?.[1]); throw err503(); };
  process.env.GEMINI_TTS_BACKOFF_MS = '0';
  await assert.rejects(() => voice.synthesize('hello world'));
  assert.ok(!calls.includes('gemini-3.5-flash-tts'), `must never call the nonexistent 'gemini-3.5-flash-tts' model again, got: ${JSON.stringify(calls)}`);
  assert.deepEqual(calls, ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts', 'gemini-3.1-flash-tts-preview', 'gemini-3.1-flash-tts-preview']);
});

test('synthesize: logs the PROVIDER\'s own error detail (not just the generic HTTP status message) so a bad model id is diagnosable from logs alone', async () => {
  axios.post = async () => {
    const e = new Error('Request failed with status code 404');
    e.response = { status: 404, data: { error: { message: "models/gemini-3.5-flash-tts is not found for API version v1beta, or is not supported for generateContent." } } };
    throw e;
  };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    await assert.rejects(() => voice.synthesize('hello world'));
  } finally {
    console.error = originalError;
  }
  assert.ok(logged.some((l) => l.includes('is not found for API version')), 'the provider\'s detailed error message must appear in the per-attempt log line, not just "Request failed with status code 404"');
});

test('synthesize: a primary-model timeout still succeeds via fallback well within the total deadline (fast-fallback, not one long attempt)', async () => {
  let first = true;
  axios.post = async () => {
    if (first) {
      first = false;
      await new Promise((r) => setTimeout(r, 20)); // simulate a genuinely slow/hanging primary model
      throw errTimeout();
    }
    return okResponse();
  };
  const start = Date.now();
  const result = await voice.synthesize('hello world');
  const elapsed = Date.now() - start;
  assert.equal(result.mime, 'audio/wav');
  // The whole point of shrinking GEMINI_TTS_TIMEOUT_MS is that a fallback
  // succeeds in low-single-digit-seconds territory, not by burning most of
  // the ~40s overall budget on the first attempt alone.
  assert.ok(elapsed < 2000, `expected the fallback to succeed quickly, took ${elapsed}ms`);
});
