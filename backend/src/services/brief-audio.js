// Shared spoken-narration cache for the morning, evening, AND Wisdom briefs —
// one cache_key scheme (kind:day:contentHash) so narration only regenerates
// when the CONTENT or VOICE actually changes, not on every "Listen" tap.
//
// Live bug (the one THIS file's serialization gate below exists to close):
// adding Wisdom prewarming (right after Chief's) meant two INDEPENDENT
// trigger paths — the post-build prewarm chain in routes/briefing.js and,
// until removed, a boot-time backfill in server.js — could each be mid-way
// through their own "brief then wisdom" sequencing at the same time,
// with nothing stopping one chain's Wisdom call from overlapping another's
// Brief call. Per-cache-key inFlight dedup (below) only prevents the SAME
// key from double-firing; it does nothing for two DIFFERENT keys firing at
// once. Production logs confirmed it: cache MISS for both brief and wisdom
// followed by two simultaneous Interactions calls to the same TTS model,
// each timing out at ~25s — a resource-contention bug, not an endpoint or
// timeout bug (see gateAcquire/gateRelease below for the actual fix).
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
// share one pending promise instead of each starting their own. This ONLY
// covers the SAME cache key (same kind+day+content) — see the gate below for
// the cross-key (e.g. brief vs. wisdom) case.
const inFlight = new Map(); // cacheKey -> Promise<{audio,mime}>

// ── Process-wide TTS serialization gate ─────────────────────────────────
// At most ONE call into voiceService.synthesize() may be in flight at any
// time, across every kind (brief/wisdom/evening) and every trigger
// (foreground Listen tap, background prewarm) — Gemini TTS calls are slow
// and rate-sensitive enough that two at once measurably increases the odds
// either one times out, and a background prewarm has no business competing
// with a real tap for the one shared resource. A `source` of 'foreground'
// jumps ahead of any already-queued 'prewarm' entries (but never ahead of
// another foreground request — stable order among peers); background
// prewarm work queues FIFO behind whatever's ahead of it.
let gateLocked = false;
const gateQueue = []; // { source, resolve }
let jobCounter = 0;

function acquireGate(source) {
  return new Promise((resolve) => {
    if (!gateLocked) {
      gateLocked = true;
      resolve();
      return;
    }
    const entry = { source, resolve };
    if (source === 'foreground') {
      const idx = gateQueue.findIndex((e) => e.source !== 'foreground');
      if (idx === -1) gateQueue.push(entry);
      else gateQueue.splice(idx, 0, entry);
    } else {
      gateQueue.push(entry);
    }
  });
}

// Always called from a finally{} at every audioFor() exit path (success,
// failure, or the synthesize() call's own timeout) — the gate must never
// stay held by a job that's done, whatever way it finished.
function releaseGate() {
  const next = gateQueue.shift();
  if (next) next.resolve();
  else gateLocked = false;
}

/** Generate (or reuse) a brief's narration audio; returns { audio, mime } or null.
 * @param {object} [opts]
 * @param {'foreground'|'prewarm'} [opts.source] — 'foreground' (default) is a
 *   real user Listen tap; 'prewarm' is background cache-warming (lower queue
 *   priority — see acquireGate above). Purely a logging/priority label, never
 *   changes cache behavior.
 */
async function audioFor(kind, content, day, { source = 'foreground' } = {}) {
  const start = Date.now();
  const script = scriptFor(kind, content);
  if (!script) return null;
  // Key on the voice too — changing NORMOS_VOICE (or the default) must
  // regenerate, not serve audio narrated in the old voice.
  const hash = crypto.createHash('sha1').update(`${voiceService.DEFAULT_VOICE}\n${script}`).digest('hex').slice(0, 10);
  const cacheKey = `${kind}:${day}:${hash}`;
  const { rows } = await db.query(`SELECT audio, mime FROM tts_audio WHERE cache_key = $1`, [cacheKey]);
  if (rows[0]) {
    console.log(`[brief audio] cache HIT kind=${kind} day=${day} source=${source} elapsedMs=${Date.now() - start}`);
    return { audio: rows[0].audio, mime: rows[0].mime };
  }

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const jobId = `ba${++jobCounter}`;
  console.log(`[brief audio] cache MISS kind=${kind} day=${day} source=${source} job=${jobId} — queueing for synthesis`);
  const promise = (async () => {
    const queuedAt = Date.now();
    await acquireGate(source);
    const queueWaitMs = Date.now() - queuedAt;
    try {
      // Re-check the cache AFTER acquiring the gate — this job may have sat
      // queued long enough for the content to have become warm some other
      // way (e.g. another key's synthesis wrote it in a rare hash
      // collision-free race, or a retry elsewhere already completed it);
      // never spend a real Gemini call on something that's already cached.
      const { rows: rowsAfterGate } = await db.query(`SELECT audio, mime FROM tts_audio WHERE cache_key = $1`, [cacheKey]);
      if (rowsAfterGate[0]) {
        console.log(`[brief audio] cache HIT (warmed while queued) kind=${kind} day=${day} source=${source} job=${jobId} queueWaitMs=${queueWaitMs}`);
        return { audio: rowsAfterGate[0].audio, mime: rowsAfterGate[0].mime };
      }
      console.log(`[brief audio] synthesis START kind=${kind} day=${day} source=${source} job=${jobId} queueWaitMs=${queueWaitMs} active=1 queued=${gateQueue.length}`);
      const { audio, mime, model } = await voiceService.synthesize(script);
      await db.query(
        `INSERT INTO tts_audio (cache_key, audio, mime) VALUES ($1, $2, $3)
         ON CONFLICT (cache_key) DO NOTHING`,
        [cacheKey, audio, mime]
      );
      // Prune stale narrations so the table never grows past a handful of rows.
      db.query(`DELETE FROM tts_audio WHERE created_at < now() - interval '7 days'`).catch(() => {});
      console.log(`[brief audio] synthesis SUCCESS kind=${kind} day=${day} source=${source} job=${jobId} model=${model || 'unknown'} queueWaitMs=${queueWaitMs} elapsedMs=${Date.now() - start}`);
      return { audio, mime };
    } catch (err) {
      console.error(`[brief audio] synthesis FAILED kind=${kind} day=${day} source=${source} job=${jobId} queueWaitMs=${queueWaitMs} elapsedMs=${Date.now() - start}: ${err.message}`);
      throw err;
    } finally {
      // Order doesn't matter for correctness (two independent maps/state),
      // but the gate must release even if this job never technically
      // "finished" synthesis (e.g. it returned early on the re-check-cache
      // hit above) — every path through this try/catch reaches this finally.
      releaseGate();
      inFlight.delete(cacheKey);
    }
  })();
  inFlight.set(cacheKey, promise);
  return promise;
}

/** Fire-and-forget pre-warm so the first "Listen" tap plays instantly.
 *  Always queues as background (source: 'prewarm') — see acquireGate. */
async function prewarm(kind, content, day) {
  await audioFor(kind, content, day, { source: 'prewarm' });
}

/** Pre-warm today's morning-brief narration, resolving "today" from TZ. */
async function prewarmDaily(content) {
  const tz = process.env.TZ || 'America/New_York';
  const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  await prewarm('brief', content, day);
}

module.exports = { audioFor, prewarm, prewarmDaily };
