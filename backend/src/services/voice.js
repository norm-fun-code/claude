// Voice for the chief of staff: neural TTS (brief narration + spoken answers)
// and STT (push-to-talk transcription), both via Gemini so no new API accounts
// are needed. Swap the voice/model via env without code changes:
//   NORMOS_VOICE       — Gemini prebuilt voice name (default 'Charon')
//   GEMINI_TTS_MODEL   — TTS model override. MUST be an actual TTS-capable
//                        model id (contains "tts", e.g.
//                        gemini-2.5-flash-preview-tts) — it is tried FIRST,
//                        ahead of every built-in fallback below. A wrong
//                        value there fails its own attempt (logged loudly —
//                        see checkTtsModelOverride) but the retry loop still
//                        falls through to the real candidates afterward, so
//                        narration degrades rather than breaking outright —
//                        just don't expect the override itself to ever work.
const axios = require('axios');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Live bug, confirmed via Railway logs: gemini-3.1-flash-tts-preview timed
// out at 25s and the gemini-2.5-flash-preview-tts fallback 400'd — NOT a
// timeout/ordering problem (that was the PREVIOUS fix). Root cause: every TTS
// model was being sent to the legacy GenerateContent endpoint
// (POST /v1beta/models/{model}:generateContent with camelCase
// generationConfig). Per ai.google.dev/gemini-api/docs/speech-generation,
// current Gemini TTS models are served through a SEPARATE Interactions API
// (POST /v1beta/interactions, snake_case body, response audio at
// output_audio.data) — GenerateContent for these models either hangs waiting
// on a response shape that never arrives (the 25s timeout) or is rejected
// outright (the 400). STT is unaffected — transcribe() below still uses
// GenerateContent, which remains the correct/documented path for it; only
// TTS moved.
const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
// Live bug: an earlier version of this fix sent a guessed 'Api-Revision:
// 2026-05-20' header on every call, sourced from a less-reliable secondary
// fetch. Deployed to production, EVERY candidate model then hung for
// exactly the configured per-attempt timeout instead of the fast
// success/rejection the canonical documented curl example implies — the
// canonical example itself sends no Api-Revision header at all. Unverified
// header value on a request that then hangs (rather than a clean 400) is
// exactly the failure mode of an API gateway choking on a value it doesn't
// recognize. Default to NOT sending this header; set
// GEMINI_INTERACTIONS_API_REVISION explicitly only if Google's docs are
// re-confirmed (via a neutral, non-leading check, not a leading question)
// to require one.
const INTERACTIONS_API_REVISION = process.env.GEMINI_INTERACTIONS_API_REVISION || null;

function key() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY not set');
  return k;
}

// Fail immediately and loudly (never silently degrade into a slow timeout)
// when the one credential every TTS/STT call needs is absent — never logs
// the key itself, only whether one is configured.
function assertKeyConfigured(context) {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) return;
  console.error(`[voice ${context}] GEMINI_API_KEY is not set — narration/transcription cannot work until it is configured.`);
  throw new Error('GEMINI_API_KEY not set');
}

// Primary + fallbacks so a retired preview model degrades gracefully instead
// of killing narration until someone edits env vars.
//
// Live bug found via Railway logs on the Wisdom Listen "Unavailable" report
// (two distinct root causes, both confirmed from production logs, not
// guessed):
//  1. 'gemini-3.5-flash-tts' does not exist — Gemini returned a 404 "is not
//     found for API version v1beta, or is not supported for generateContent"
//     for every single call to it. No amount of timeout tuning fixes calling
//     a nonexistent model. Removed entirely.
//  2. Of the two real, documented preview models, 'gemini-2.5-flash-preview-tts'
//     400'd and 'gemini-2.5-pro-preview-tts' timed out in this account —
//     'gemini-3.1-flash-tts-preview' (the current model per
//     ai.google.dev/gemini-api/docs/speech-generation) is the one that
//     actually works, so it's now PRIMARY, with the two 2.5 preview models
//     kept as fallbacks in case 3.1 is ever degraded/retired in turn.
const TTS_CANDIDATES = ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'];

// A GEMINI_TTS_MODEL override is tried FIRST, ahead of every candidate above
// — a wrong value there wastes one attempt (this was the SECOND live bug:
// Railway's GEMINI_TTS_MODEL was set to 'gemini-3.5-flash', a plain
// text-generation model reused from GEMINI_CHAT_MODEL, not a TTS-capable
// one), but the retry loop still falls through to the real candidates above
// afterward — it does not break narration outright. This can't be silently
// overridden — the operator's explicit choice is still tried first — but it
// CAN be loudly warned about, which is what this does: log one clear,
// actionable line, then let the retry loop continue on to the real
// candidates as it already would.
function checkTtsModelOverride(model) {
  if (!/tts/i.test(model)) {
    console.error(
      `[voice tts] GEMINI_TTS_MODEL="${model}" does not look like a TTS-capable model id (no "tts" in the name) ` +
      `— it will be tried FIRST, ahead of every built-in fallback, and will very likely fail on every call. ` +
      `Unset GEMINI_TTS_MODEL or point it at a real TTS model (e.g. gemini-3.1-flash-tts-preview).`
    );
  }
}

function ttsModels() {
  const fromEnv = process.env.GEMINI_TTS_MODEL;
  if (!fromEnv) return TTS_CANDIDATES;
  checkTtsModelOverride(fromEnv);
  return [fromEnv, ...TTS_CANDIDATES.filter((m) => m !== fromEnv)];
}

/**
 * Live model-LISTING probe via Gemini's ListModels endpoint — reports which
 * of TTS_CANDIDATES (plus a configured GEMINI_TTS_MODEL override, if any)
 * this API key can even SEE, without ever logging the key itself. This is
 * NOT proof a model actually works: ListModels merely enumerates what the
 * account can address, it doesn't exercise the Interactions API's request
 * contract at all (live bug this distinction exists to prevent recurring:
 * gemini-2.5-flash-preview-tts was listed here yet still 400'd in
 * production, because the real bug was the request path/shape, not model
 * existence — see synthesize()'s header comment). Field names say `listed`,
 * not `available`, on purpose. Used by `npm run doctor` (and safe to call
 * from an admin diagnostic route) — read-only, never throws, never places a
 * real (paid) synthesis call, degrades to a clear error string on any
 * network/auth failure so a doctor-style caller can just print whatever
 * comes back.
 */
async function probeTtsModelAvailability() {
  const configured = process.env.GEMINI_TTS_MODEL || null;
  const candidates = [...new Set([...(configured ? [configured] : []), ...TTS_CANDIDATES])];
  if (!process.env.GEMINI_API_KEY) {
    return { configured, configuredLooksValid: configured ? /tts/i.test(configured) : null, candidates, listed: null, error: 'GEMINI_API_KEY not set' };
  }
  try {
    const { data } = await axios.get(`${BASE}/models?key=${key()}&pageSize=1000`, { timeout: 8000 });
    const liveNames = new Set((data.models || []).map((m) => String(m.name || '').replace(/^models\//, '')));
    const listed = candidates.filter((m) => liveNames.has(m));
    return {
      configured,
      configuredLooksValid: configured ? /tts/i.test(configured) : null,
      candidates,
      listed,
      notListed: candidates.filter((m) => !listed.includes(m)),
      error: null,
    };
  } catch (err) {
    // Never include the request URL (it carries the key in the query
    // string) — only the provider's own sanitized error detail.
    const detail = err.response?.data?.error?.message || err.message;
    return { configured, configuredLooksValid: configured ? /tts/i.test(configured) : null, candidates, listed: null, error: detail };
  }
}

/** Wrap raw 16-bit PCM in a WAV header so any player can play it. */
function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Synthesize speech. Returns { audio: Buffer (WAV), mime: 'audio/wav' }.
 * The style directive rides inside the prompt (Gemini TTS follows natural-
 * language delivery instructions without reading them aloud).
 */
// Default prebuilt voice. Gemini's voices each have a fixed character; the style
// directive only nudges prosody, so the VOICE is the real lever. 'Orus' is
// Google's "Firm" male voice. Swap via NORMOS_VOICE. Other options tried:
// Achird (Friendly), Puck (Upbeat), Fenrir (Excitable), Sadachbia (Lively),
// Zubenelgenubi (Casual).
const DEFAULT_VOICE = process.env.NORMOS_VOICE || 'Orus';

// Same transient-failure test as isTransientSttError below — a timeout or an
// overloaded-model status is worth a retry; a bad request/auth error is not.
function isTransientTtsError(err) {
  const status = err.response?.status;
  return status === 503 || status === 429 || status === 500
    || err.code === 'ECONNABORTED' || /timeout of/i.test(err.message || '');
}

// Audit fix, item 4/7: the per-attempt timeout used to be 45s — a PER-CALL
// budget, not a total one. With 3 candidate models and the last one getting
// a same-model retry, that meant ONE slow/hanging model could burn nearly
// the entire OVERALL_TIMEOUT_MS by itself (45s of a 50s budget), leaving the
// "fast fallback" in name only: by the time the first attempt failed there
// was only ~5s left for every other candidate combined, and the 50s-vs-60s
// margin against the mobile client's own timeout (useBriefAudio.ts) left
// almost no room for normal network/Railway/proxy latency on top. That's
// the mechanism behind "Listen" timing out at 60s and showing "Unavailable"
// even though the server was still (usually pointlessly, by then) trying.
// Fixed by shrinking BOTH numbers: a per-model timeout generous enough for a
// genuinely slow (not hung) model to still succeed, but short enough that a
// bad/hung model can't eat the whole budget — and a shorter overall deadline
// that leaves real margin under the client's terminal timeout instead of
// racing it to the wire. 25s/45s (not the earlier 8s/40s): real failures
// here are near-instant (400/404 in well under a second), so this budget is
// almost entirely a safety net for a genuine hang, not a "normal" wait.
const OVERALL_TIMEOUT_MS = Number(process.env.GEMINI_TTS_OVERALL_TIMEOUT_MS || 45000);

async function synthesize(text, { voice = DEFAULT_VOICE, style } = {}) {
  assertKeyConfigured('tts');
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('nothing to synthesize');
  const directive = style || process.env.NORMOS_VOICE_STYLE ||
    'Speak naturally with a warm, calm, optimistic tone. Sound like a trusted friend who is genuinely excited to help. ' +
    'Keep responses conversational and concise. Never sound robotic, overly enthusiastic, or like a customer support agent. ' +
    'Use occasional humor and warmth. Pause naturally. Celebrate wins without exaggeration.';
  // The Interactions API's `input` has no separate field for delivery/style
  // direction — it's one text blob the model both reads for guidance AND may
  // speak verbatim if it can't tell the two apart. Per the documented
  // prompting guidance (ai.google.dev/gemini-api/docs/speech-generation):
  // "vague prompts may... caus[e] the model to read your style instructions
  // and director's notes aloud" — the fix is an explicit preamble plus
  // clearly labeled sections so the model has an unambiguous boundary for
  // where performance direction ends and the exact words to speak begin.
  const input =
    `Synthesize natural speech audio for the text below. Follow DIRECTOR'S NOTES for tone, pace, and delivery — ` +
    `do not speak the notes themselves aloud. Speak only the exact words under TRANSCRIPT, verbatim, nothing added or omitted.\n\n` +
    `DIRECTOR'S NOTES\n${directive}\n\n` +
    `TRANSCRIPT\n${trimmed.slice(0, 4000)}`;
  const payload = {
    input,
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] },
  };

  // Live bug: a single timed-out (or otherwise transient) Gemini call used to
  // `break` out of the model loop immediately — a temporary hiccup on the
  // FIRST candidate model killed the whole synthesize() call with zero
  // fallback attempted, surfacing to the user as "Listen" flashing
  // "Unavailable" even though a retry (or even just the next model) would
  // likely have succeeded. Mirrors transcribe()'s retry structure exactly:
  // only the LAST model gets a same-model retry-with-backoff on a transient
  // failure (an earlier model falling through to the NEXT candidate beats
  // waiting on one that just failed); every model is tried regardless of
  // error type — a non-transient error just skips that model's retry.
  //
  // 25s per attempt: a healthy TTS call for a script this size
  // (composeWisdomNarrationScript caps at 1400 chars) normally returns in
  // low single-digit seconds, so this is mostly a hang guard, not a normal
  // wait. With OVERALL_TIMEOUT_MS=45000, that's still enough budget for all
  // 3 candidate models plus the last one's retry to run within the deadline
  // even in the worst case, while staying generous enough that a genuinely
  // (not hung, just) slow model gets a real chance to finish.
  const timeoutMs = Number(process.env.GEMINI_TTS_TIMEOUT_MS || 25000);
  const backoffMs = Number(process.env.GEMINI_TTS_BACKOFF_MS || 500);
  const models = ttsModels();
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;

  const attempt = async (model) => {
    // Each individual attempt is capped at whichever is SMALLER: its own
    // per-call budget, or whatever's actually left of the overall deadline
    // — so a slow first attempt can't single-handedly blow through the
    // total budget before the loop even gets a chance to check it again.
    const remaining = deadline - Date.now();
    const attemptStart = Date.now();
    // Live bug found via Railway logs after deploying the Interactions
    // migration: EVERY candidate model hung for exactly the configured
    // per-attempt timeout (25004ms/25003ms — not a fast rejection), on both
    // Brief and Wisdom simultaneously. Re-verified the documented request
    // shape with a neutral (non-leading) fetch of the canonical curl example
    // on ai.google.dev/gemini-api/docs/speech-generation — it does NOT
    // include an Api-Revision header at all. That header was added earlier
    // from a separate, less-reliable source and is the one part of this
    // request that doesn't match the verified canonical example — an
    // unrecognized/invalid revision value is a plausible way for a gateway
    // to silently hang a request instead of fast-rejecting it. Only send it
    // if an operator explicitly configures one (nothing sent by default).
    const headers = {
      'x-goog-api-key': key(),
      'Content-Type': 'application/json',
    };
    if (INTERACTIONS_API_REVISION) headers['Api-Revision'] = INTERACTIONS_API_REVISION;
    const { data } = await axios.post(
      INTERACTIONS_URL,
      { model, ...payload },
      { timeout: Math.max(1000, Math.min(timeoutMs, remaining)), headers }
    );
    const elapsedMs = Date.now() - attemptStart;
    const audioB64 = data.output_audio?.data;
    if (!audioB64) throw new Error('no audio in TTS response');
    const pcm = Buffer.from(audioB64, 'base64');
    // Mime like "audio/L16;codec=pcm;rate=24000" if present — pull the rate;
    // Gemini TTS's underlying engine defaults to 24kHz mono PCM regardless of
    // endpoint, so that's the safe fallback when the field is absent (not
    // documented as always present for Interactions responses).
    const rateMatch = String(data.output_audio?.mime_type || '').match(/rate=(\d+)/);
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
    console.log(`[voice tts] endpoint=interactions model=${model} status=200 elapsedMs=${elapsedMs}`);
    return { audio: pcmToWav(pcm, { sampleRate }), mime: 'audio/wav', model };
  };

  let lastErr = null;
  outer:
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const isLast = i === models.length - 1;
    const maxTries = isLast ? 2 : 1;
    for (let tryNum = 0; tryNum < maxTries; tryNum++) {
      if (Date.now() >= deadline) {
        console.error(`[voice tts] overall ${OVERALL_TIMEOUT_MS}ms deadline exceeded before trying ${model} (try ${tryNum + 1}/${maxTries})`);
        break outer;
      }
      const tryStart = Date.now();
      try {
        return await attempt(model);
      } catch (err) {
        lastErr = err;
        // Log the exact endpoint/API path, model, HTTP status, elapsed time,
        // AND the PROVIDER's own error detail (e.g. "model not found for API
        // version v1beta") — axios's generic "Request failed with status
        // code 400" alone was not enough to diagnose a live "Unavailable"
        // report (root cause turned out to be the wrong endpoint contract
        // entirely — see this file's header comment). Never logs the
        // request URL/key — only the HTTP status and the response body
        // Gemini itself returned.
        const status = err.response?.status ?? (err.code === 'ECONNABORTED' || /timeout of/i.test(err.message || '') ? 'timeout' : 'unknown');
        const detail = err.response?.data?.error?.message;
        const elapsedMs = Date.now() - tryStart;
        // errCode distinguishes OUR OWN client-side timeout firing with zero
        // response (ECONNABORTED — what a hung/never-responding request looks
        // like) from a fast network-level rejection (ECONNREFUSED/ENOTFOUND)
        // or a genuine HTTP error response — collapsing these into one
        // "status=timeout" bucket is exactly what made the last live
        // "everything hangs at 25s" incident slower to diagnose than it
        // needed to be.
        console.error(`[voice tts] endpoint=interactions model=${model} status=${status} errCode=${err.code || 'n/a'} try=${tryNum + 1}/${maxTries} elapsedMs=${elapsedMs}: ${err.message}${detail ? ` — ${detail}` : ''}`);
        if (!isTransientTtsError(err)) break;
        if (tryNum < maxTries - 1 && backoffMs > 0 && Date.now() + backoffMs < deadline) await sleep(backoffMs);
      }
    }
  }
  throw new Error(`TTS failed: ${lastErr?.response?.data?.error?.message || lastErr?.message || 'overall timeout budget exceeded'}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** STT model candidates, tried in order. Defaults to the mature, stable
 *  gemini-2.5-flash FIRST — live logs showed gemini-3.5-flash (a newer/preview
 *  model) returning a consistent 503 "the model is overloaded", so leading with
 *  it wasted ~4s on two doomed attempts before every transcription fell back.
 *  2.5-flash answers on the first try; 3.5-flash stays as a fallback in case
 *  2.5 has a blip. Override the order with GEMINI_STT_MODEL /
 *  GEMINI_STT_FALLBACK_MODELS. */
function sttModels() {
  const primary = process.env.GEMINI_STT_MODEL || 'gemini-2.5-flash';
  const fallbacks = (process.env.GEMINI_STT_FALLBACK_MODELS || 'gemini-3.5-flash')
    .split(',').map((m) => m.trim()).filter(Boolean);
  return [primary, ...fallbacks.filter((m) => m !== primary)];
}

function isTransientSttError(err) {
  const status = err.response?.status;
  return status === 503 || status === 429 || status === 500
    || err.code === 'ECONNABORTED' || /timeout of/i.test(err.message || '');
}

/** Transcribe recorded speech (base64 audio). Returns the plain transcript. */
async function transcribe(base64Audio, mime = 'audio/wav') {
  assertKeyConfigured('stt');
  // A real transcription of a short clip comes back in 1-3s; the old 45s
  // timeout just meant an overloaded/hung model burned 45s (twice, with the
  // retry) — the 60-second spinner users hit. Fail each attempt fast (12s)
  // and move on. Total worst case stays well under the mobile client's 90s.
  const timeout = Number(process.env.GEMINI_STT_TIMEOUT_MS || 12000);
  const backoff = Number(process.env.GEMINI_STT_BACKOFF_MS || 400);
  const models = sttModels();

  const attempt = async (model) => {
    const { data } = await axios.post(
      `${BASE}/models/${model}:generateContent?key=${key()}`,
      {
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: mime, data: base64Audio } },
            { text: 'Transcribe this voice message verbatim. Return ONLY the transcript text — no quotes, no commentary. If there is no intelligible speech, return an empty string.' },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024 },
      },
      { timeout }
    );
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  };

  let lastErr = null;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const isLast = i === models.length - 1;
    // Only the LAST model is worth a same-model retry — when there's still a
    // fallback to try, falling to it immediately beats a backoff-then-retry on
    // a model that just failed (an overloaded model usually 503s again). This
    // is what keeps the happy path a single fast call.
    const maxTries = isLast ? 2 : 1;
    for (let tryNum = 0; tryNum < maxTries; tryNum++) {
      try {
        return await attempt(model);
      } catch (err) {
        lastErr = err;
        console.error(`[voice stt] ${model} failed (try ${tryNum + 1}/${maxTries}): ${err.message}`);
        // Non-transient (bad model id / malformed request) won't fix on retry —
        // skip straight to the next candidate model.
        if (!isTransientSttError(err)) break;
        if (tryNum < maxTries - 1 && backoff > 0) await sleep(backoff);
      }
    }
  }
  throw new Error(
    `STT failed after trying ${models.join(', ')}: ${lastErr?.response?.data?.error?.message || lastErr?.message}`
  );
}

/**
 * Compose the spoken script for a daily brief — what a chief of staff would
 * SAY, not the JSON read aloud. Pure; safe on partial content.
 */
function composeNarrationScript(content) {
  const cb = content?.chiefBrief;
  const parts = [];
  if (cb?.synthesis) parts.push(cb.synthesis);
  // Natural spoken connective tissue instead of "The action:" labels — the same
  // information, but it flows like a person talking, not headings read aloud.
  if (cb?.action) parts.push(`So here's the move today. ${cb.action}`);
  if (cb?.risk) parts.push(`One thing I'm keeping an eye on — ${cb.risk}`);
  if (cb?.move) parts.push(`And the thing that actually changed: ${cb.move}`);
  if (!parts.length && content?.morningFocus) parts.push(content.morningFocus);
  if (!parts.length) return '';
  return `Morning. Here's where you stand. ${parts.join(' ')} That's the picture — go have a good one.`.slice(0, 3800);
}

/**
 * Compose the spoken script for the evening wind-down brief — same "talk, don't
 * read labels aloud" approach as the morning narration. Pure; safe on partial content.
 */
function composeEveningNarrationScript(content) {
  const parts = [];
  if (content?.readiness) parts.push(content.readiness);
  if (content?.today) parts.push(content.today);
  if (content?.plan) parts.push(`On this morning's plan — ${content.plan}`);
  if (content?.tomorrow) parts.push(`For tonight: ${content.tomorrow}`);
  if (content?.habits) parts.push(content.habits);
  if (content?.reflection) parts.push(content.reflection);
  if (!parts.length) return '';
  return `Evening. ${parts.join(' ')} Rest well.`.slice(0, 3800);
}

/**
 * Compose the spoken script for the Wisdom tab's daily reflection — the
 * quote, the selected Notion passage, and (when present) a relevant library
 * highlight, each with its personalized insight, in that order. Pure; safe
 * on partial content. Deliberately narrow: never reads the full raw Notion
 * page (`content.notionText`), a URL, or the tab's separate generic
 * highlight list (`HighlightsCard`, unrelated to `relevantHighlight`) —
 * only the three already-curated, already-short fields a person would
 * actually want read aloud. Capped well below the other composers' 3800
 * chars: Wisdom's own target is a 60-90s briefing, not a full brief.
 */
function composeWisdomNarrationScript(content) {
  const parts = [];
  if (content?.quote && content?.quoteInsight) {
    parts.push(`Today's quote: "${content.quote}" ${content.quoteInsight}`);
  }
  if (content?.notionQuote && content?.notionInsight) {
    parts.push(`From your reading — "${content.notionQuote}" ${content.notionInsight}`);
  }
  const h = content?.relevantHighlight;
  if (h?.content) {
    const attribution = h.title ? `${h.title}${h.author ? `, by ${h.author}` : ''}` : (h.author || 'your library');
    const excerpt = String(h.content).trim().slice(0, 220);
    parts.push(
      h.reason
        ? `One more thing worth revisiting, from ${attribution}: "${excerpt}" ${h.reason}`
        : `One more thing worth revisiting, from ${attribution}: "${excerpt}"`
    );
  }
  if (!parts.length) return '';
  return `Here's today's wisdom. ${parts.join(' ')}`.slice(0, 1400);
}

/** Strip markdown for speech: an answer written for reading, spoken cleanly. */
function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

module.exports = {
  synthesize, transcribe, composeNarrationScript, composeEveningNarrationScript, composeWisdomNarrationScript,
  speakable, pcmToWav, DEFAULT_VOICE, ttsModels, TTS_CANDIDATES, probeTtsModelAvailability, checkTtsModelOverride,
  INTERACTIONS_URL,
};
