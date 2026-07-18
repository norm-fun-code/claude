// Shared spoken-narration cache for the morning, evening, AND Wisdom briefs —
// one cache_key scheme (kind:day:contentHash) so narration only regenerates
// when the CONTENT or VOICE actually changes, not on every "Listen" tap.
const crypto = require('crypto');
const db = require('../db');
const voiceService = require('./voice');

function scriptFor(kind, content) {
  if (kind === 'evening') return voiceService.composeEveningNarrationScript(content);
  if (kind === 'wisdom') return voiceService.composeWisdomNarrationScript(content);
  return voiceService.composeNarrationScript(content);
}

// Live bug found via a product review: tapping "Listen" right after a
// rebuild sometimes flashed "Unavailable" (timed out) then played fine on a
// second tap. Root cause was partly here — audioFor() had no in-flight
// dedup, so the post-rebuild prewarm() call and the user's own "Listen" tap
// could both miss the not-yet-written cache row and each independently fire
// a synthesize() call to Gemini for the exact same script, doubling TTS load
// right when the system is already busiest. Same pattern as monarch-wealth's
// `cached()` in-flight dedup: concurrent callers for the same cache key
// share one pending promise instead of each starting their own.
const inFlight = new Map(); // cacheKey -> Promise<{audio,mime}>

/** Generate (or reuse) a brief's narration audio; returns { audio, mime } or null. */
async function audioFor(kind, content, day) {
  const start = Date.now();
  const script = scriptFor(kind, content);
  if (!script) return null;
  // Key on the voice too — changing NORMOS_VOICE (or the default) must
  // regenerate, not serve audio narrated in the old voice.
  const hash = crypto.createHash('sha1').update(`${voiceService.DEFAULT_VOICE}\n${script}`).digest('hex').slice(0, 10);
  const cacheKey = `${kind}:${day}:${hash}`;
  const { rows } = await db.query(`SELECT audio, mime FROM tts_audio WHERE cache_key = $1`, [cacheKey]);
  if (rows[0]) {
    console.log(`[brief audio] cache HIT kind=${kind} day=${day} elapsedMs=${Date.now() - start}`);
    return { audio: rows[0].audio, mime: rows[0].mime };
  }

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  console.log(`[brief audio] cache MISS kind=${kind} day=${day} — starting synthesis`);
  const promise = (async () => {
    try {
      const { audio, mime, model } = await voiceService.synthesize(script);
      await db.query(
        `INSERT INTO tts_audio (cache_key, audio, mime) VALUES ($1, $2, $3)
         ON CONFLICT (cache_key) DO NOTHING`,
        [cacheKey, audio, mime]
      );
      // Prune stale narrations so the table never grows past a handful of rows.
      db.query(`DELETE FROM tts_audio WHERE created_at < now() - interval '7 days'`).catch(() => {});
      console.log(`[brief audio] synthesis SUCCESS kind=${kind} day=${day} model=${model || 'unknown'} elapsedMs=${Date.now() - start}`);
      return { audio, mime };
    } catch (err) {
      console.error(`[brief audio] synthesis FAILED kind=${kind} day=${day} elapsedMs=${Date.now() - start}: ${err.message}`);
      throw err;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();
  inFlight.set(cacheKey, promise);
  return promise;
}

/** Fire-and-forget pre-warm so the first "Listen" tap plays instantly. */
async function prewarm(kind, content, day) {
  await audioFor(kind, content, day);
}

/** Pre-warm today's morning-brief narration, resolving "today" from TZ. */
async function prewarmDaily(content) {
  const tz = process.env.TZ || 'America/New_York';
  const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  await prewarm('brief', content, day);
}

/**
 * Startup/deploy-time backfill: prewarm today's ALREADY-PERSISTED briefing
 * content (brief + wisdom, and evening if it happens to already exist) so a
 * server restart mid-day — or a deploy landing this Wisdom-prewarm feature
 * itself for the first time — doesn't leave today's briefing permanently
 * without a warm cache. Without this, the ONLY prewarm trigger is the build
 * request itself (routes/briefing.js / notify/evening-brief.js) — a briefing
 * that was built and persisted before this backfill (or before Wisdom
 * prewarming existed at all) would never get a warm cache until someone
 * happens to hit the cold GET /api/wisdom/audio path directly. Uses the
 * EXACT final persisted content (never reconstructs or approximates it), and
 * is best-effort: any failure here must never block server boot.
 */
async function backfillTodayAudio() {
  const tz = process.env.TZ || 'America/New_York';
  const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const briefingsStore = require('../store/briefings');
  try {
    const dailyRows = await briefingsStore.listBriefings({ kind: 'daily', limit: 10 });
    const todaysDaily = dailyRows.find((r) => new Date(r.generated_at).toLocaleDateString('en-CA', { timeZone: tz }) === day);
    if (todaysDaily?.content) {
      // Sequenced, not concurrent — same reasoning as routes/briefing.js's
      // post-build prewarm: Chief and Wisdom would otherwise compete for the
      // same rate-limited TTS provider at the exact moment the system is
      // already busiest (server boot). Chief keeps priority; a Wisdom
      // failure never affects Chief's own prewarm result.
      await prewarm('brief', todaysDaily.content, day).catch((err) => console.error(`[brief audio backfill] brief prewarm failed: ${err.message}`));
      await prewarm('wisdom', todaysDaily.content, day).catch((err) => console.error(`[brief audio backfill] wisdom prewarm failed: ${err.message}`));
    } else {
      console.log(`[brief audio backfill] no daily briefing persisted for ${day} yet — nothing to backfill`);
    }
    const evening = await briefingsStore.latestBriefing('evening');
    if (evening?.content?.day === day) {
      await prewarm('evening', evening.content, day).catch((err) => console.error(`[brief audio backfill] evening prewarm failed: ${err.message}`));
    }
  } catch (err) {
    console.error(`[brief audio backfill] failed: ${err.message}`);
  }
}

module.exports = { audioFor, prewarm, prewarmDaily, backfillTodayAudio };
