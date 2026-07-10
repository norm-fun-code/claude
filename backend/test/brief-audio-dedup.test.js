// Live bug found via a product review: tapping "Listen" right after a
// briefing rebuild sometimes flashed "Unavailable" then played fine on a
// second tap. Part of the root cause: audioFor() had no in-flight dedup, so
// the post-rebuild prewarm() call and a user's own concurrent "Listen" tap
// could both miss the not-yet-written tts_audio cache row and each
// independently fire a synthesize() call to Gemini for the identical
// script — doubling TTS load exactly when the system is already busiest,
// and doubling the odds either one times out. These tests stub the voice
// service and db layer and verify: concurrent calls for the same content
// share one synthesize() call, a cache hit skips synthesize() entirely, and
// a failed synthesize() doesn't wedge later callers.
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const voiceService = require('../src/services/voice');
const { audioFor } = require('../src/services/brief-audio');

const ORIGINAL_QUERY = db.query;
const ORIGINAL_SYNTH = voiceService.synthesize;
test.afterEach(() => {
  db.query = ORIGINAL_QUERY;
  voiceService.synthesize = ORIGINAL_SYNTH;
});

function stubDb({ cacheHit = null } = {}) {
  const inserts = [];
  db.query = async (sql, params) => {
    if (/SELECT audio, mime FROM tts_audio/.test(sql)) return { rows: cacheHit ? [cacheHit] : [] };
    if (/INSERT INTO tts_audio/.test(sql)) { inserts.push(params); return { rows: [] }; }
    if (/DELETE FROM tts_audio/.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  };
  return inserts;
}

test('two concurrent audioFor() calls for the same script share one in-flight synthesize() call', async () => {
  stubDb();
  let calls = 0;
  voiceService.synthesize = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 15));
    return { audio: Buffer.from('wav-bytes'), mime: 'audio/wav' };
  };
  const content = { chiefBrief: { synthesis: 'Test synthesis.', action: 'Test action.', risk: 'Test risk.', move: 'Test move.' } };
  const [a, b] = await Promise.all([
    audioFor('brief', content, '2026-07-10'),
    audioFor('brief', content, '2026-07-10'),
  ]);
  assert.equal(calls, 1, 'the second concurrent call must reuse the first\'s in-flight promise, not start a new TTS request');
  assert.deepEqual(a, b);
});

test('a cache hit never calls synthesize()', async () => {
  stubDb({ cacheHit: { audio: Buffer.from('cached'), mime: 'audio/wav' } });
  let calls = 0;
  voiceService.synthesize = async () => { calls++; return { audio: Buffer.from('x'), mime: 'audio/wav' }; };
  const content = { chiefBrief: { synthesis: 'Test synthesis.', action: 'Test action.', risk: 'Test risk.', move: 'Test move.' } };
  const result = await audioFor('brief', content, '2026-07-10');
  assert.equal(calls, 0, 'a warm cache row must be served without touching Gemini at all');
  assert.deepEqual(result, { audio: Buffer.from('cached'), mime: 'audio/wav' });
});

test('a failed synthesize() does not poison later calls for the same script', async () => {
  stubDb();
  let calls = 0;
  voiceService.synthesize = async () => {
    calls++;
    if (calls === 1) throw new Error('TTS failed: timeout of 45000ms exceeded');
    return { audio: Buffer.from('wav-bytes'), mime: 'audio/wav' };
  };
  const content = { chiefBrief: { synthesis: 'Test synthesis.', action: 'Test action.', risk: 'Test risk.', move: 'Test move.' } };
  await assert.rejects(() => audioFor('brief', content, '2026-07-10'));
  const result = await audioFor('brief', content, '2026-07-10');
  assert.equal(calls, 2, 'the retry after a failure must reach synthesize() again, not hang on a stale in-flight entry');
  assert.deepEqual(result, { audio: Buffer.from('wav-bytes'), mime: 'audio/wav' });
});
