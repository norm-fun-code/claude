// Gemini TTS (synthesize()) resilience AND wire contract.
//
// The full arc, so this file's assertions make sense: TTS originally ran on
// GenerateContent and Chief narration worked. Adding Wisdom Listen caused a
// CONCURRENT-prewarm contention regression (two overlapping TTS calls, each
// timing out) — that was misdiagnosed as a wrong-endpoint problem and
// migrated to a "/v1beta/interactions" API sourced from unverifiable
// doc-scraping. In production EVERY serialized (uncontended) interactions
// call hung with ECONNABORTED. The authoritative google-genai SDKs confirm
// TTS is served through GenerateContent (there is no interactions endpoint),
// so synthesize() is reverted to GenerateContent. This file pins that wire
// contract so it can't silently regress back to the broken endpoint again,
// plus the retry/fallback behavior. Mocks axios.post since this is raw HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_TTS_BACKOFF_MS = '0'; // don't slow the test suite
const voice = require('../src/services/voice');

const ORIGINAL_POST = axios.post;
test.afterEach(() => { axios.post = ORIGINAL_POST; });

// GenerateContent TTS response: audio inline as base64 PCM under
// candidates[0].content.parts[].inlineData.
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
  const m = String(url).match(/\/models\/([^:]+):generateContent/);
  return m ? m[1] : null;
}

// ── Wire contract: GenerateContent endpoint, headers, request/response shape ──

test('synthesize: POSTs to the GenerateContent endpoint, never the broken /v1beta/interactions endpoint', async () => {
  let calledUrl = null;
  axios.post = async (url) => { calledUrl = url; return okResponse(); };
  await voice.synthesize('hello world');
  assert.match(calledUrl, /\/v1beta\/models\/[^:]+:generateContent$/, 'must POST to models/{model}:generateContent');
  assert.doesNotMatch(calledUrl, /interactions/, 'must NEVER hit the /v1beta/interactions endpoint — it hangs every call in production (ECONNABORTED)');
});

test('synthesize: sends x-goog-api-key as a header, never the key in the URL query string', async () => {
  let capturedOpts = null;
  let capturedUrl = null;
  axios.post = async (url, body, opts) => { capturedUrl = url; capturedOpts = opts; return okResponse(); };
  await voice.synthesize('hello world');
  assert.equal(capturedOpts.headers['x-goog-api-key'], 'test-key');
  assert.equal(capturedOpts.headers['Content-Type'], 'application/json');
  assert.doesNotMatch(capturedUrl, /key=/, 'the key must never ride in the URL query string (it would leak into a logged request URL)');
});

test('synthesize: request body is the GenerateContent TTS shape (contents + generationConfig.responseModalities:[AUDIO] + speechConfig)', async () => {
  let body = null;
  axios.post = async (url, b) => { body = b; return okResponse(); };
  await voice.synthesize('hello world', { voice: 'Orus' });
  assert.ok(Array.isArray(body.contents), 'must send contents[]');
  assert.deepEqual(body.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Orus');
  // Never the interactions-shaped snake_case fields.
  assert.equal(body.input, undefined);
  assert.equal(body.response_format, undefined);
  assert.equal(body.generation_config, undefined);
});

test('synthesize: parses audio from candidates[0].content.parts[].inlineData (the GenerateContent response shape)', async () => {
  axios.post = async () => okResponse();
  const result = await voice.synthesize('hello world');
  assert.equal(result.mime, 'audio/wav');
  assert.ok(Buffer.isBuffer(result.audio) && result.audio.length > 44, 'must return a real WAV buffer decoded from the inline PCM');
});

// Live bug, confirmed by Gemini's own 400 in production: "Model tried to
// generate text, but it should only be used for TTS. Make sure your
// instructions are clear to only generate audio from the transcript." The
// old prompt front-loaded chat-assistant language ("Keep responses
// conversational and concise", "Sound like a trusted friend who is
// genuinely excited to help") that the TTS model read as a request to
// GENERATE a response, causing that 400 (or a hang while it tried to voice
// a generated response). The prompt must now be an unambiguous read-aloud
// instruction that speaks ONLY the transcript.
test('synthesize: the prompt is a clear read-aloud instruction that speaks only the transcript — never chat-assistant "generate a response" language', async () => {
  let body = null;
  axios.post = async (url, b) => { body = b; return okResponse(); };
  await voice.synthesize('Recovery is green at ninety today.');
  const text = body.contents[0].parts[0].text;
  assert.match(text, /read the following transcript aloud/i, 'must explicitly instruct reading the transcript aloud');
  assert.match(text, /speak only the transcript/i, 'must tell the model to speak ONLY the transcript, per Gemini\'s own 400 guidance');
  assert.match(text, /do not (reply|respond)/i, 'must forbid replying/responding to the transcript');
  assert.match(text, /Recovery is green at ninety today\./, 'the exact transcript text must be present, under its own Transcript: label');
  // Regression guard on the specific phrases that caused the 400.
  assert.doesNotMatch(text, /keep responses conversational/i, 'must not carry the old "keep responses conversational" chat-assistant instruction');
});

// ── Retry/fallback behavior ─────────────────────────────────────────────────

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
  axios.post = async (url) => {
    models.push(modelOf(url));
    if (first) { first = false; throw errTimeout(); }
    return okResponse();
  };
  const result = await voice.synthesize('hello world');
  assert.equal(result.mime, 'audio/wav', 'must recover via the fallback model instead of throwing');
  assert.equal(models.length, 2, 'primary tried once (not last -> no same-model retry), then fell through to the fallback');
});

test('synthesize: only the LAST model gets a same-model retry on a transient error', async () => {
  const models = [];
  axios.post = async (url) => { models.push(modelOf(url)); throw err503(); };
  await assert.rejects(() => voice.synthesize('hello world'), (e) => /TTS failed/.test(e.message));
  // 2 candidate models; only the last gets tried twice = 3 calls total.
  assert.equal(models.length, 3);
  assert.equal(models[models.length - 1], models[models.length - 2], 'the last model must be retried once');
});

test('synthesize: "model doesn\'t exist" (404/400) on an early model falls through to the next candidate', async () => {
  const models = [];
  let count = 0;
  axios.post = async (url) => {
    models.push(modelOf(url));
    count++;
    if (count === 1) throw err400();
    return okResponse();
  };
  const result = await voice.synthesize('hello world');
  assert.equal(result.mime, 'audio/wav');
  assert.equal(models.length, 2, 'a bad-model-id error must not stop the fallback chain');
});

test('synthesize: returns which model actually produced the audio, for logging', async () => {
  let first = true;
  axios.post = async () => {
    if (first) { first = false; throw errTimeout(); }
    return okResponse();
  };
  const result = await voice.synthesize('hello world');
  assert.equal(result.model, 'gemini-2.5-pro-preview-tts', 'must report the SECOND (fallback) model, not the first that failed');
});

test('synthesize: no TTS candidate can ever regress to the /v1beta/interactions endpoint', async () => {
  const urls = [];
  axios.post = async (url) => { urls.push(url); throw err503(); };
  await assert.rejects(() => voice.synthesize('hello world'));
  assert.ok(urls.length > 0);
  assert.ok(urls.every((u) => /:generateContent$/.test(u)), `every attempt must hit GenerateContent, got: ${JSON.stringify(urls)}`);
  assert.ok(urls.every((u) => !/interactions/.test(u)), 'never the interactions endpoint that hung every production call');
});

test('synthesize: the candidate list leads with gemini-2.5-flash-preview-tts (the last model confirmed to have worked) and excludes the hangs-on-generateContent 3.1', async () => {
  const models = [];
  axios.post = async (url) => { models.push(modelOf(url)); return okResponse(); };
  await voice.synthesize('hello world');
  assert.equal(models[0], 'gemini-2.5-flash-preview-tts', 'primary must be the model that was primary when Chief narration last worked');
  assert.ok(!voice.TTS_CANDIDATES.includes('gemini-3.1-flash-tts-preview'), 'gemini-3.1-flash-tts-preview HANGS on GenerateContent (full 25s timeout, never a fast fail) — it must not be a default candidate');
});

test('synthesize: logs the endpoint, model, status, elapsed time, error code, AND the provider\'s own error detail so a failure is diagnosable from logs alone', async () => {
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
  assert.match(combined, /endpoint=generateContent/, 'must log which API path was used');
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
  assert.ok(elapsed < 2000, `expected the fallback to succeed quickly, took ${elapsed}ms`);
});
