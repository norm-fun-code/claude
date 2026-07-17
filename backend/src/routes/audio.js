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

/** Today's canonical daily-briefing row — the SAME "kind: 'daily'" content
 *  the morning brief AND the Wisdom tab (quote/notionQuote/relevantHighlight
 *  all live flat on this one persisted object, see routes/briefing.js) both
 *  read. Shared so the morning-brief and Wisdom audio routes can never drift
 *  on which build counts as "today's". Prefers today's build; falls back to
 *  the most recent brief so "Listen" still works if the tz-day match is off
 *  or the day just rolled over. */
async function todaysDailyBriefing(tz, day) {
  const rows = await briefingsStore.listBriefings({ kind: 'daily', limit: 10 });
  return rows.find((r) => new Date(r.generated_at).toLocaleDateString('en-CA', { timeZone: tz }) === day) || rows[0];
}

function createAudioRouter() {
  const router = express.Router();

  // Spoken narration of today's chief-of-staff brief — cached per content hash,
  // so a rebuild re-narrates and an unchanged brief streams instantly.
  router.get('/briefing/audio', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const target = await todaysDailyBriefing(tz, day);
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
  router.get('/evening-brief/audio', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const latest = await briefingsStore.latestBriefing('evening');
    if (!latest?.content) return res.status(404).json({ error: 'no_brief', message: 'No wind-down brief to narrate yet.' });
    let out;
    try {
      out = await briefAudio.audioFor('evening', latest.content, latest.content.day || day);
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
    const target = await todaysDailyBriefing(tz, day);
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
