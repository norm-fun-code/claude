// Wisdom Listen timeout fix — backfillTodayAudio() (services/brief-audio.js),
// called once at server boot (server.js). Root cause this closes: the ONLY
// prewarm trigger used to be the build request itself (routes/briefing.js /
// notify/evening-brief.js) — a briefing already persisted before this
// backfill (or before Wisdom prewarming existed at all) would sit with a
// permanently cold cache until someone happened to hit the cold
// GET /api/wisdom/audio path directly and eat the full synthesis latency.
// Exercises the real Postgres tts_audio table + briefings table (same
// convention as audio-routes.test.js); stubs voice.js's synthesize() so this
// runs without network access.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const voiceService = require('../../src/services/voice');
const briefingsStore = require('../../src/store/briefings');
const briefAudio = require('../../src/services/brief-audio');

const ORIGINAL_SYNTHESIZE = voiceService.synthesize;
const tz = process.env.TZ || 'America/New_York';
const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });

function stubSynthesize() {
  let calls = 0;
  voiceService.synthesize = async (text) => {
    calls++;
    return { audio: Buffer.from(`wav-for:${text.slice(0, 20)}`), mime: 'audio/wav', model: 'stub-model' };
  };
  return () => calls;
}

afterEach(async () => {
  voiceService.synthesize = ORIGINAL_SYNTHESIZE;
  await db.query(`DELETE FROM tts_audio`);
  await db.query(`DELETE FROM briefings WHERE content->>'__test_marker' = 'backfill-test'`);
});
after(async () => { await closeDb(); });

async function seedDaily(content = {}) {
  return briefingsStore.saveBriefing({
    kind: 'daily',
    content: {
      __test_marker: 'backfill-test',
      chiefBrief: { synthesis: 'Test synthesis for backfill.', action: 'Test action.', risk: 'Test risk.' },
      quote: 'The obstacle is the way.',
      quoteInsight: 'Reframe the blocker as the actual work.',
      ...content,
    },
  });
}

async function seedEvening(content = {}) {
  return briefingsStore.saveBriefing({
    kind: 'evening',
    content: { __test_marker: 'backfill-test', day: today, readiness: 'Test readiness note.', today: 'Test today recap.', ...content },
  });
}

test('backfillTodayAudio(): a daily briefing persisted with NO prior prewarm gets both brief and wisdom audio warmed', async () => {
  const getCalls = stubSynthesize();
  await seedDaily();

  const { rows: before } = await db.query(`SELECT cache_key FROM tts_audio`);
  assert.equal(before.length, 0, 'sanity: nothing cached yet — this is the exact "prewarm never ran" scenario');

  await briefAudio.backfillTodayAudio();

  const { rows: after } = await db.query(`SELECT cache_key FROM tts_audio ORDER BY cache_key`);
  const kinds = after.map((r) => r.cache_key.split(':')[0]).sort();
  assert.deepEqual(kinds, ['brief', 'wisdom'], 'backfill must warm BOTH the chief-brief and Wisdom narration for today');
  assert.equal(getCalls(), 2, 'exactly one synthesis call per kind — no duplicate work');
});

test('backfillTodayAudio(): a subsequent Listen tap for Wisdom is now a pure cache hit — no TTS call at all', async () => {
  const getCalls = stubSynthesize();
  await seedDaily();
  await briefAudio.backfillTodayAudio();
  assert.equal(getCalls(), 2);

  const rows = await briefingsStore.listBriefings({ kind: 'daily', limit: 1 });
  const result = await briefAudio.audioFor('wisdom', rows[0].content, today);
  assert.ok(result?.audio);
  assert.equal(getCalls(), 2, 'the Listen tap after backfill must be served entirely from cache — synthesize() must not be called again');
});

test('backfillTodayAudio(): also warms an already-built EVENING brief for today, if one already exists', async () => {
  const getCalls = stubSynthesize();
  await seedDaily();
  await seedEvening();

  await briefAudio.backfillTodayAudio();

  const { rows } = await db.query(`SELECT cache_key FROM tts_audio ORDER BY cache_key`);
  const kinds = rows.map((r) => r.cache_key.split(':')[0]).sort();
  assert.deepEqual(kinds, ['brief', 'evening', 'wisdom']);
  assert.equal(getCalls(), 3);
});

test('backfillTodayAudio(): no daily briefing yet today — a safe no-op, never throws', async () => {
  await assert.doesNotReject(() => briefAudio.backfillTodayAudio());
  const { rows } = await db.query(`SELECT cache_key FROM tts_audio`);
  assert.equal(rows.length, 0);
});

test('backfillTodayAudio(): a YESTERDAY-only daily briefing is never backfilled as if it were today\'s', async () => {
  const { rows: inserted } = await db.query(
    `INSERT INTO briefings (kind, content, generated_at) VALUES ($1, $2, $3) RETURNING id`,
    ['daily', JSON.stringify({ __test_marker: 'backfill-test', chiefBrief: { synthesis: 'Yesterday.', action: 'a', risk: 'r' } }), new Date(Date.now() - 24 * 60 * 60 * 1000)]
  );
  assert.equal(inserted.length, 1);
  stubSynthesize();
  await briefAudio.backfillTodayAudio();
  const { rows } = await db.query(`SELECT cache_key FROM tts_audio`);
  assert.equal(rows.length, 0, 'a briefing from a prior day must never be backfilled as "today\'s" narration');
});

test('backfillTodayAudio(): a TTS failure during backfill is caught and never throws (best-effort, must not block boot)', async () => {
  voiceService.synthesize = async () => { throw new Error('simulated provider outage'); };
  await seedDaily();
  await assert.doesNotReject(() => briefAudio.backfillTodayAudio());
});
