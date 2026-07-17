// Audio router: spoken narration of today's morning brief, tonight's evening
// wind-down brief, and the Wisdom tab's daily reflection — all cached per
// content hash. Nineteenth router extraction out of server.js's monolith
// (see the engineering review's #1+#6 recommendation) — a straight move,
// verified line-by-line against the original before removing it from
// server.js.
const express = require('express');
const briefingsStore = require('../store/briefings');
const briefAudio = require('../services/brief-audio');
const { asyncHandler } = require('../middleware/asyncHandler');

/**
 * Today's canonical daily-briefing row — the SAME "kind: 'daily'" content
 * the morning brief AND the Wisdom tab (quote/notionQuote/relevantHighlight
 * all live flat on this one persisted object, see routes/briefing.js) both
 * read. Shared so the morning-brief and Wisdom audio routes can never drift
 * on which build counts as "today's".
 *
 * Audit fix, item 4: this used to fall back to the single most recent daily
 * briefing (`rows[0]`) whenever NO row matched today's local date — an
 * endpoint literally named "today's brief" would then narrate YESTERDAY's
 * (or older) content with no indication anything was off. There is no
 * fallback now: no match today means no target, and both callers below
 * correctly turn that into a clean `no_brief` 404 — never a wrong-day
 * narration, and never silently "the freshest thing we have instead."
 *
 * `snapshotId`, when provided, binds to the EXACT build the mobile client
 * is currently displaying (BriefingData.snapshotId — already returned to
 * mobile today, see routes/briefing.js's `response.snapshotId` and
 * useBriefing.ts's BriefingData type) rather than "whichever build happens
 * to be most recent right now" — closing the gap where a mobile client
 * showing a slightly-stale cached build (a newer rebuild landed after it
 * fetched) could otherwise hear narration for content different from what's
 * on screen. A snapshotId that doesn't match ANY of today's rows (stale
 * mobile cache pointing at a build that's no longer "today's", or has been
 * superseded) is treated as no target — never silently substituted with a
 * different build than the one the caller explicitly asked for.
 */
async function todaysDailyBriefing(tz, day, snapshotId) {
  const rows = await briefingsStore.listBriefings({ kind: 'daily', limit: 10 });
  const todays = rows.filter((r) => new Date(r.generated_at).toLocaleDateString('en-CA', { timeZone: tz }) === day);
  if (snapshotId) return todays.find((r) => r.content?.snapshotId === snapshotId) || null;
  return todays[0] || null;
}

function createAudioRouter() {
  const router = express.Router();

  // Spoken narration of today's chief-of-staff brief — cached per content hash,
  // so a rebuild re-narrates and an unchanged brief streams instantly.
  router.get('/briefing/audio', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    // Optional: bind to the EXACT build the client is currently showing
    // (see todaysDailyBriefing's doc comment) — a client that omits it
    // (older app build) gets today's build, same as before.
    const snapshotId = typeof req.query.snapshotId === 'string' ? req.query.snapshotId : null;
    const target = await todaysDailyBriefing(tz, day, snapshotId);
    if (!target?.content) return res.status(404).json({ error: 'no_brief', message: 'No briefing to narrate yet.' });
    let out;
    try {
      out = await briefAudio.audioFor('brief', target.content, day);
    } catch (ttsErr) {
      console.error('[briefing audio] TTS failed:', ttsErr.message);
      return res.status(502).json({ error: 'tts_failed', message: 'Narration is temporarily unavailable.' });
    }
    if (!out) return res.status(404).json({ error: 'nothing_to_narrate', message: 'This brief has nothing to read aloud.' });
    // Return base64 JSON (not a raw stream) so the client fetches it with normal
    // auth headers and plays from a local file — the same path the voice reply
    // uses and proven to work. Streaming the URL through expo-av dropped the
    // Authorization header on iOS and 401'd.
    res.json({ audio: out.audio.toString('base64'), mime: out.mime });
  }));

  // Spoken narration of tonight's evening wind-down brief — same cache-per-content
  // approach as the morning brief (prewarmed right after the brief builds, in
  // src/notify/evening-brief.js).
  //
  // Audit fix, item 4: explicitly enforces the SAME "today's content only"
  // day-check GET /evening-brief (the content route) already applies before
  // ever showing the card/Listen button on mobile — this route previously
  // trusted the CLIENT to only ever call it when that check had already
  // passed, with no equivalent guard of its own. A last-night's evening
  // brief still sitting as the most recent 'evening' row (today's hasn't
  // built yet — e.g. it's checked before the 9:30pm job runs) must never
  // be narrated as "tonight's" brief just because it's the newest one on
  // file.
  router.get('/evening-brief/audio', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const latest = await briefingsStore.latestBriefing('evening');
    const isToday = latest?.content?.day === day;
    if (!latest?.content || !isToday) return res.status(404).json({ error: 'no_brief', message: 'No wind-down brief to narrate yet.' });
    let out;
    try {
      out = await briefAudio.audioFor('evening', latest.content, day); // isToday above already guarantees latest.content.day === day
    } catch (ttsErr) {
      console.error('[evening audio] TTS failed:', ttsErr.message);
      return res.status(502).json({ error: 'tts_failed', message: 'Narration is temporarily unavailable.' });
    }
    if (!out) return res.status(404).json({ error: 'nothing_to_narrate', message: 'This brief has nothing to read aloud.' });
    res.json({ audio: out.audio.toString('base64'), mime: out.mime });
  }));

  // Spoken narration of today's Wisdom tab (quote, selected Notion passage,
  // relevant library highlight — see voice.js's composeWisdomNarrationScript)
  // — same content row as /briefing/audio (Wisdom's fields live flat on the
  // same daily-briefing object), same cache-per-content-hash/kind approach,
  // just a distinct `kind` so it can never collide with chief/evening audio
  // (see services/brief-audio.js's cache_key = kind:day:hash scheme).
  router.get('/wisdom/audio', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const snapshotId = typeof req.query.snapshotId === 'string' ? req.query.snapshotId : null;
    const target = await todaysDailyBriefing(tz, day, snapshotId);
    if (!target?.content) return res.status(404).json({ error: 'no_brief', message: 'No briefing to narrate yet.' });
    let out;
    try {
      out = await briefAudio.audioFor('wisdom', target.content, day);
    } catch (ttsErr) {
      console.error('[wisdom audio] TTS failed:', ttsErr.message);
      return res.status(502).json({ error: 'tts_failed', message: 'Narration is temporarily unavailable.' });
    }
    if (!out) return res.status(404).json({ error: 'nothing_to_narrate', message: "Today's Wisdom has nothing to read aloud yet." });
    res.json({ audio: out.audio.toString('base64'), mime: out.mime });
  }));

  return router;
}

module.exports = { createAudioRouter };
