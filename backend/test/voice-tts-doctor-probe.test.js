// probeTtsModelAvailability() (services/voice.js) — the read-only,
// secret-free model-availability check backing `npm run doctor`'s new
// VOICE (TTS) section. Exists because the live "Unavailable" bug took two
// separate rounds of manual Railway log reading to diagnose (an invalid
// hardcoded fallback model, then a misconfigured GEMINI_TTS_MODEL env
// override) — this makes both checkable at a glance without touching logs.
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.GEMINI_API_KEY = 'test-key';
const voice = require('../src/services/voice');

const ORIGINAL_GET = axios.get;
const ORIGINAL_ENV_MODEL = process.env.GEMINI_TTS_MODEL;
test.afterEach(() => {
  axios.get = ORIGINAL_GET;
  if (ORIGINAL_ENV_MODEL == null) delete process.env.GEMINI_TTS_MODEL;
  else process.env.GEMINI_TTS_MODEL = ORIGINAL_ENV_MODEL;
});

function listModelsResponse(names) {
  return { data: { models: names.map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) } };
}

test('probeTtsModelAvailability: no GEMINI_API_KEY — reports the gap without attempting a network call', async () => {
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  let called = false;
  axios.get = async () => { called = true; throw new Error('should not be called'); };
  try {
    const result = await voice.probeTtsModelAvailability();
    assert.equal(result.error, 'GEMINI_API_KEY not set');
    assert.equal(called, false);
  } finally {
    process.env.GEMINI_API_KEY = original;
  }
});

test('probeTtsModelAvailability: reports which candidates are LISTED (ListModels-visible) for this key — not a confirmed-working claim — never logs the key', async () => {
  delete process.env.GEMINI_TTS_MODEL;
  axios.get = async (url) => {
    assert.doesNotMatch(url, /key=$/, 'sanity: a key value was actually substituted into the URL');
    // ListModels returns flash-preview-tts (a candidate) but NOT pro-preview-tts.
    return listModelsResponse(['gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-tts-preview']);
  };
  const result = await voice.probeTtsModelAvailability();
  assert.equal(result.configured, null);
  // Only the intersection of the candidate list and what ListModels returned.
  // gemini-2.5-flash-preview-tts is a candidate AND listed; gemini-2.5-pro-preview-tts
  // is a candidate but NOT listed; gemini-3.1-flash-tts-preview is listed but
  // is NOT a default candidate (it hangs on generateContent), so it never
  // appears here.
  assert.deepEqual(result.listed.sort(), ['gemini-2.5-flash-preview-tts']);
  assert.ok(result.notListed.includes('gemini-2.5-pro-preview-tts'));
  assert.equal(result.error, null);
  // Live bug this field naming exists to prevent recurring: a model being
  // LISTED here is not proof an actual TTS call will succeed —
  // gemini-2.5-flash-preview-tts was listed yet still 400'd in one production
  // report, because the bug was elsewhere, not model existence.
  assert.equal(result.available, undefined, 'must not use the old "available" field name, which implied a confirmed-working guarantee ListModels never made');
});

test('probeTtsModelAvailability: an invalid GEMINI_TTS_MODEL override is flagged as configuredLooksValid=false', async () => {
  process.env.GEMINI_TTS_MODEL = 'gemini-3.5-flash'; // the exact live production misconfiguration
  axios.get = async () => listModelsResponse(['gemini-3.1-flash-tts-preview']);
  const result = await voice.probeTtsModelAvailability();
  assert.equal(result.configured, 'gemini-3.5-flash');
  assert.equal(result.configuredLooksValid, false);
});

test('probeTtsModelAvailability: a valid GEMINI_TTS_MODEL override is flagged as configuredLooksValid=true', async () => {
  process.env.GEMINI_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
  axios.get = async () => listModelsResponse(['gemini-3.1-flash-tts-preview']);
  const result = await voice.probeTtsModelAvailability();
  assert.equal(result.configuredLooksValid, true);
});

test('probeTtsModelAvailability: a ListModels network/auth failure degrades to a sanitized error string, never throws', async () => {
  delete process.env.GEMINI_TTS_MODEL;
  axios.get = async () => {
    const e = new Error('Request failed with status code 400');
    e.response = { status: 400, data: { error: { message: 'API key not valid. Please pass a valid API key.' } } };
    throw e;
  };
  const result = await voice.probeTtsModelAvailability();
  assert.equal(result.listed, null);
  assert.match(result.error, /API key not valid/);
  assert.doesNotMatch(JSON.stringify(result), /key=test-key/, 'the raw request URL (which carries the key) must never leak into the result');
});

// ── checkTtsModelOverride: the synchronous, no-network heuristic that fires
// on every synthesize() call when GEMINI_TTS_MODEL is set — this is what
// actually caught the live 'gemini-3.5-flash' misconfiguration in logs. ──

test('checkTtsModelOverride: warns when the override does not look TTS-shaped (no "tts" in the name)', () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    voice.checkTtsModelOverride('gemini-3.5-flash');
  } finally {
    console.error = originalError;
  }
  assert.ok(logged.some((l) => l.includes('does not look like a TTS-capable model id')));
});

test('checkTtsModelOverride: stays silent for a genuinely TTS-shaped override', () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    voice.checkTtsModelOverride('gemini-3.1-flash-tts-preview');
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 0);
});

// ── ttsModels(): an invalid override is still tried (operator's explicit
// choice isn't silently discarded) but safely falls through to the real
// candidates — this is the actual runtime "fall back safely" behavior. ──

test('ttsModels(): an invalid override is placed first (tried, not silently dropped) but the real candidates still follow', () => {
  process.env.GEMINI_TTS_MODEL = 'gemini-3.5-flash';
  try {
    const models = voice.ttsModels();
    assert.equal(models[0], 'gemini-3.5-flash', "the operator's explicit override is still tried first");
    assert.deepEqual(models.slice(1), voice.TTS_CANDIDATES, 'every real candidate must still follow, in order, as the safe fallback');
  } finally {
    delete process.env.GEMINI_TTS_MODEL;
  }
});
