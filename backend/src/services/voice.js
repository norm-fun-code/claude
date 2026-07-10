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

  let lastErr = null;
  for (const model of ttsModels()) {
    try {
      const { data } = await axios.post(`${BASE}/models/${model}:generateContent?key=${key()}`, payload, {
        timeout: Number(process.env.GEMINI_TTS_TIMEOUT_MS || 60000),
      });
      const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part) throw new Error('no audio in TTS response');
      const pcm = Buffer.from(part.inlineData.data, 'base64');
      // Mime like "audio/L16;codec=pcm;rate=24000" — pull the rate if present.
      const rateMatch = String(part.inlineData.mimeType || '').match(/rate=(\d+)/);
      const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
      return { audio: pcmToWav(pcm, { sampleRate }), mime: 'audio/wav' };
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      // Try the next model only for "model doesn't exist" class failures.
      if (status !== 404 && status !== 400) break;
    }
  }
  throw new Error(`TTS failed: ${lastErr?.response?.data?.error?.message || lastErr?.message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** STT model candidates: the configured model first, then a more stable
 *  fallback. Gemini returns 503 "the model is overloaded" far more often for
 *  new/preview models than mature ones, and retrying the SAME overloaded model
 *  rarely helps — falling to a stable model is what actually recovers (per
 *  Gemini's own troubleshooting guidance). Mirrors the TTS fallback chain. */
function sttModels() {
  const primary = process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash';
  const fallbacks = (process.env.GEMINI_STT_FALLBACK_MODELS || 'gemini-2.5-flash')
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
  for (const model of models) {
    // Two quick tries per model with a short backoff (503 overload often
    // clears within a second — Google recommends short backoff), then move to
    // the next, more stable model rather than hammering an overloaded one.
    for (let tryNum = 0; tryNum < 2; tryNum++) {
      try {
        return await attempt(model);
      } catch (err) {
        lastErr = err;
        console.error(`[voice stt] ${model} failed (try ${tryNum + 1}/2): ${err.message}`);
        // Non-transient (bad model id / malformed request) won't fix on retry —
        // skip straight to the next candidate model.
        if (!isTransientSttError(err)) break;
        if (tryNum === 0 && backoff > 0) await sleep(backoff);
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
