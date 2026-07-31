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
 * Resolve the target daily-briefing row for narration — the SAME
 * "kind: 'daily'" content the morning brief AND the Wisdom tab
 * (quote/notionQuote/relevantHighlight all live flat on this one persisted
 * object, see routes/briefing.js) both read. Shared so the morning-brief
 * and Wisdom audio routes can never drift on which build they resolve to.
 *
 * `snapshotId`, when provided, binds to the EXACT build the mobile client
 * is currently displaying (BriefingData.snapshotId — see routes/briefing.js's
 * `response.snapshotId` and useBriefing.ts's BriefingData type) — looked up
 * DIRECTLY (store/briefings.js's findBySnapshotId), regardless of which
 * local day it was generated on, and NEVER substituted with a different
 * build if it isn't found. This closes two related bugs:
 *   1. A mobile client showing a slightly-stale cached build (a newer
 *      rebuild landed after it fetched) could otherwise hear narration for
 *      content different from what's on screen.
 *   2. (The bug this specific fix targets) the OLD version of this function
 *      filtered to TODAY's rows FIRST and only then searched for
 *      snapshotId — so a mobile screen still showing yesterday's cached
 *      briefing after midnight got a clean 404 (`no_brief`) before TTS was
 *      ever attempted, with zero server-side signal anything had even been
 *      requested. A stale-but-real snapshot is now served on its own terms:
 *      exactly that content, narrated, regardless of which day it's from.
 *
 * Absent snapshotId, behavior is UNCHANGED: only today's local-day rows are
 * eligible, and the newest one wins — no fallback to "whatever's freshest"
 * (audit fix, item 4, preserved) — so an older app build (or a client that
 * has no snapshotId yet) still only ever narrates genuinely current content.
 *
 * This resolves a ROW, not specifically a chief brief — /wisdom/audio reads
 * unrelated fields (quote/notion passage) off the same row, and those can be
 * perfectly fine on a day the chief brief itself degraded. So this function
 * deliberately does NOT gate on isPublishableRow: the /briefing/audio route
 * (chief-brief narration specifically) applies that check itself, with its
 * own same-day publishable fallback, right where it decides what to narrate.
 */
async function resolveDailyBriefingTarget(tz, day, snapshotId) {
  if (snapshotId) return briefingsStore.findBySnapshotId('daily', snapshotId);
  const rows = await briefingsStore.listBriefings({ kind: 'daily', limit: 10 });
  return rows.find((r) => new Date(r.generated_at).toLocaleDateString('en-CA', { timeZone: tz }) === day) || null;
}

/**
 * The LOCAL DAY the target briefing's own content actually belongs to —
 * never "now". Feeds the audio cache key (services/brief-audio.js's
 * `kind:day:hash`), so narrating an explicit stale snapshotId caches (and
 * logs) under the day the CONTENT is from, not under today's bucket. Prefers
 * the persisted `content.localDate` (present on every build since the
 * Context Understanding Layer — see routes/briefing.js's `response.localDate`)
 * and falls back to the row's own `generated_at` (in `tz`) for any briefing
 * persisted before that field existed.
 */
function contentDayFor(target, tz) {
  return target?.content?.localDate || new Date(target.generated_at).toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * Respond with a warm narration immediately, or a compact status for a cold
 * one. The renderer owns the exact same cached job on every poll, so this
 * never waits for provider work inside a long-held HTTP request. `202` means
 * work is genuinely in progress; `503` means the last attempt failed and a
 * later tap/poll is a real retry, not a misleading permanent "Unavailable".
 */
async function sendAudioStatus(res, kind, content, day, { asynchronous = false } = {}) {
  // Older installed clients expect a single long-poll response. Keep that
  // contract for them while the current mobile client opts into the truthful
  // status flow via ?narrationStatus=1 below. This is compatibility, not a
  // second architecture: both paths share the exact cache/job function.
  if (!asynchronous) {
    try {
      const out = await briefAudio.audioFor(kind, content, day, { source: 'foreground' });
      if (!out) return res.status(404).json({ error: 'nothing_to_narrate', message: 'This brief has nothing to read aloud.' });
      return res.json({ audio: out.audio.toString('base64'), mime: out.mime });
    } catch (ttsErr) {
      console.error(`[${kind} audio] TTS failed:`, ttsErr.message);
      return res.status(502).json({ error: 'tts_failed', message: 'Narration is temporarily unavailable.' });
    }
  }
  const out = await briefAudio.requestAudio(kind, content, day, { source: 'foreground' });
  if (out.status === 'ready') return res.json({ audio: out.audio.toString('base64'), mime: out.mime });
  if (out.status === 'empty') return res.status(404).json({ error: 'nothing_to_narrate', message: 'This brief has nothing to read aloud.' });
  if (out.status === 'failed') {
    return res.status(503).json({
      error: 'tts_failed', message: 'Narration is temporarily unavailable.', retryAfterMs: out.retryAfterMs,
    });
  }
  return res.status(202).json({ status: 'preparing', retryAfterMs: out.retryAfterMs });
}

function createAudioRouter() {
  const router = express.Router();

  // Spoken narration of today's chief-of-staff brief — cached per content hash,
  // so a rebuild re-narrates and an unchanged brief streams instantly.
  router.get('/briefing/audio', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    // Optional: bind to the EXACT build the client is currently showing
    // (see resolveDailyBriefingTarget's doc comment) — a client that omits
    // it (older app build) gets today's build, same as before.
    const snapshotId = typeof req.query.snapshotId === 'string' ? req.query.snapshotId : null;
    let target = await resolveDailyBriefingTarget(tz, day, snapshotId);
    // Chief-brief-specific same-day publishable fallback: an explicit
    // snapshotId pin is never substituted (it means "narrate exactly this
    // build"), but absent one, a degraded/pending/thin repair attempt that
    // landed as today's newest row must not be narrated in place of the
    // last valid same-day Chief Brief — same selector the mobile client's
    // displayed content already falls back to (store/briefings.js's
    // latestPublishableDailyForLocalDay).
    if (!snapshotId && target?.content && !briefingsStore.isPublishableRow(target.content)) {
      target = await briefingsStore.latestPublishableDailyForLocalDay(day, { tz });
    }
    if (!target?.content) {
      // Distinct, machine-readable: an explicit snapshotId that couldn't be
      // found (stale/garbage id) is a DIFFERENT failure than "no snapshotId
      // given and there's no briefing for today yet" — the client needs to
      // tell these apart (see mobile/src/hooks/useBriefAudio.ts).
      return res.status(404).json(
        snapshotId
          ? { error: 'snapshot_not_found', message: 'That briefing could not be found.' }
          : { error: 'no_brief', message: 'No briefing to narrate yet.' }
      );
    }
    return sendAudioStatus(res, 'brief', target.content, contentDayFor(target, tz), { asynchronous: req.query.narrationStatus === '1' });
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
    return sendAudioStatus(res, 'evening', latest.content, day, { asynchronous: req.query.narrationStatus === '1' }); // isToday above already guarantees latest.content.day === day
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
    const target = await resolveDailyBriefingTarget(tz, day, snapshotId);
    if (!target?.content) {
      return res.status(404).json(
        snapshotId
          ? { error: 'snapshot_not_found', message: 'That briefing could not be found.' }
          : { error: 'no_brief', message: 'No briefing to narrate yet.' }
      );
    }
    return sendAudioStatus(res, 'wisdom', target.content, contentDayFor(target, tz), { asynchronous: req.query.narrationStatus === '1' });
  }));

  return router;
}

module.exports = { createAudioRouter };
