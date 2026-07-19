// Unit coverage for services/ttsProvider.js — the provider-neutral TTS
// router (audit fix: Gemini's preview TTS models intermittently stalling
// for the full per-attempt timeout on a real Wisdom-length script). Proves
// the required regression scenarios: Gemini-timeout-falls-back-to-OpenAI,
// OpenAI-timeout-falls-back-to-Gemini, a bounded total deadline (never the
// old "25s serially per candidate" shape), Brief and Wisdom sharing the
// identical provider path, concurrent-tap dedup surviving the new router,
// success-cached/failure-not, and no keys or transcript text ever reaching
// logs. Mocks are ONE part of this suite, not the only verification — see
// test/integration/tts-provider-live-probe.test.js for a real,
// production-safe short probe against whichever providers are actually
// configured (skips cleanly when neither key is set, e.g. in this sandbox).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const voiceService = require('../src/services/voice');
const openaiService = require('../src/services/ttsOpenai');
const ttsProvider = require('../src/services/ttsProvider');
const { audioFor } = require('../src/services/brief-audio');

const ORIGINAL_GEMINI_SYNTH = voiceService.synthesize;
const ORIGINAL_OPENAI_SYNTH = openaiService.synthesize;
const ORIGINAL_QUERY = db.query;
const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_GEMINI_KEY = process.env.GEMINI_API_KEY;
const ORIGINAL_MODE = process.env.NORMOS_TTS_PROVIDER;

test.afterEach(() => {
  voiceService.synthesize = ORIGINAL_GEMINI_SYNTH;
  openaiService.synthesize = ORIGINAL_OPENAI_SYNTH;
  db.query = ORIGINAL_QUERY;
  if (ORIGINAL_OPENAI_KEY == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
  if (ORIGINAL_GEMINI_KEY == null) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_KEY;
  if (ORIGINAL_MODE == null) delete process.env.NORMOS_TTS_PROVIDER; else process.env.NORMOS_TTS_PROVIDER = ORIGINAL_MODE;
});

function stubDb() {
  const inserts = [];
  db.query = async (sql, params) => {
    if (/SELECT audio, mime FROM tts_audio/.test(sql)) return { rows: [] };
    if (/INSERT INTO tts_audio/.test(sql)) { inserts.push(params); return { rows: [] }; }
    if (/DELETE FROM tts_audio/.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  };
  return inserts;
}

// ── Pure: resolveProviderOrder / computeProviderBudget / describeConfig ──

test('resolveProviderOrder: auto mode prefers openai when a key is configured', () => {
  assert.deepEqual(ttsProvider.resolveProviderOrder('auto', true), ['openai', 'gemini']);
});

test('resolveProviderOrder: auto mode drops openai from the order entirely when no key is configured', () => {
  assert.deepEqual(ttsProvider.resolveProviderOrder('auto', false), ['gemini']);
});

test('resolveProviderOrder: gemini mode prefers gemini but still keeps openai as a fallback when configured', () => {
  assert.deepEqual(ttsProvider.resolveProviderOrder('gemini', true), ['gemini', 'openai']);
});

test('resolveProviderOrder: openai mode still falls back to gemini ("OpenAI timeout/error falls back to Gemini when configured")', () => {
  assert.deepEqual(ttsProvider.resolveProviderOrder('openai', true), ['openai', 'gemini']);
});

test('resolveProviderOrder: an unrecognized mode value behaves like auto', () => {
  assert.deepEqual(ttsProvider.resolveProviderOrder('nonsense', true), ['openai', 'gemini']);
});

test('computeProviderBudget: splits the remaining deadline evenly across remaining candidates, capped at the provider max', () => {
  assert.equal(ttsProvider.computeProviderBudget(40000, 2, 25000), 20000);
  assert.equal(ttsProvider.computeProviderBudget(10000, 2, 25000), 5000);
  // Capped at the provider's own max even when a bigger share is available.
  assert.equal(ttsProvider.computeProviderBudget(40000, 1, 12000), 12000);
});

test('computeProviderBudget: zero or negative remaining/count yields zero budget, never a negative or NaN timeout', () => {
  assert.equal(ttsProvider.computeProviderBudget(0, 2, 25000), 0);
  assert.equal(ttsProvider.computeProviderBudget(-500, 2, 25000), 0);
  assert.equal(ttsProvider.computeProviderBudget(40000, 0, 25000), 0);
});

test('describeConfig: reflects NORMOS_TTS_PROVIDER and OPENAI_API_KEY presence in the primary provider it reports', () => {
  process.env.OPENAI_API_KEY = 'sk-test-key-1234567890';
  process.env.NORMOS_TTS_PROVIDER = 'auto';
  assert.equal(ttsProvider.describeConfig().primary, 'openai');
  process.env.NORMOS_TTS_PROVIDER = 'gemini';
  assert.equal(ttsProvider.describeConfig().primary, 'gemini');
  delete process.env.OPENAI_API_KEY;
  process.env.NORMOS_TTS_PROVIDER = 'auto';
  assert.equal(ttsProvider.describeConfig().primary, 'gemini', 'no OpenAI key at all must never be reported as primary');
});

// ── Required test 1: Gemini timeout falls back to OpenAI successfully ───

test('required test 1: a Gemini timeout falls back to OpenAI and still returns audio', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key-1234567890';
  process.env.NORMOS_TTS_PROVIDER = 'gemini'; // force Gemini primary so the fallback path is exercised deterministically
  voiceService.synthesize = async () => {
    const e = new Error('TTS failed: timeout of 25000ms exceeded');
    throw e;
  };
  openaiService.synthesize = async () => ({ audio: Buffer.from('openai-audio'), mime: 'audio/wav', model: 'gpt-4o-mini-tts' });
  const result = await ttsProvider.synthesizeWithFallback('Today looks steady.');
  assert.equal(result.provider, 'openai');
  assert.deepEqual(result.audio, Buffer.from('openai-audio'));
});

// ── Required test 2: OpenAI timeout/error falls back to Gemini ──────────

test('required test 2: an OpenAI timeout/error falls back to Gemini when configured', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key-1234567890';
  process.env.NORMOS_TTS_PROVIDER = 'auto'; // openai primary by default
  openaiService.synthesize = async () => {
    const e = new Error('OpenAI TTS failed: timeout of 12000ms exceeded');
    e.code = 'ECONNABORTED';
    throw e;
  };
  voiceService.synthesize = async () => ({ audio: Buffer.from('gemini-audio'), mime: 'audio/wav', model: 'gemini-2.5-flash-preview-tts' });
  const result = await ttsProvider.synthesizeWithFallback('Today looks steady.');
  assert.equal(result.provider, 'gemini');
  assert.deepEqual(result.audio, Buffer.from('gemini-audio'));
});

test('when every configured provider fails, synthesizeWithFallback rejects with a combined, key-free message', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key-1234567890';
  process.env.NORMOS_TTS_PROVIDER = 'auto';
  openaiService.synthesize = async () => { throw new Error('OpenAI TTS failed: rate limited'); };
  voiceService.synthesize = async () => { throw new Error('TTS failed: overall timeout budget exceeded'); };
  await assert.rejects(
    () => ttsProvider.synthesizeWithFallback('Today looks steady.'),
    (err) => /TTS failed on every provider/.test(err.message) && /openai, gemini/.test(err.message)
  );
});

// ── Required test 3: the total synthesis deadline is bounded ────────────

test('required test 3: the total deadline is bounded — providers never each get their full independent timeout serially', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key-1234567890';
  process.env.NORMOS_TTS_PROVIDER = 'auto';
  // Small but comfortably above computeProviderBudget's 1000ms skip floor —
  // an even 2-way split gives each candidate a real, exercisable budget.
  process.env.TTS_OVERALL_TIMEOUT_MS = '3000';
  delete require.cache[require.resolve('../src/services/ttsProvider')];
  const freshRouter = require('../src/services/ttsProvider');
  const seenBudgets = [];
  // Each mock actually WAITS its allocated budget before failing/succeeding
  // — simulating a provider that would hang for its own (much larger) max
  // if nothing bounded it — so a bounded elapsed time here proves the
  // router's budget cap is what actually cut it short, not that the mock
  // just happened to return instantly.
  openaiService.synthesize = async (text, opts) => {
    seenBudgets.push(['openai', opts.budgetMs]);
    await new Promise((r) => setTimeout(r, opts.budgetMs));
    throw new Error('slow/failing primary');
  };
  voiceService.synthesize = async (text, opts) => {
    seenBudgets.push(['gemini', opts.budgetMs]);
    await new Promise((r) => setTimeout(r, Math.min(opts.budgetMs, 20)));
    return { audio: Buffer.from('x'), mime: 'audio/wav', model: 'gemini-2.5-flash-preview-tts' };
  };
  const start = Date.now();
  await freshRouter.synthesizeWithFallback('short');
  const elapsed = Date.now() - start;
  assert.equal(seenBudgets.length, 2, 'both providers must have been attempted');
  const [, openaiBudget] = seenBudgets.find(([p]) => p === 'openai');
  // openai's real per-provider ceiling is 12000ms and gemini's is 50000ms
  // (voice.js's own 2-model retry budget) — with NO overall deadline, a
  // hung openai call alone could have burned up to its full 12000ms before
  // gemini ever got a turn. Bounded to an even split of the 3000ms overall
  // deadline instead: nowhere near either provider's own unbounded max.
  assert.ok(openaiBudget <= 1500, `openai's budget must be capped well below its own 12000ms ceiling by the shared deadline, got ${openaiBudget}ms`);
  assert.ok(elapsed < 2000, `expected the whole fallback sequence to resolve well under the old ~12s+25s serial shape, took ${elapsed}ms`);
  delete process.env.TTS_OVERALL_TIMEOUT_MS;
  delete require.cache[require.resolve('../src/services/ttsProvider')];
});

// ── Required test 4: Brief and Wisdom use the identical provider path ───

test('required test 4: Brief and Wisdom narration both call the SAME router function, not two independent paths', async () => {
  stubDb();
  const calls = [];
  const originalFallback = ttsProvider.synthesizeWithFallback;
  ttsProvider.synthesizeWithFallback = async (script) => {
    calls.push(script);
    return { audio: Buffer.from('audio'), mime: 'audio/wav', model: 'test-model', provider: 'gemini' };
  };
  try {
    await audioFor('brief', { chiefBrief: { synthesis: 'Provider-path brief synthesis text.' } }, '2026-07-21');
    await audioFor('wisdom', { quote: 'Provider-path quote.', quoteInsight: 'Provider-path insight.' }, '2026-07-21');
  } finally {
    ttsProvider.synthesizeWithFallback = originalFallback;
  }
  assert.equal(calls.length, 2, 'both Brief and Wisdom must reach the router — neither may bypass it with its own direct provider call');
});

// ── Required test 5: concurrent taps do not create duplicate synthesis ──

test('required test 5: concurrent Listen taps for the same content share ONE synthesis through the new router path', async () => {
  stubDb();
  let calls = 0;
  process.env.OPENAI_API_KEY = 'sk-test-key-1234567890';
  openaiService.synthesize = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 15));
    return { audio: Buffer.from('dedup-audio'), mime: 'audio/wav', model: 'gpt-4o-mini-tts' };
  };
  const content = { chiefBrief: { synthesis: 'Router dedup synthesis text.' } };
  const [a, b] = await Promise.all([
    audioFor('brief', content, '2026-07-22'),
    audioFor('brief', content, '2026-07-22'),
  ]);
  assert.equal(calls, 1, 'two concurrent taps for identical content must share one in-flight router call');
  assert.deepEqual(a, b);
});

// ── Required test 6: successful audio is cached, failures are not ───────

test('required test 6: a successful synthesis is written to the cache; a failed one writes nothing', async () => {
  const inserts = stubDb();
  process.env.OPENAI_API_KEY = 'sk-test-key-1234567890';
  let call = 0;
  openaiService.synthesize = async () => {
    call++;
    if (call === 1) throw new Error('OpenAI TTS failed: simulated outage');
    return { audio: Buffer.from('cache-me'), mime: 'audio/wav', model: 'gpt-4o-mini-tts' };
  };
  voiceService.synthesize = async () => { throw new Error('TTS failed: gemini also down'); };
  await assert.rejects(() => audioFor('brief', { chiefBrief: { synthesis: 'Cache-on-success text.' } }, '2026-07-23'));
  assert.equal(inserts.length, 0, 'a failed synthesis must never write a cache row');
  const result = await audioFor('brief', { chiefBrief: { synthesis: 'Cache-on-success text.' } }, '2026-07-23');
  assert.deepEqual(result, { audio: Buffer.from('cache-me'), mime: 'audio/wav' });
  assert.equal(inserts.length, 1, 'the subsequent successful synthesis must write exactly one cache row');
});

// ── Required test 7: no keys or transcript contents enter logs ──────────
// Deliberately does NOT stub openaiService.synthesize itself — that would
// bypass its own real key-redaction logic (redactKeyFragments) and prove
// nothing about whether that logic actually works. Mocks one level deeper,
// at axios.post, so the REAL ttsOpenai.js/voice.js error-handling paths run
// end to end, exactly as they would against a real provider response that
// happened to echo the key back (OpenAI's own 401 body does this).

test('required test 7: neither the OpenAI key, the Gemini key, nor the transcript text ever appear in logs — success and failure paths', async () => {
  process.env.OPENAI_API_KEY = 'sk-supersecretkeyfragment999';
  process.env.NORMOS_TTS_PROVIDER = 'auto';
  // No GEMINI_API_KEY in this test file's env at all — the fallback leg
  // fails immediately via voice.js's own assertKeyConfigured, which is
  // itself safe by construction (nothing to redact when there's no key).
  delete process.env.GEMINI_API_KEY;
  const secretTranscript = 'This transcript mentions a very private medical detail nobody else should see.';
  const axios = require('axios');
  const originalPost = axios.post;
  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));
  try {
    // Failure path: simulate OpenAI's OWN 401 body echoing the key back
    // (a real thing providers do) — proves redactKeyFragments actually
    // strips it before anything is logged, not just that our own code
    // avoided repeating it.
    axios.post = async () => {
      const body = JSON.stringify({ error: { message: 'Invalid API key provided: sk-supersecretkeyfragment999' } });
      const e = new Error('Request failed with status code 401');
      e.response = { status: 401, data: Buffer.from(body, 'utf8') };
      throw e;
    };
    await assert.rejects(() => ttsProvider.synthesizeWithFallback(secretTranscript));

    // Success path too — the script content itself must never be logged,
    // only its character count (see ttsOpenai.js's synthesize log line).
    axios.post = async () => ({ data: Buffer.from('fake-mp3-bytes') });
    await ttsProvider.synthesizeWithFallback(secretTranscript);
  } finally {
    axios.post = originalPost;
    console.log = originalLog;
    console.error = originalError;
  }
  const combined = logged.join('\n');
  assert.doesNotMatch(combined, /sk-supersecretkeyfragment999/, 'the OpenAI key must never be logged, even when a provider error body echoes it back');
  assert.doesNotMatch(combined, /AIzaSy/, 'no fragment resembling a Gemini key may be logged');
  assert.doesNotMatch(combined, /very private medical detail/, 'the transcript text itself must never be logged — only its character count');
});
