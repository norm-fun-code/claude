// Live production bug: adding Wisdom prewarming (right after Chief's, in
// routes/briefing.js) meant two narration kinds could independently miss the
// tts_audio cache and each call voiceService.synthesize() at the same
// moment — per-cache-key inFlight dedup (brief-audio-dedup.test.js) only
// covers the SAME key firing twice, not two DIFFERENT keys (brief vs.
// wisdom) firing concurrently. Railway logs confirmed it: simultaneous
// cache MISS for both kinds, two concurrent Interactions calls to the same
// TTS model, each timing out at ~25s. Fix: automatic Wisdom prewarming and
// boot-time backfill are removed entirely (see server.js / routes/briefing.js
// — Wisdom now only ever synthesizes on an explicit Listen tap), AND
// brief-audio.js gained a process-wide serialization gate so even
// DIFFERENT cache keys can never call synthesize() concurrently. These
// tests exercise that gate directly (stubbed db/voice service, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const voiceService = require('../src/services/voice');
const { audioFor, prewarm } = require('../src/services/brief-audio');

const ORIGINAL_QUERY = db.query;
const ORIGINAL_SYNTH = voiceService.synthesize;
test.afterEach(() => {
  db.query = ORIGINAL_QUERY;
  voiceService.synthesize = ORIGINAL_SYNTH;
});

function stubDb() {
  db.query = async (sql) => {
    if (/SELECT audio, mime FROM tts_audio/.test(sql)) return { rows: [] };
    if (/INSERT INTO tts_audio/.test(sql)) return { rows: [] };
    if (/DELETE FROM tts_audio/.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  };
}

test('concurrent brief and wisdom audioFor() calls never call synthesize() concurrently — max active count is exactly 1', async () => {
  stubDb();
  let active = 0;
  let maxActive = 0;
  voiceService.synthesize = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return { audio: Buffer.from('wav'), mime: 'audio/wav' };
  };
  const briefContent = { chiefBrief: { synthesis: 'Gate max-active brief synthesis.' } };
  const wisdomContent = { quote: 'Gate max-active quote.', quoteInsight: 'Gate max-active insight.' };
  await Promise.all([
    audioFor('brief', briefContent, '2026-07-18'),
    audioFor('wisdom', wisdomContent, '2026-07-18'),
  ]);
  assert.equal(maxActive, 1, 'at most one voiceService.synthesize() call may be in flight at any instant, across every narration kind');
});

test('a Chief prewarm() and a concurrent foreground audioFor() Listen tap for the SAME content share one synthesis, not two gated jobs', async () => {
  stubDb();
  let calls = 0;
  voiceService.synthesize = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 15));
    return { audio: Buffer.from('brief-wav'), mime: 'audio/wav' };
  };
  const content = { chiefBrief: { synthesis: 'Shared prewarm-plus-tap synthesis text.' } };
  const [, tapResult] = await Promise.all([
    prewarm('brief', content, '2026-07-18'),
    audioFor('brief', content, '2026-07-18'),
  ]);
  assert.equal(calls, 1, 'prewarm (source=prewarm) and a real Listen tap (source=foreground) for identical content must join the SAME in-flight job, not each separately acquire the gate');
  assert.deepEqual(tapResult, { audio: Buffer.from('brief-wav'), mime: 'audio/wav' });
});

test('a queued Wisdom request begins only after a concurrent Chief job releases the gate, and still returns correct audio', async () => {
  stubDb();
  const order = [];
  voiceService.synthesize = async (script) => {
    const kind = script.includes('Gate ordering brief') ? 'brief' : 'wisdom';
    order.push({ kind, at: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    return { audio: Buffer.from(`${kind}-wav`), mime: 'audio/wav' };
  };
  const briefContent = { chiefBrief: { synthesis: 'Gate ordering brief synthesis.' } };
  const wisdomContent = { quote: 'Gate ordering quote.', quoteInsight: 'Gate ordering insight.' };
  const [briefResult, wisdomResult] = await Promise.all([
    audioFor('brief', briefContent, '2026-07-18'),
    audioFor('wisdom', wisdomContent, '2026-07-18'),
  ]);
  assert.equal(order.length, 2, 'both jobs must eventually run');
  assert.ok(
    order[1].at - order[0].at >= 18,
    `expected the second job to start only after the first released the gate (~20ms apart), got a ${order[1].at - order[0].at}ms gap`
  );
  assert.deepEqual(briefResult, { audio: Buffer.from('brief-wav'), mime: 'audio/wav' });
  assert.deepEqual(wisdomResult, { audio: Buffer.from('wisdom-wav'), mime: 'audio/wav' });
});

test('the gate releases after a FAILED synthesis — a different key queued behind/alongside it is never wedged', async () => {
  stubDb();
  let calls = 0;
  voiceService.synthesize = async (script) => {
    calls++;
    if (script.includes('Failing brief')) throw new Error('simulated provider outage');
    await new Promise((r) => setTimeout(r, 10));
    return { audio: Buffer.from('wisdom-wav'), mime: 'audio/wav' };
  };
  const failingBrief = { chiefBrief: { synthesis: 'Failing brief synthesis.' } };
  const wisdomContent = { quote: 'Unwedged quote.', quoteInsight: 'Unwedged insight.' };
  const briefPromise = audioFor('brief', failingBrief, '2026-07-19');
  const wisdomPromise = audioFor('wisdom', wisdomContent, '2026-07-19');
  await assert.rejects(() => briefPromise, /simulated provider outage/);
  const wisdomResult = await wisdomPromise;
  assert.deepEqual(wisdomResult, { audio: Buffer.from('wisdom-wav'), mime: 'audio/wav' }, 'the failure must not have wedged the gate — the other queued/concurrent job still completes');
  assert.equal(calls, 2);
});

test('the gate releases after a synthesis that throws a timeout-shaped error — the next different-key request is not wedged', async () => {
  stubDb();
  let calls = 0;
  voiceService.synthesize = async (script) => {
    calls++;
    if (script.includes('Timing out brief')) {
      const e = new Error('TTS failed: timeout of 25000ms exceeded');
      throw e;
    }
    return { audio: Buffer.from('evening-wav'), mime: 'audio/wav' };
  };
  const timingOutBrief = { chiefBrief: { synthesis: 'Timing out brief synthesis.' } };
  const eveningContent = { readiness: 'Unwedged evening readiness.' };
  await assert.rejects(() => audioFor('brief', timingOutBrief, '2026-07-20'));
  const eveningResult = await audioFor('evening', eveningContent, '2026-07-20');
  assert.deepEqual(eveningResult, { audio: Buffer.from('evening-wav'), mime: 'audio/wav' });
  assert.equal(calls, 2, 'a timeout-shaped failure must release the gate just like any other failure — the next job still reaches synthesize()');
});
