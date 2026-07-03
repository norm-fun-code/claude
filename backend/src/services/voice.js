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
async function synthesize(text, { voice = process.env.NORMOS_VOICE || 'Charon', style } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('nothing to synthesize');
  const directive = style || process.env.NORMOS_VOICE_STYLE ||
    "You are the user's chief of staff reading this to them one-on-one — warm, sharp, and genuinely on their side. " +
    'Deliver it like a trusted friend who happens to be brilliant with their data: an easy, unhurried conversational pace, ' +
    'natural warmth, real emphasis on the words that matter, a beat of pause between thoughts, and a touch of dry wit when a line invites it. ' +
    'Not a newsreader, not chirpy, not robotic — a calm, confident, present human who is glad to be talking to them';
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

/** Transcribe recorded speech (base64 audio). Returns the plain transcript. */
async function transcribe(base64Audio, mime = 'audio/wav') {
  const model = process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash';
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
    { timeout: Number(process.env.GEMINI_STT_TIMEOUT_MS || 45000) }
  );
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return text;
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

/** Strip markdown for speech: an answer written for reading, spoken cleanly. */
function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

module.exports = { synthesize, transcribe, composeNarrationScript, speakable, pcmToWav };
