// Route-level contract tests for the audio family (GET /api/briefing/audio,
// GET /api/evening-brief/audio, GET /api/wisdom/audio) — the base64+mime
// response shape every mobile Listen button depends on. Stubs voice.js's
// synthesize() (no real Gemini calls) so these run without network access,
// same convention as brief-audio-dedup.test.js's unit-level stubbing, just
// exercised through the real Express app + real Postgres this time.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const voiceService = require('../../src/services/voice');
const briefingsStore = require('../../src/store/briefings');

const app = buildTestApp();
const ORIGINAL_SYNTHESIZE = voiceService.synthesize;
const tz = process.env.TZ || 'America/New_York';
const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });

function stubSynthesize() {
  let calls = 0;
  voiceService.synthesize = async (text) => {
    calls++;
    return { audio: Buffer.from(`wav-for:${text.slice(0, 20)}`), mime: 'audio/wav' };
  };
  return () => calls;
}

afterEach(async () => {
  voiceService.synthesize = ORIGINAL_SYNTHESIZE;
  await db.query(`DELETE FROM tts_audio`);
  await db.query(`DELETE FROM briefings WHERE content->>'__test_marker' = 'audio-routes-test'`);
});
after(async () => { await closeDb(); });

async function seedDaily(content = {}) {
  return briefingsStore.saveBriefing({
    kind: 'daily',
    content: {
      __test_marker: 'audio-routes-test',
      chiefBrief: { synthesis: 'Test synthesis for the day.', action: 'Test action.', risk: 'Test risk.' },
      quote: 'The obstacle is the way.',
      quoteInsight: 'Reframe the blocker as the actual work.',
      notionQuote: 'Discipline equals freedom.',
      notionInsight: 'Structure early in the day buys flexibility later.',
      relevantHighlight: {
        id: 'h1', title: 'Atomic Habits', author: 'James Clear',
        content: 'You do not rise to the level of your goals.',
        url: 'https://example.com', reason: 'Fits your current focus on routine.',
      },
      ...content,
    },
  });
}

async function seedEvening(content = {}) {
  return briefingsStore.saveBriefing({
    kind: 'evening',
    content: { __test_marker: 'audio-routes-test', readiness: 'Test readiness note.', today: 'Test today recap.', ...content },
  });
}

test('GET /api/briefing/audio returns the base64+mime contract for today\'s chief brief', async () => {
  stubSynthesize();
  await seedDaily();
  const res = await request(app).get('/api/briefing/audio').set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.audio, 'string');
  assert.equal(res.body.mime, 'audio/wav');
  assert.ok(Buffer.from(res.body.audio, 'base64').length > 0);
});

test('GET /api/evening-brief/audio returns the base64+mime contract for tonight\'s evening brief', async () => {
  stubSynthesize();
  await seedEvening();
  const res = await request(app).get('/api/evening-brief/audio').set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.audio, 'string');
  assert.equal(res.body.mime, 'audio/wav');
});

test('GET /api/wisdom/audio returns the SAME base64+mime contract, narrating today\'s Wisdom content', async () => {
  const getCalls = stubSynthesize();
  await seedDaily();
  const res = await request(app).get('/api/wisdom/audio').set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.audio, 'string');
  assert.equal(res.body.mime, 'audio/wav');
  assert.ok(Buffer.from(res.body.audio, 'base64').length > 0);
  assert.equal(getCalls(), 1);
});

test('GET /api/wisdom/audio and GET /api/briefing/audio narrate the SAME daily-briefing row but produce DIFFERENT audio (different scripts, different cache rows)', async () => {
  stubSynthesize();
  await seedDaily();
  const wisdomRes = await request(app).get('/api/wisdom/audio').set(authHeader());
  const briefRes = await request(app).get('/api/briefing/audio').set(authHeader());
  assert.equal(wisdomRes.status, 200);
  assert.equal(briefRes.status, 200);
  assert.notEqual(wisdomRes.body.audio, briefRes.body.audio, 'wisdom and chief-brief audio must never collide on the same cached bytes');
  const { rows } = await db.query(`SELECT cache_key FROM tts_audio WHERE cache_key LIKE $1 OR cache_key LIKE $2`, [`wisdom:${today}:%`, `brief:${today}:%`]);
  assert.equal(rows.length, 2, 'expected exactly one wisdom row and one brief row, no collision');
});

test('GET /api/wisdom/audio returns 404 nothing_to_narrate when today\'s brief has no Wisdom fields at all', async () => {
  stubSynthesize();
  await seedDaily({ quote: null, quoteInsight: null, notionQuote: null, notionInsight: null, relevantHighlight: null });
  const res = await request(app).get('/api/wisdom/audio').set(authHeader());
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'nothing_to_narrate');
});

test('GET /api/wisdom/audio returns 404 no_brief when there is no briefing at all yet', async () => {
  const res = await request(app).get('/api/wisdom/audio').set(authHeader());
  // Either no_brief (no row) or nothing_to_narrate (a stale unrelated row from
  // another test run with no Wisdom fields) is an acceptable "nothing to play
  // yet" outcome — never a 200 or a 5xx.
  assert.ok([404].includes(res.status));
  assert.ok(['no_brief', 'nothing_to_narrate'].includes(res.body.error));
});

test('GET /api/wisdom/audio never exposes the raw TTS provider error to the client', async () => {
  await seedDaily();
  voiceService.synthesize = async () => { throw new Error('Gemini said: invalid API key AIzaSyFAKESECRET1234'); };
  const res = await request(app).get('/api/wisdom/audio').set(authHeader());
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'tts_failed');
  assert.doesNotMatch(JSON.stringify(res.body), /AIzaSy|invalid API key/);
});

test('an authenticated request without a valid token is rejected before reaching any audio logic', async () => {
  const res = await request(app).get('/api/wisdom/audio').set({ Authorization: 'Bearer wrong-token' });
  assert.equal(res.status, 401);
});
