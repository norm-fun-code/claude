// Voice for the chief of staff: neural TTS (brief narration + spoken answers)
// and STT (push-to-talk transcription), both via Gemini so no new API accounts
// are needed. Swap the voice/model via env without code changes:
//   NORMOS_VOICE       — Gemini prebuilt voice name (default 'Charon')
//   GEMINI_TTS_MODEL   — TTS model override
const axios = require('axios');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

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
function ttsModels() {
  const fromEnv = process.env.GEMINI_TTS_MODEL;
  const candidates = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts', 'gemini-3.5-flash-tts'];
  return fromEnv ? [fromEnv, ...candidates.filter((m) => m !== fromEnv)] : candidates;
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
// Fixed by shrinking BOTH numbers: a short per-model timeout so a bad model
// fails fast enough that the loop can actually try its fallbacks within the
// budget, and a shorter overall deadline that leaves real margin under the
// client's terminal timeout instead of racing it to the wire.
const OVERALL_TIMEOUT_MS = Number(process.env.GEMINI_TTS_OVERALL_TIMEOUT_MS || 40000);

async function synthesize(text, { voice = DEFAULT_VOICE, style } = {}) {
  assertKeyConfigured('tts');
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('nothing to synthesize');
  const directive = style || process.env.NORMOS_VOICE_STYLE ||
    'Speak naturally with a warm, calm, optimistic tone. Sound like a trusted friend who is genuinely excited to help. ' +
    'Keep responses conversational and concise. Never sound robotic, overly enthusiastic, or like a customer support agent. ' +
    'Use occasional humor and warmth. Pause naturally. Celebrate wins without exaggeration.';
  const payload = {
    contents: [{ parts: [{ text: `${directive}:\n\n${trimmed.slice(0, 4000)}` }] }],
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
  // 8s per attempt is deliberately short: a healthy TTS call for a script
  // this size (composeWisdomNarrationScript caps at 1400 chars) normally
  // returns in low single-digit seconds, so 8s already means "something is
  // wrong with this model" rather than "give it more time." With
  // OVERALL_TIMEOUT_MS=40000, that's enough budget for all 3 candidate
  // models PLUS the last one's retry (4 attempts × 8s + one backoff ≈
  // 32.5s) to actually run within the deadline, instead of the old math
  // where one bad attempt alone could eat the whole budget.
  const timeoutMs = Number(process.env.GEMINI_TTS_TIMEOUT_MS || 8000);
  const backoffMs = Number(process.env.GEMINI_TTS_BACKOFF_MS || 500);
  const models = ttsModels();
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;

  const attempt = async (model) => {
    // Each individual attempt is capped at whichever is SMALLER: its own
    // per-call budget, or whatever's actually left of the overall deadline
    // — so a slow first attempt can't single-handedly blow through the
    // total budget before the loop even gets a chance to check it again.
    const remaining = deadline - Date.now();
    const { data } = await axios.post(`${BASE}/models/${model}:generateContent?key=${key()}`, payload, { timeout: Math.max(1000, Math.min(timeoutMs, remaining)) });
    const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) throw new Error('no audio in TTS response');
    const pcm = Buffer.from(part.inlineData.data, 'base64');
    // Mime like "audio/L16;codec=pcm;rate=24000" — pull the rate if present.
    const rateMatch = String(part.inlineData.mimeType || '').match(/rate=(\d+)/);
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
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
      try {
        return await attempt(model);
      } catch (err) {
        lastErr = err;
        console.error(`[voice tts] ${model} failed (try ${tryNum + 1}/${maxTries}): ${err.message}`);
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
  speakable, pcmToWav, DEFAULT_VOICE,
};
