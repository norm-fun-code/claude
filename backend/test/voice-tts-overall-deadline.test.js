// Audit fix, items 4/7: synthesize()'s per-model-attempt timeout (45s) was
// never bounded by a TOTAL budget — with 3 candidate models and a same-model
// retry on the last one, the worst case was ~3-4 attempts * 45s = well over
// two minutes of real wall-clock time, while every mobile Listen caller
// (useBriefAudio.ts) gives up its OWN fetch at 60s. The server could keep
// burning Gemini quota for over a minute after the client had already shown
// "Unavailable" and moved on. GEMINI_TTS_OVERALL_TIMEOUT_MS establishes ONE
// bounded end-to-end deadline for the whole retry loop. Own file (not
// voice-tts-retry.test.js) because the deadline env var must be set BEFORE
// requiring voice.js, same convention that file already uses for
// GEMINI_TTS_BACKOFF_MS.
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_TTS_BACKOFF_MS = '0';
// A tiny budget so the test runs fast — the mechanism (a wall-clock
// deadline) is identical regardless of the actual configured duration.
process.env.GEMINI_TTS_OVERALL_TIMEOUT_MS = '60';
const voice = require('../src/services/voice');

const ORIGINAL_POST = axios.post;
test.afterEach(() => { axios.post = ORIGINAL_POST; });

function err503() {
  const e = new Error('Request failed with status code 503');
  e.response = { status: 503, data: { error: { message: 'The model is overloaded.' } } };
  return e;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('synthesize: the overall deadline stops the retry loop early — never keeps trying after the client would have given up', async () => {
  // Every candidate model is transient-failing and slow (25ms/call) — with
  // no overall deadline this would exhaust all 3 models plus the last
  // model's own retry (4 calls total, mirroring voice-tts-retry.test.js's
  // "only the LAST model gets a same-model retry" case).
  const calls = [];
  axios.post = async (url) => {
    calls.push(url);
    await sleep(25);
    throw err503();
  };
  const start = Date.now();
  await assert.rejects(() => voice.synthesize('hello world'), (e) => /TTS failed/.test(e.message));
  const elapsed = Date.now() - start;
  assert.ok(calls.length < 4, `expected the 60ms overall deadline to cut the loop short before all 4 attempts, got ${calls.length} calls`);
  assert.ok(elapsed < 500, `expected synthesize() to give up close to the configured deadline, took ${elapsed}ms`);
});

test('synthesize: a fast success within the deadline is unaffected — the deadline only bounds the FAILURE/retry path', async () => {
  axios.post = async () => ({
    data: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('pcm').toString('base64'), mimeType: 'audio/L16;rate=24000' } } ] } }] },
  });
  const result = await voice.synthesize('hello world');
  assert.equal(result.mime, 'audio/wav');
});

test('synthesize: each individual attempt is capped at whichever is smaller — its own per-call timeout, or the remaining overall budget (floored at 1s so a near-exhausted budget never hands axios a degenerate ~0ms timeout)', async () => {
  // With only 60ms of overall budget and a per-call GEMINI_TTS_TIMEOUT_MS of
  // 8000ms (the default), the actual axios timeout passed for every attempt
  // must be clamped down to roughly what's left of the 60ms budget (floored
  // at 1000ms) — nowhere near the full 8s default. Confirms the clamp
  // logic actually engaged, not just that SOME timeout was passed.
  const timeouts = [];
  axios.post = async (url, body, opts) => {
    timeouts.push(opts.timeout);
    throw err503();
  };
  await assert.rejects(() => voice.synthesize('hello world'));
  assert.ok(timeouts.length > 0);
  assert.ok(timeouts.every((t) => t === 1000), `expected every attempt's own timeout to clamp down to the 1000ms floor (60ms budget is smaller than the floor), got ${JSON.stringify(timeouts)}`);
  assert.ok(timeouts.every((t) => t < 8000), 'must never be the full un-clamped per-call default when the overall budget is this small');
});
