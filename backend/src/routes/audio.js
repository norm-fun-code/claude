// Audio router: spoken narration of today's morning brief and tonight's
// evening wind-down brief, cached per content hash. Nineteenth router
// extraction out of server.js's monolith (see the engineering review's
// #1+#6 recommendation) — a straight move, verified line-by-line against
// the original before removing it from server.js.
const express = require('express');
const briefingsStore = require('../store/briefings');
const briefAudio = require('../services/brief-audio');
const { asyncHandler } = require('../middleware/asyncHandler');

function createAudioRouter() {
  const router = express.Router();

  // Spoken narration of today's chief-of-staff brief — cached per content hash,
  // so a rebuild re-narrates and an unchanged brief streams instantly.
  router.get('/briefing/audio', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const rows = await briefingsStore.listBriefings({ kind: 'daily', limit: 10 });
    // Prefer today's build; fall back to the most recent brief so "Listen"
    // still works if the tz-day match is off or the day just rolled over.
    const target = rows.find((r) => new Date(r.generated_at).toLocaleDateString('en-CA', { timeZone: tz }) === day) || rows[0];
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

  return router;
}

module.exports = { createAudioRouter };
