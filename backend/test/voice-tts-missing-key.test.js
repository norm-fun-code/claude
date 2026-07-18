// Wisdom Listen timeout fix requirement: "Fail immediately and clearly in
// logs if the TTS key/configuration is absent; never print secrets." Own
// file (not voice-tts-retry.test.js) because GEMINI_API_KEY must be UNSET
// before requiring voice.js and for the duration of these tests — every
// other voice test sets it at module load time, so sharing a file would
// race whichever runs first.
const test = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_KEY = process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;
const voice = require('../src/services/voice');

test.after(() => {
  if (ORIGINAL_KEY != null) process.env.GEMINI_API_KEY = ORIGINAL_KEY;
});

test('synthesize() fails immediately (no network attempt, no per-model retry loop) when GEMINI_API_KEY is absent', async () => {
  await assert.rejects(() => voice.synthesize('hello world'), /GEMINI_API_KEY not set/);
});

test('synthesize() logs a clear, secret-free error when GEMINI_API_KEY is absent', async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    await assert.rejects(() => voice.synthesize('hello world'));
  } finally {
    console.error = originalError;
  }
  const combined = logged.join('\n');
  assert.match(combined, /GEMINI_API_KEY is not set/i);
  assert.doesNotMatch(combined, /AIza/, 'must never print anything resembling an actual API key');
});

test('transcribe() also fails immediately with a clear log when GEMINI_API_KEY is absent', async () => {
  await assert.rejects(() => voice.transcribe(Buffer.from('fake').toString('base64')), /GEMINI_API_KEY not set/);
});
