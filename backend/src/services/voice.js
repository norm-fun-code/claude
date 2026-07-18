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

// TTS ENDPOINT — REVERTED to GenerateContent, the API the Gemini SDKs
// actually use for speech.
//
// History (the whole painful arc, so this doesn't get "fixed" wrong again):
//  - Originally TTS ran on GenerateContent (POST .../models/{model}:generateContent
//    with responseModalities:['AUDIO'] + speechConfig) and Chief narration
//    WORKED, with gemini-2.5-flash-preview-tts as the primary model.
//  - When Wisdom Listen was added, a SECOND full prewarm fired concurrently
//    with Chief's — two overlapping TTS calls, each timing out at 25s. That
//    RESOURCE CONTENTION (now fixed by the process-wide gate in
//    services/brief-audio.js) was the real regression.
//  - It was mis-diagnosed as a wrong-endpoint problem and migrated to a
//    "/v1beta/interactions" API sourced from unverifiable doc-scraping.
//    Deployed, EVERY serialized (uncontended) call to that endpoint hung
//    with ECONNABORTED — Google never responded at all. The authoritative
//    google-genai Python SDK (_SpeechConfig_to_mldev, response_modalities
//    on generate_content) and the JS SDK confirm TTS is served through
//    generateContent, with NO interactions endpoint. So that migration is
//    reverted here in full.
//
// KEY behavioral property this restores: on GenerateContent a bad model
// FAILS FAST (a 404/400 in well under a second), so the fallback chain
// moves on immediately. The interactions endpoint instead HUNG for the
// full per-attempt timeout on every model, which is what made every
// "Listen" tap sit for ~25s and then show Unavailable.
//
// STT (transcribe() below) always used GenerateContent and is untouched.

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

// Primary + fallback so a retired preview model degrades gracefully instead
// of killing narration until someone edits env vars.
//
// gemini-2.5-flash-preview-tts is PRIMARY: it is the exact model that was
// primary (on GenerateContent) the last time Chief narration is confirmed
// to have worked in production — before Wisdom Listen introduced the
// concurrent-prewarm contention regression (git: commit bd2b8ab). Its
// documented pro sibling gemini-2.5-pro-preview-tts follows as a fallback.
//
// Deliberately EXCLUDES gemini-3.1-flash-tts-preview: production Railway
// logs showed it HANGING on GenerateContent (a full ~25s timeout, not a
// fast 404) — a model that hangs rather than fails-fast poisons the whole
// fallback budget if it's reached, and it never once produced audio on
// either endpoint we tried. An operator can still force any specific model
// (including 3.1, or a newer one) at runtime via GEMINI_TTS_MODEL without a
// code deploy — see ttsModels().
const TTS_CANDIDATES = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'];

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
      `Unset GEMINI_TTS_MODEL or point it at a real TTS model (e.g. gemini-2.5-flash-preview-tts).`
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
  // The delivery style is PURE PROSODY description — no "responses",
  // "help", "conversational" or other chat-assistant language. Live bug
  // (the exact one this rewrite fixes): the previous directive said things
  // like "Keep responses conversational and concise" / "Sound like a
  // trusted friend who is genuinely excited to help", which the TTS model
  // read as an instruction to GENERATE a conversational response rather
  // than read the transcript aloud. Gemini's own 400 said so verbatim:
  // "Model tried to generate text, but it should only be used for TTS.
  // Make sure your instructions are clear to only generate audio from the
  // transcript." Under the AUDIO-only response modality that manifests as
  // either that 400 OR a hang (the model tries to voice a long generated
  // response until the client times out) — which is what produced the
  // "everything ECONNABORTED at 25s" logs.
  const directive = style || process.env.NORMOS_VOICE_STYLE ||
    'a warm, calm, optimistic tone with natural pacing and gentle warmth; never robotic, never over-enthusiastic, never like a customer-support agent';
  // GenerateContent TTS request shape (responseModalities:['AUDIO'] +
  // speechConfig). The prompt is now an UNAMBIGUOUS read-aloud instruction:
  // the style is explicitly labelled as delivery guidance, and the model is
  // told in plain terms to speak ONLY the transcript, verbatim, adding
  // nothing — exactly what Gemini's 400 asked for. The transcript is fenced
  // on its own lines so its boundary is unmistakable.
  const promptText =
    `Read the following transcript aloud as natural speech, in ${directive}. ` +
    `Speak only the transcript, word for word, exactly as written. ` +
    `Do not reply to it, summarize it, describe it, or add any words of your own.\n\n` +
    `Transcript:\n${trimmed.slice(0, 4000)}`;
  const payload = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
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
    // GenerateContent (the reverted, SDK-authoritative TTS endpoint — see this
    // file's header). x-goog-api-key header, never the key in the URL query
    // string (so it can't leak into a logged request URL). The audio comes
    // back inline as base64 PCM under candidates[0].content.parts[].inlineData.
    const { data } = await axios.post(
      `${BASE}/models/${model}:generateContent`,
      payload,
      {
        timeout: Math.max(1000, Math.min(timeoutMs, remaining)),
        headers: { 'x-goog-api-key': key(), 'Content-Type': 'application/json' },
      }
    );
    const elapsedMs = Date.now() - attemptStart;
    const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) throw new Error('no audio in TTS response');
    const pcm = Buffer.from(part.inlineData.data, 'base64');
    // Mime like "audio/L16;codec=pcm;rate=24000" — pull the rate if present;
    // Gemini TTS defaults to 24kHz mono PCM otherwise.
    const rateMatch = String(part.inlineData.mimeType || '').match(/rate=(\d+)/);
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
    console.log(`[voice tts] endpoint=generateContent model=${model} status=200 elapsedMs=${elapsedMs}`);
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
        console.error(`[voice tts] endpoint=generateContent model=${model} status=${status} errCode=${err.code || 'n/a'} try=${tryNum + 1}/${maxTries} elapsedMs=${elapsedMs}: ${err.message}${detail ? ` — ${detail}` : ''}`);
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
};
