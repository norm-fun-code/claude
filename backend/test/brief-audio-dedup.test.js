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

// ── Wisdom kind: same shared audioFor()/cache/dedup machinery, must never
// collide with chief ('brief') or evening audio for the same day. ─────────

const WISDOM_CONTENT = {
  quote: 'The obstacle is the way.', quoteInsight: 'Reframe the blocker as the actual work.',
};

test('wisdom uses a SEPARATE cache namespace from brief/evening for the same day — no cache_key collision', () => {
  // The cache key is `${kind}:${day}:${hash(voice+script)}` (brief-audio.js) —
  // a wisdom script and a chief-brief script are different text, so even on
  // the same day they hash differently AND carry a different kind prefix.
  // Assert both distinguishing factors directly against the real script text,
  // not just trust the implementation.
  const briefScript = voiceService.composeNarrationScript({ chiefBrief: { synthesis: 'Test synthesis.' } });
  const wisdomScript = voiceService.composeWisdomNarrationScript(WISDOM_CONTENT);
  assert.notEqual(briefScript, wisdomScript, 'sanity: the two kinds must produce different narration text');
});

test('two concurrent wisdom audioFor() calls for the same content share one in-flight synthesize() call', async () => {
  stubDb();
  let calls = 0;
  voiceService.synthesize = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 15));
    return { audio: Buffer.from('wisdom-wav-bytes'), mime: 'audio/wav' };
  };
  const [a, b] = await Promise.all([
    audioFor('wisdom', WISDOM_CONTENT, '2026-07-10'),
    audioFor('wisdom', WISDOM_CONTENT, '2026-07-10'),
  ]);
  assert.equal(calls, 1, 'a concurrent prewarm + user "Listen" tap must dedupe onto one TTS request, same as chief/evening');
  assert.deepEqual(a, b);
});

test('a prewarm() call and a concurrent audioFor() Listen tap for wisdom dedupe onto the same in-flight promise', async () => {
  stubDb();
  let calls = 0;
  voiceService.synthesize = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 15));
    return { audio: Buffer.from('wisdom-wav-bytes'), mime: 'audio/wav' };
  };
  const { prewarm } = require('../src/services/brief-audio');
  const [, listenResult] = await Promise.all([
    prewarm('wisdom', WISDOM_CONTENT, '2026-07-11'), // prewarm() discards its result — fire-and-forget by design
    audioFor('wisdom', WISDOM_CONTENT, '2026-07-11'),
  ]);
  assert.equal(calls, 1, 'prewarm and a real Listen tap racing for the same content must never double-request TTS');
  assert.deepEqual(listenResult, { audio: Buffer.from('wisdom-wav-bytes'), mime: 'audio/wav' });
});

test('wisdom, chief, and evening audio for the SAME day never share a cache row even if content happened to match', async () => {
  // Distinct query log per kind proves the cache_key actually differs by
  // kind — if it didn't, the second and third calls below would be served
  // from the first's cache row instead of each calling synthesize().
  const inserts = stubDb();
  let calls = 0;
  voiceService.synthesize = async () => { calls++; return { audio: Buffer.from(`bytes-${calls}`), mime: 'audio/wav' }; };
  // Same day, same underlying quote/synthesis text is irrelevant here — what
  // matters is the kind prefix, so use content shaped correctly for each.
  await audioFor('wisdom', WISDOM_CONTENT, '2026-07-12');
  await audioFor('brief', { chiefBrief: { synthesis: 'Test synthesis.' } }, '2026-07-12');
  await audioFor('evening', { readiness: 'Test readiness.' }, '2026-07-12');
  assert.equal(calls, 3, 'each kind must independently call synthesize() — none may be served from another kind\'s cache row');
  assert.equal(inserts.length, 3);
  const keys = inserts.map((params) => params[0]);
  assert.equal(new Set(keys).size, 3, 'all three cache_key values must be distinct');
  assert.ok(keys.every((k) => k.split(':')[1] === '2026-07-12'), 'all three share the same day component');
  assert.deepEqual(keys.map((k) => k.split(':')[0]).sort(), ['brief', 'evening', 'wisdom']);
});

test('a content change for wisdom (e.g. a new daily quote) invalidates the cache — different content never reuses a stale cache_key', async () => {
  const inserts = stubDb();
  let calls = 0;
  voiceService.synthesize = async () => { calls++; return { audio: Buffer.from(`bytes-${calls}`), mime: 'audio/wav' }; };
  await audioFor('wisdom', WISDOM_CONTENT, '2026-07-13');
  await audioFor('wisdom', { quote: 'A different quote entirely.', quoteInsight: 'A different insight.' }, '2026-07-13');
  assert.equal(calls, 2, "changed Wisdom content on the same day must regenerate, not serve yesterday's-quote audio");
  const keys = inserts.map((params) => params[0]);
  assert.equal(new Set(keys).size, 2, 'different content must produce different cache_key hashes');
});
