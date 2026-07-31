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
    // day defaults to TODAY — matches real production content (see
    // notify/evening-brief.js, which always stamps content.day) and is
    // required by the audit-fix day check in routes/audio.js's evening
    // route. Explicit override lets the "prior night" tests below simulate
    // the real gap: a row whose OWN content.day genuinely isn't today.
    content: { __test_marker: 'audio-routes-test', day: today, readiness: 'Test readiness note.', today: 'Test today recap.', ...content },
  });
}

/** Insert a daily/evening briefing row with an explicit `generated_at` —
 *  saveBriefing() always defaults to now(), so a genuinely YESTERDAY-dated
 *  row (for the "no previous-day fallback" tests below) needs a raw insert. */
async function seedBackdated({ kind, content, generatedAt }) {
  const { rows } = await db.query(
    `INSERT INTO briefings (kind, content, generated_at) VALUES ($1, $2, $3) RETURNING id, generated_at`,
    [kind, JSON.stringify(content), generatedAt]
  );
  return rows[0];
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

test('GET /api/briefing/audio narrationStatus=1 returns Preparing immediately on a cold cache, then Ready from that same shared job', async () => {
  let releaseSynthesis;
  voiceService.synthesize = async () => {
    await new Promise((resolve) => { releaseSynthesis = resolve; });
    return { audio: Buffer.from('status-ready-audio'), mime: 'audio/wav' };
  };
  await seedDaily({ chiefBrief: { synthesis: 'Async status route marker.', action: 'a', risk: 'r' } });

  const first = await request(app).get('/api/briefing/audio').query({ narrationStatus: '1' }).set(authHeader());
  assert.equal(first.status, 202);
  assert.equal(first.body.status, 'preparing');
  assert.equal(typeof first.body.retryAfterMs, 'number');

  // Polling before completion stays truthful and must not create a second TTS
  // job for this cache key.
  const second = await request(app).get('/api/briefing/audio').query({ narrationStatus: '1' }).set(authHeader());
  assert.equal(second.status, 202);
  for (let i = 0; i < 20 && !releaseSynthesis; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(typeof releaseSynthesis, 'function', 'the first status request must have queued the shared TTS job');
  releaseSynthesis();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const ready = await request(app).get('/api/briefing/audio').query({ narrationStatus: '1' }).set(authHeader());
  assert.equal(ready.status, 200);
  assert.equal(Buffer.from(ready.body.audio, 'base64').toString('utf8'), 'status-ready-audio');
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

// ── Audit fix, item 4: never narrate the wrong day ────────────────────────

test('GET /api/briefing/audio returns a clean 404 (never falls back to yesterday) when only a YESTERDAY brief exists', async () => {
  stubSynthesize();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await seedBackdated({
    kind: 'daily',
    content: { __test_marker: 'audio-routes-test', chiefBrief: { synthesis: "YESTERDAY's synthesis — must never be narrated as today's.", action: 'a', risk: 'r' } },
    generatedAt: yesterday,
  });
  const res = await request(app).get('/api/briefing/audio').set(authHeader());
  assert.equal(res.status, 404, 'an endpoint labeled "today\'s brief" must never silently narrate the most recent OLDER brief instead');
  assert.equal(res.body.error, 'no_brief');
});

test('GET /api/wisdom/audio returns a clean 404 (never falls back to yesterday) when only a YESTERDAY brief exists', async () => {
  stubSynthesize();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await seedBackdated({
    kind: 'daily',
    content: {
      __test_marker: 'audio-routes-test', quote: "Yesterday's quote.", quoteInsight: 'Yesterday insight.',
    },
    generatedAt: yesterday,
  });
  const res = await request(app).get('/api/wisdom/audio').set(authHeader());
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'no_brief');
});

test('GET /api/evening-brief/audio returns a clean 404 (never falls back to a prior night) when today\'s evening brief has not built yet', async () => {
  stubSynthesize();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayLocal = yesterday.toLocaleDateString('en-CA', { timeZone: tz });
  await seedBackdated({
    kind: 'evening',
    content: { __test_marker: 'audio-routes-test', day: yesterdayLocal, readiness: "Last night's readiness — must never be narrated as tonight's." },
    generatedAt: yesterday,
  });
  const res = await request(app).get('/api/evening-brief/audio').set(authHeader());
  assert.equal(res.status, 404, 'the most recent evening row being from a PRIOR day must never be narrated as "tonight\'s" brief');
  assert.equal(res.body.error, 'no_brief');
});

test('GET /api/briefing/audio with an unknown snapshotId returns a distinct snapshot_not_found 404 rather than silently substituting a different build', async () => {
  stubSynthesize();
  await seedDaily({ snapshotId: 'real-snapshot-abc' });
  const res = await request(app).get('/api/briefing/audio').query({ snapshotId: 'stale-cached-snapshot-xyz' }).set(authHeader());
  assert.equal(res.status, 404);
  // Distinct from the no-snapshotId 'no_brief' case (see the audit fix
  // below) — an EXPLICIT snapshotId that can't be found is a different,
  // more specific failure than "no briefing for today at all", and the
  // mobile client (useBriefAudio.ts) tells them apart.
  assert.equal(res.body.error, 'snapshot_not_found');
});

test('GET /api/briefing/audio with a matching snapshotId narrates the EXACT build requested, even when a newer one exists', async () => {
  // A dedicated inline stub (not the shared stubSynthesize helper) that
  // echoes back the FULL narration text, so the assertion below can
  // distinguish which build was actually narrated — composeNarrationScript
  // shares a fixed opening ("Morning. Here's where you stand. ...") across
  // every build, so comparing just the first ~20 chars (stubSynthesize's
  // default) can't tell two builds apart.
  voiceService.synthesize = async (text) => ({ audio: Buffer.from(text), mime: 'audio/wav' });
  await seedDaily({ snapshotId: 'snap-1', chiefBrief: { synthesis: 'First build synthesis marker.', action: 'a', risk: 'r' } });
  await seedDaily({ snapshotId: 'snap-2', chiefBrief: { synthesis: 'Second newer build synthesis marker.', action: 'a', risk: 'r' } });
  const res = await request(app).get('/api/briefing/audio').query({ snapshotId: 'snap-1' }).set(authHeader());
  assert.equal(res.status, 200);
  const decoded = Buffer.from(res.body.audio, 'base64').toString('utf8');
  assert.match(decoded, /First build synthesis marker/, 'must narrate the EXACT build the snapshotId requested');
  assert.doesNotMatch(decoded, /Second newer build synthesis marker/, 'must NOT silently substitute a newer build');
});

test('GET /api/briefing/audio with NO snapshotId still works (older mobile client compatibility) — takes today\'s build', async () => {
  stubSynthesize();
  await seedDaily();
  const res = await request(app).get('/api/briefing/audio').set(authHeader());
  assert.equal(res.status, 200);
});

// ── Fix: an explicit snapshotId is served EXACTLY, even from a prior day ──
// (backend/src/routes/audio.js — the bug: todaysDailyBriefing() used to
// filter to TODAY's rows BEFORE ever checking snapshotId, so a stale mobile
// screen still showing yesterday's cached briefing after midnight got a
// clean 404 before TTS was ever attempted.)

test('GET /api/briefing/audio with YESTERDAY\'s snapshotId narrates yesterday\'s EXACT content, cached under yesterday\'s day', async () => {
  voiceService.synthesize = async (text) => ({ audio: Buffer.from(text), mime: 'audio/wav' });
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayLocal = yesterday.toLocaleDateString('en-CA', { timeZone: tz });
  await seedBackdated({
    kind: 'daily',
    content: {
      __test_marker: 'audio-routes-test', snapshotId: 'stale-yesterday-snap', localDate: yesterdayLocal,
      chiefBrief: { synthesis: 'YESTERDAY exact synthesis marker.', action: 'a', risk: 'r' },
    },
    generatedAt: yesterday,
  });
  const res = await request(app).get('/api/briefing/audio').query({ snapshotId: 'stale-yesterday-snap' }).set(authHeader());
  assert.equal(res.status, 200, 'a stale-but-real snapshotId must be served, not 404d, even from a prior day');
  const decoded = Buffer.from(res.body.audio, 'base64').toString('utf8');
  assert.match(decoded, /YESTERDAY exact synthesis marker/, 'must narrate yesterday\'s OWN exact content');
  // The audio cache key is derived from the CONTENT's own day (localDate),
  // never from "now" — so this lands under yesterday's bucket, not today's.
  const { rows } = await db.query(`SELECT cache_key FROM tts_audio WHERE cache_key LIKE $1`, [`brief:${yesterdayLocal}:%`]);
  assert.equal(rows.length, 1, 'narrating a stale snapshot must cache under the CONTENT\'s own day, not today\'s');
});

test('GET /api/wisdom/audio with YESTERDAY\'s snapshotId narrates yesterday\'s EXACT Wisdom content, cached under yesterday\'s day', async () => {
  voiceService.synthesize = async (text) => ({ audio: Buffer.from(text), mime: 'audio/wav' });
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayLocal = yesterday.toLocaleDateString('en-CA', { timeZone: tz });
  await seedBackdated({
    kind: 'daily',
    content: {
      __test_marker: 'audio-routes-test', snapshotId: 'stale-yesterday-wisdom-snap', localDate: yesterdayLocal,
      quote: 'YESTERDAY exact quote marker.', quoteInsight: 'Yesterday insight.',
    },
    generatedAt: yesterday,
  });
  const res = await request(app).get('/api/wisdom/audio').query({ snapshotId: 'stale-yesterday-wisdom-snap' }).set(authHeader());
  assert.equal(res.status, 200);
  const decoded = Buffer.from(res.body.audio, 'base64').toString('utf8');
  assert.match(decoded, /YESTERDAY exact quote marker/);
  const { rows } = await db.query(`SELECT cache_key FROM tts_audio WHERE cache_key LIKE $1`, [`wisdom:${yesterdayLocal}:%`]);
  assert.equal(rows.length, 1);
});

test('GET /api/wisdom/audio with an unknown snapshotId returns a distinct snapshot_not_found 404', async () => {
  stubSynthesize();
  await seedDaily({ snapshotId: 'real-wisdom-snapshot' });
  const res = await request(app).get('/api/wisdom/audio').query({ snapshotId: 'garbage-id-nobody-has' }).set(authHeader());
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'snapshot_not_found');
});

test('cache keys never collide across days or snapshots: today\'s real brief and a stale-snapshot replay of a DIFFERENT day cache under distinct keys', async () => {
  voiceService.synthesize = async (text) => ({ audio: Buffer.from(text), mime: 'audio/wav' });
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayLocal = yesterday.toLocaleDateString('en-CA', { timeZone: tz });
  await seedDaily({ snapshotId: 'today-real-snap', chiefBrief: { synthesis: 'TODAY exact synthesis marker.', action: 'a', risk: 'r' } });
  await seedBackdated({
    kind: 'daily',
    content: {
      __test_marker: 'audio-routes-test', snapshotId: 'yesterday-real-snap', localDate: yesterdayLocal,
      chiefBrief: { synthesis: 'TODAY exact synthesis marker.', action: 'a', risk: 'r' }, // deliberately IDENTICAL content
    },
    generatedAt: yesterday,
  });
  const todayRes = await request(app).get('/api/briefing/audio').query({ snapshotId: 'today-real-snap' }).set(authHeader());
  const yesterdayRes = await request(app).get('/api/briefing/audio').query({ snapshotId: 'yesterday-real-snap' }).set(authHeader());
  assert.equal(todayRes.status, 200);
  assert.equal(yesterdayRes.status, 200);
  // Same script/hash (identical chiefBrief content) but DIFFERENT day buckets
  // — two distinct cache rows, never one shared/colliding row.
  const { rows } = await db.query(
    `SELECT cache_key FROM tts_audio WHERE cache_key LIKE $1 OR cache_key LIKE $2`,
    [`brief:${today}:%`, `brief:${yesterdayLocal}:%`]
  );
  assert.equal(rows.length, 2, 'identical content from two different days must still produce two distinct cache rows, one per day');
});
