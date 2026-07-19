// OpenAI TTS provider — the provider-neutral counterpart to services/voice.js's
// Gemini TTS. Uses the SAME OPENAI_API_KEY already configured for Realtime
// voice mode (services/realtime.js) — no new secret to provision. See
// services/ttsProvider.js for the router that decides which provider runs
// first and orchestrates the bounded-budget fallback between the two.
//
// Why this exists: production evidence showed gemini-2.5-flash-preview-tts
// and gemini-2.5-pro-preview-tts both stalling for the full per-attempt
// timeout on a fresh Wisdom cache miss (a real, non-trivial script), while
// working the previous night — both are PREVIEW models, and Gemini's own
// generateContent TTS path has no streaming option, so a slow/overloaded
// generation has no way to signal progress before the timeout fires. OpenAI's
// /v1/audio/speech is a mature, non-preview endpoint; the router prefers it
// once a live probe confirms it works for this key, and keeps Gemini as a
// bounded fallback rather than removing it.
'use strict';

const axios = require('axios');
const { redactKeyFragments } = require('./realtime');

const BASE = 'https://api.openai.com/v1/audio/speech';

function key() {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error('OPENAI_API_KEY not set');
  return k;
}

function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
}

// gpt-4o-mini-tts is OpenAI's current-generation TTS model, served through
// the same /v1/audio/speech endpoint as the older tts-1/tts-1-hd — preferred
// per the audit brief ("prefer gpt-4o-mini-tts... if the configured project
// supports it"). Override with OPENAI_TTS_MODEL for a project that doesn't
// have access to it (e.g. fall back to 'tts-1').
const DEFAULT_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
// One of OpenAI's built-in voices. 'alloy' is the long-standing, universally
// available default; override with OPENAI_TTS_VOICE.
const DEFAULT_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';
// 'wav' matches Gemini's existing wire format exactly (see voice.js's
// pcmToWav) — the default configuration needs no mobile client change.
// mp3/aac/flac/opus are also valid (OpenAI's own response_format options)
// for an operator who wants smaller payloads; mobile/src/lib/voice.ts's
// playBase64 picks the right file extension from the returned mime either
// way (see its format-aware extension map).
const DEFAULT_FORMAT = (process.env.OPENAI_TTS_FORMAT || 'wav').toLowerCase();
const MIME_FOR_FORMAT = {
  wav: 'audio/wav', mp3: 'audio/mpeg', opus: 'audio/opus', aac: 'audio/aac', flac: 'audio/flac',
};

// Bounded per-attempt ceiling. The router (ttsProvider.js) may pass a
// SMALLER budgetMs derived from whatever's actually left of the shared
// overall deadline (see computeProviderBudget) — this constant is only the
// ceiling a call may use, never a guarantee it gets this long.
const DEFAULT_TIMEOUT_MS = Number(process.env.OPENAI_TTS_TIMEOUT_MS || 12000);

function mimeFor(format) {
  return MIME_FOR_FORMAT[format] || 'audio/mpeg';
}

/** Best-effort extraction of OpenAI's JSON error message from an axios error
 *  whose response body was fetched as an ArrayBuffer (responseType:
 *  'arraybuffer' applies to error responses too) — never throws. */
function errorDetailFromBuffer(err) {
  try {
    const buf = err.response?.data;
    if (!buf) return null;
    const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
    return parsed?.error?.message || null;
  } catch {
    return null;
  }
}

/**
 * Synthesize speech via OpenAI's Speech API. Returns { audio: Buffer, mime, model }.
 * `budgetMs`, when given, caps this ONE call's timeout (the router uses this
 * to enforce a shared overall deadline across providers) — otherwise falls
 * back to OPENAI_TTS_TIMEOUT_MS. Never logs the key or the transcript text —
 * only script length, model, status, and elapsed time.
 */
async function synthesize(text, { voice = DEFAULT_VOICE, model = DEFAULT_MODEL, format = DEFAULT_FORMAT, budgetMs } = {}) {
  if (!isConfigured()) throw new Error('OPENAI_API_KEY not set');
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('nothing to synthesize');
  const timeout = Math.max(1000, Math.min(DEFAULT_TIMEOUT_MS, budgetMs ?? DEFAULT_TIMEOUT_MS));
  const t0 = Date.now();
  try {
    const res = await axios.post(
      BASE,
      { model, voice, input: trimmed.slice(0, 4096), response_format: format },
      {
        timeout,
        responseType: 'arraybuffer',
        headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      }
    );
    const audio = Buffer.from(res.data);
    console.log(`[voice tts] provider=openai endpoint=audio/speech model=${model} status=200 scriptChars=${trimmed.length} elapsedMs=${Date.now() - t0} audioBytes=${audio.length}`);
    return { audio, mime: mimeFor(format), model };
  } catch (err) {
    const status = err.response?.status ?? (err.code === 'ECONNABORTED' || /timeout of/i.test(err.message || '') ? 'timeout' : 'unknown');
    const detail = redactKeyFragments(errorDetailFromBuffer(err) || err.message || 'unknown error');
    console.error(`[voice tts] provider=openai endpoint=audio/speech model=${model} status=${status} errCode=${err.code || 'n/a'} scriptChars=${trimmed.length} elapsedMs=${Date.now() - t0}: ${detail}`);
    const wrapped = new Error(`OpenAI TTS failed: ${detail}`);
    wrapped.status = status;
    wrapped.code = err.code;
    throw wrapped;
  }
}

/**
 * Live, bounded probe: one tiny real synthesis call, so a diagnostic can
 * confirm OpenAI's Speech API is actually reachable/authorized/working for
 * this key and model — never a large or paid-heavy call. Never throws;
 * reports a plain result object. Mirrors services/voice.js's
 * probeTtsModelAvailability()'s "never logs the key, never throws" contract.
 */
async function probe(budgetMs = 8000) {
  if (!isConfigured()) return { ok: false, configured: false, error: 'OPENAI_API_KEY not set' };
  const t0 = Date.now();
  try {
    const out = await synthesize('This is a short narration test.', { budgetMs });
    return { ok: true, configured: true, provider: 'openai', model: out.model, elapsedMs: Date.now() - t0, audioBytes: out.audio.length };
  } catch (err) {
    return {
      ok: false, configured: true, provider: 'openai', model: DEFAULT_MODEL,
      elapsedMs: Date.now() - t0, status: err.status ?? null, errCode: err.code ?? null, error: err.message,
    };
  }
}

module.exports = {
  synthesize, probe, isConfigured, mimeFor,
  DEFAULT_MODEL, DEFAULT_VOICE, DEFAULT_FORMAT, DEFAULT_TIMEOUT_MS,
};
