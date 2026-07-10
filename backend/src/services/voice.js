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

async function synthesize(text, { voice = DEFAULT_VOICE, style } = {}) {
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
  const timeoutMs = Number(process.env.GEMINI_TTS_TIMEOUT_MS || 45000);
  const backoffMs = Number(process.env.GEMINI_TTS_BACKOFF_MS || 500);
  const models = ttsModels();

  const attempt = async (model) => {
    const { data } = await axios.post(`${BASE}/models/${model}:generateContent?key=${key()}`, payload, { timeout: timeoutMs });
    const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) throw new Error('no audio in TTS response');
    const pcm = Buffer.from(part.inlineData.data, 'base64');
    // Mime like "audio/L16;codec=pcm;rate=24000" — pull the rate if present.
    const rateMatch = String(part.inlineData.mimeType || '').match(/rate=(\d+)/);
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
    return { audio: pcmToWav(pcm, { sampleRate }), mime: 'audio/wav' };
  };

  let lastErr = null;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const isLast = i === models.length - 1;
    const maxTries = isLast ? 2 : 1;
    for (let tryNum = 0; tryNum < maxTries; tryNum++) {
      try {
        return await attempt(model);
      } catch (err) {
        lastErr = err;
        console.error(`[voice tts] ${model} failed (try ${tryNum + 1}/${maxTries}): ${err.message}`);
        if (!isTransientTtsError(err)) break;
        if (tryNum < maxTries - 1 && backoffMs > 0) await sleep(backoffMs);
      }
    }
  }
  throw new Error(`TTS failed: ${lastErr?.response?.data?.error?.message || lastErr?.message}`);
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
  synthesize, transcribe, composeNarrationScript, composeEveningNarrationScript, speakable, pcmToWav, DEFAULT_VOICE,
};
