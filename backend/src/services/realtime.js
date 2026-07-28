// OpenAI Realtime API — server-side half only. The mobile client connects
// directly to OpenAI over WebRTC (that's the point of an ephemeral token: no
// audio proxy through us), so this module's ONLY job is minting a short-lived
// client secret the mobile app can safely hold. The permanent OPENAI_API_KEY
// never reaches the client.
//
// Model/voice are env-overridable so a bad rollout or a better voice choice
// doesn't need a redeploy of anything but env: REALTIME_MODEL, REALTIME_VOICE.
const axios = require('axios');

const BASE = 'https://api.openai.com/v1';

function key() {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error('OPENAI_API_KEY not set');
  return k;
}

function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

const DEFAULT_MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-2.1';
const DEFAULT_VOICE = process.env.REALTIME_VOICE || 'cedar';
// Phantom-turn hardening: background noise/echo transcribed as a tiny
// foreign-language utterance (e.g. "お願いします。") was being treated as a
// real user turn. Pinning the transcriber to the expected spoken language
// sharply cuts how often noise gets hallucinated into SOME language's words
// at all — and mobile's transcriptGuard.ts's script check (English-session
// only) needs to know what language it's guarding, so this is exported
// alongside the session config, not just inlined below.
const DEFAULT_TRANSCRIBE_LANGUAGE = process.env.REALTIME_TRANSCRIBE_LANGUAGE || 'en';

/**
 * Mint an ephemeral client secret scoped to one Realtime session. `instructions`
 * and `tools` are baked into the session at mint time so the client doesn't
 * have to (and can't be trusted to) assemble its own system prompt or tool
 * allowlist — session.update on the client can still adjust turn-taking, but
 * the tool set and base instructions are set here, server-side.
 *
 * `language` lets an individual session request a non-default transcription
 * language (the unified voice-session contract's `language` field) — falls
 * back to DEFAULT_TRANSCRIBE_LANGUAGE (still 'en' unless overridden by env)
 * when omitted, so the phantom-noise mitigation this locks in place stays
 * the default behavior for every caller that doesn't explicitly ask for a
 * different language.
 *
 * @param {{ instructions: string, tools: Array<object>, voice?: string, model?: string, language?: string }} opts
 * @returns {Promise<{ clientSecret: string, expiresAt: number|null, model: string, voice: string, language: string }>}
 */
async function createEphemeralSession({ instructions, tools = [], voice = DEFAULT_VOICE, model = DEFAULT_MODEL, language } = {}) {
  const transcribeLanguage = typeof language === 'string' && language.trim() ? language.trim() : DEFAULT_TRANSCRIBE_LANGUAGE;
  const timeoutMs = Number(process.env.REALTIME_SESSION_TIMEOUT_MS || 10000);
  const payload = {
    session: {
      type: 'realtime',
      model,
      instructions,
      audio: {
        output: { voice },
        input: {
          // Input transcription is OFF by default on the Realtime API — without
          // it, the `conversation.item.input_audio_transcription.completed`
          // event never fires, so the user's spoken words would never appear
          // in the live transcript AND a spoken turn could never be persisted
          // to the shared Ask thread (the client keys persistence off the user
          // transcript). Model is env-overridable in case the default name
          // changes. `language` pins the transcriber to the expected spoken
          // language (env-overridable via REALTIME_TRANSCRIBE_LANGUAGE) — a
          // major contributor to noise/echo getting hallucinated into a
          // random short foreign-language "word" in the first place. See
          // mobile/src/lib/realtimeVoice.ts's transcript handling and
          // transcriptGuard.ts's pre-response validation.
          transcription: {
            model: process.env.REALTIME_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
            language: transcribeLanguage,
          },
          // near_field assumes the mic is close to the speaker's mouth (a phone
          // held/worn during the call, not a conference-room far mic) — the
          // right profile for this app and a real reduction in the ambient
          // noise/echo that was getting transcribed as phantom speech.
          noise_reduction: { type: 'near_field' },
          turn_detection: {
            type: 'semantic_vad',
            // Low eagerness biases the VAD toward waiting for a more
            // confident end-of-turn read rather than firing on every brief
            // pause or noise blip — fewer spurious "turns" reaching
            // transcription at all.
            eagerness: 'low',
            // The client (realtimeVoice.ts) now owns response creation: it
            // only sends response.create AFTER a spoken transcript passes the
            // pre-response validation gate (transcriptGuard.ts). If the
            // server auto-created a response the instant VAD detected
            // end-of-turn (the previous, implicit default), unvalidated noise
            // could still trigger a full response — and a tool call — before
            // the client ever got a chance to judge the transcript.
            create_response: false,
            // Likewise, automatic interrupt_response let ANY VAD-detected
            // speech_started truncate the assistant's audio instantly — a
            // stray noise blip could cut off a real answer before validation
            // even ran. Barge-in is still preserved, just moved client-side:
            // a short duration-gated cancellation (bargeInGate.ts) only
            // interrupts once user speech has actually sustained past a brief
            // threshold, not on the first instant of detected audio energy.
            interrupt_response: false,
          },
        },
      },
      tools,
    },
  };

  let data;
  try {
    ({ data } = await axios.post(`${BASE}/realtime/client_secrets`, payload, {
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    }));
  } catch (err) {
    throw classifyError(err);
  }

  const clientSecret = data?.value ?? data?.client_secret?.value ?? null;
  if (!clientSecret) {
    const e = new Error('no client secret in OpenAI response');
    e.reason = 'session_mint_failed';
    throw e;
  }
  return {
    clientSecret,
    expiresAt: data?.expires_at ?? data?.client_secret?.expires_at ?? null,
    model,
    voice,
    language: transcribeLanguage,
  };
}

// OpenAI's own error messages for an auth failure commonly echo back a
// MASKED fragment of the key that was actually sent (e.g. "Incorrect API
// key provided: sk-proj-AbCd...XyZ9") — real key-prefix/suffix characters,
// even if partially redacted by OpenAI itself. "Never expose the key" means
// never propagating that fragment either, so every provider message is
// scrubbed of anything key-shaped before it's kept anywhere (server logs,
// the admin diagnostic endpoint) — not just before reaching the client.
function redactKeyFragments(text) {
  return String(text || '').replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[redacted]');
}

/**
 * Turn an axios error from the OpenAI call into one of the documented reason
 * codes, carrying ONLY safe diagnostic fields (HTTP status, provider error
 * type/code, a message) — never the request/response body, never any header,
 * never the key (or a masked fragment of it — see redactKeyFragments).
 * Pure and exported for unit testing without a network call.
 */
function classifyError(err) {
  const status = err.response?.status ?? null;
  const body = err.response?.data?.error ?? {};
  const providerCode = body.code ?? null;
  const providerType = body.type ?? null;
  const providerParam = body.param ?? null;
  const providerMessage = redactKeyFragments(body.message ?? err.message ?? 'unknown error');

  let reason;
  if (!status) {
    // No HTTP response at all — DNS failure, connection refused, or our own
    // timeout (err.code === 'ECONNABORTED'). Never a provider-classified error.
    reason = 'network_failure';
  } else if (status === 401) {
    reason = 'openai_auth_failed';
  } else if (status === 403) {
    reason = 'openai_access_denied';
  } else if (
    status === 404 ||
    providerCode === 'model_not_found' ||
    /model/i.test(String(providerParam || '')) ||
    /model/i.test(String(providerCode || ''))
  ) {
    reason = 'invalid_realtime_model';
  } else {
    reason = 'session_mint_failed';
  }

  const classified = new Error(providerMessage);
  classified.reason = reason;
  classified.providerStatus = status;
  classified.providerCode = providerCode;
  classified.providerType = providerType;
  return classified;
}

module.exports = { createEphemeralSession, isConfigured, classifyError, redactKeyFragments, DEFAULT_MODEL, DEFAULT_VOICE, DEFAULT_TRANSCRIBE_LANGUAGE };
