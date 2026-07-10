// Shared spoken-narration cache for the morning AND evening briefs — one
// cache_key scheme (kind:day:contentHash) so narration only regenerates when
// the CONTENT or VOICE actually changes, not on every "Listen" tap.
const crypto = require('crypto');
const db = require('../db');
const voiceService = require('./voice');

function scriptFor(kind, content) {
  return kind === 'evening'
    ? voiceService.composeEveningNarrationScript(content)
    : voiceService.composeNarrationScript(content);
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
  const script = scriptFor(kind, content);
  if (!script) return null;
  // Key on the voice too — changing NORMOS_VOICE (or the default) must
  // regenerate, not serve audio narrated in the old voice.
  const hash = crypto.createHash('sha1').update(`${voiceService.DEFAULT_VOICE}\n${script}`).digest('hex').slice(0, 10);
  const cacheKey = `${kind}:${day}:${hash}`;
  const { rows } = await db.query(`SELECT audio, mime FROM tts_audio WHERE cache_key = $1`, [cacheKey]);
  if (rows[0]) return { audio: rows[0].audio, mime: rows[0].mime };

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const { audio, mime } = await voiceService.synthesize(script);
      await db.query(
        `INSERT INTO tts_audio (cache_key, audio, mime) VALUES ($1, $2, $3)
         ON CONFLICT (cache_key) DO NOTHING`,
        [cacheKey, audio, mime]
      );
      // Prune stale narrations so the table never grows past a handful of rows.
      db.query(`DELETE FROM tts_audio WHERE created_at < now() - interval '7 days'`).catch(() => {});
      return { audio, mime };
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

module.exports = { audioFor, prewarm, prewarmDaily };
