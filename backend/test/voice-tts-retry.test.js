// Gemini TTS (synthesize()) resilience AND wire contract. Live bug reported
// via the mobile "Listen" button on the Chief Brief/Wisdom: the primary model
// (gemini-3.1-flash-tts-preview) timed out at 25s and the fallback
// (gemini-2.5-flash-preview-tts) 400'd. Root cause (confirmed against
// ai.google.dev/gemini-api/docs/speech-generation, not guessed): every TTS
// model was being sent to the legacy GenerateContent endpoint
// (POST /v1beta/models/{model}:generateContent, camelCase generationConfig) —
// current Gemini TTS models are served through a SEPARATE Interactions API
// (POST /v1beta/interactions, snake_case body, x-goog-api-key header, audio
// at output_audio.data). This file pins BOTH the wire contract (so a future
// edit can't silently regress back to GenerateContent) and the existing
// retry/fallback behavior. Mocks axios.post since this calls the raw HTTP API.
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
      output_audio: { data: Buffer.from('fake-pcm').toString('base64'), mime_type: 'audio/L16;codec=pcm;rate=24000' },
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

// ── Wire contract: exact endpoint, headers, snake_case body shape ───────────

test('synthesize: POSTs to the Interactions API endpoint, never legacy GenerateContent', async () => {
  let calledUrl = null;
  axios.post = async (url) => { calledUrl = url; return okResponse(); };
  await voice.synthesize('hello world');
  assert.equal(calledUrl, voice.INTERACTIONS_URL);
  assert.equal(calledUrl, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.doesNotMatch(calledUrl, /generateContent/, 'must never hit the legacy GenerateContent path');
});

test('synthesize: sends x-goog-api-key (never the key in the URL query string) and matches the verified canonical request shape', async () => {
  let capturedOpts = null;
  let capturedUrl = null;
  axios.post = async (url, body, opts) => { capturedUrl = url; capturedOpts = opts; return okResponse(); };
  await voice.synthesize('hello world');
  assert.equal(capturedOpts.headers['x-goog-api-key'], 'test-key');
  assert.equal(capturedOpts.headers['Content-Type'], 'application/json');
  assert.doesNotMatch(capturedUrl, /key=/, 'the key must never ride in the URL query string for Interactions calls');
});

// Live bug: an earlier version of this fix sent an UNVERIFIED
// 'Api-Revision: 2026-05-20' header on every call (sourced from a
// less-reliable secondary fetch, not the canonical documented example).
// Deployed to production, every candidate model then hung for exactly the
// configured client timeout instead of the fast success/rejection the
// canonical curl example implies. The canonical example sends NO
// Api-Revision header — pin that here so a future "helpful" re-add of an
// unverified header can't silently reintroduce the same class of bug.
test('synthesize: never sends an Api-Revision header unless an operator explicitly opts in via GEMINI_INTERACTIONS_API_REVISION', async () => {
  let capturedOpts = null;
  axios.post = async (url, body, opts) => { capturedOpts = opts; return okResponse(); };
  await voice.synthesize('hello world');
  assert.equal(capturedOpts.headers['Api-Revision'], undefined, 'the canonical documented example sends no Api-Revision header — do not send an unverified one by default');
});

test('synthesize: request body is exact snake_case Interactions shape (model, input, response_format, generation_config.speech_config)', async () => {
  let body = null;
  axios.post = async (url, b) => { body = b; return okResponse(); };
  await voice.synthesize('hello world', { voice: 'Orus' });
  assert.equal(body.model, 'gemini-3.1-flash-tts-preview');
  assert.equal(typeof body.input, 'string');
  assert.deepEqual(body.response_format, { type: 'audio' });
  assert.ok(Array.isArray(body.generation_config.speech_config), 'speech_config must be an array per the documented contract');
  assert.equal(body.generation_config.speech_config[0].voice, 'Orus');
  // Never the legacy camelCase fields.
  assert.equal(body.contents, undefined);
  assert.equal(body.generationConfig, undefined);
});

test('synthesize: the transcript is spoken verbatim — the delivery direction is a separate, clearly labeled section, not silently merged into it', async () => {
  let body = null;
  axios.post = async (url, b) => { body = b; return okResponse(); };
  await voice.synthesize('Recovery is green at ninety out of a hundred today.', { style: 'Speak with quiet confidence.' });
  assert.match(body.input, /TRANSCRIPT/, 'the exact spoken text must be under an explicitly labeled TRANSCRIPT section');
  assert.match(body.input, /DIRECTOR'S NOTES/, 'the delivery direction must be under its own explicitly labeled section');
  assert.match(body.input, /Recovery is green at ninety out of a hundred today\./);
  assert.match(body.input, /Speak with quiet confidence\./);
  // The transcript must appear AFTER its own label, not concatenated ahead of
  // the direction the way the old GenerateContent prompt did.
  assert.ok(body.input.indexOf('TRANSCRIPT') < body.input.indexOf('Recovery is green'));
});

test('synthesize: parses audio from output_audio.data (the Interactions response shape), not candidates[].content.parts[].inlineData', async () => {
  axios.post = async () => okResponse();
  const result = await voice.synthesize('hello world');
  assert.equal(result.mime, 'audio/wav');
  assert.ok(Buffer.isBuffer(result.audio) && result.audio.length > 44, 'must return a real WAV buffer decoded from output_audio.data');
});

// ── Retry/fallback behavior (unchanged from before the endpoint migration) ──

test('synthesize: the primary model succeeds on the first try — one call, no fallback', async () => {
  let calls = 0;
  axios.post = async () => { calls++; return okResponse(); };
  const result = await voice.synthesize('hello world');
  assert.equal(result.mime, 'audio/wav');
  assert.equal(calls, 1, 'the happy path must be a single fast call');
});

test('synthesize: a timeout on the primary (non-last) model falls straight to the fallback, not a dead end', async () => {
  const models = [];
  let first = true;
  axios.post = async (url, body) => {
    models.push(body.model);
    if (first) { first = false; throw errTimeout(); }
    return okResponse();
  };
  const result = await voice.synthesize('hello world');
  assert.equal(result.mime, 'audio/wav', 'must recover via the fallback model instead of throwing');
  assert.equal(models.length, 2, 'primary tried once (not last -> no same-model retry), then fell through to the fallback');
});

test('synthesize: only the LAST model gets a same-model retry on a transient error', async () => {
  const models = [];
  axios.post = async (url, body) => { models.push(body.model); throw err503(); };
  await assert.rejects(() => voice.synthesize('hello world'), (e) => /TTS failed/.test(e.message));
  // 3 candidate models; only the last gets tried twice = 4 calls total.
  assert.equal(models.length, 4);
  assert.equal(models[models.length - 1], models[models.length - 2], 'the last model must be retried once');
});

test('synthesize: "model doesn\'t exist" (404/400) on an early model falls through to the next candidate', async () => {
  const models = [];
  let count = 0;
  axios.post = async (url, body) => {
    models.push(body.model);
    count++;
    if (count === 1) throw err400();
    return okResponse();
  };
  const result = await voice.synthesize('hello world');
  assert.equal(result.mime, 'audio/wav');
  assert.equal(models.length, 2, 'a bad-model-id error must not stop the fallback chain');
});

test('synthesize: returns which model actually produced the audio, for prewarm/backfill logging', async () => {
  let first = true;
  axios.post = async () => {
    if (first) { first = false; throw errTimeout(); }
    return okResponse();
  };
  const result = await voice.synthesize('hello world');
  assert.equal(result.model, 'gemini-2.5-flash-preview-tts', 'must report the SECOND (fallback) model, not the first that failed');
});

test('synthesize: the configured model list never regresses to the retired/nonexistent "gemini-3.5-flash-tts" id', async () => {
  const models = [];
  axios.post = async (url, body) => { models.push(body.model); throw err503(); };
  process.env.GEMINI_TTS_BACKOFF_MS = '0';
  await assert.rejects(() => voice.synthesize('hello world'));
  assert.ok(!models.includes('gemini-3.5-flash-tts'), `must never call the nonexistent 'gemini-3.5-flash-tts' model again, got: ${JSON.stringify(models)}`);
  assert.deepEqual(models, ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts', 'gemini-2.5-pro-preview-tts']);
});

test('synthesize: no TTS candidate can ever regress to the legacy GenerateContent URL', async () => {
  const urls = [];
  axios.post = async (url) => { urls.push(url); throw err503(); };
  await assert.rejects(() => voice.synthesize('hello world'));
  assert.ok(urls.length > 0);
  assert.ok(urls.every((u) => u === voice.INTERACTIONS_URL), `every attempt (across every candidate model) must hit the Interactions endpoint, got: ${JSON.stringify(urls)}`);
  assert.ok(urls.every((u) => !/generateContent/.test(u)));
});

test('synthesize: gemini-3.1-flash-tts-preview (the model confirmed working in production) is PRIMARY, tried first', async () => {
  const models = [];
  axios.post = async (url, body) => { models.push(body.model); return okResponse(); };
  const result = await voice.synthesize('hello world');
  assert.equal(models[0], 'gemini-3.1-flash-tts-preview');
  assert.equal(result.model, 'gemini-3.1-flash-tts-preview');
  assert.equal(models.length, 1, 'the confirmed-working primary should succeed on the first call — no fallback needed');
});

test('synthesize: logs the endpoint, model, status, elapsed time, AND the PROVIDER\'s own error detail so a failure is diagnosable from logs alone', async () => {
  axios.post = async () => {
    const e = new Error('Request failed with status code 400');
    e.response = { status: 400, data: { error: { message: 'Request contains an invalid argument.' } } };
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
  const combined = logged.join('\n');
  assert.match(combined, /endpoint=interactions/, 'must log which API path was used');
  assert.match(combined, /elapsedMs=\d+/, 'must log elapsed time per attempt');
  assert.match(combined, /Request contains an invalid argument\./, 'the provider\'s detailed error message must appear in the per-attempt log line');
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
