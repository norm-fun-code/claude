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

/**
 * Mint an ephemeral client secret scoped to one Realtime session. `instructions`
 * and `tools` are baked into the session at mint time so the client doesn't
 * have to (and can't be trusted to) assemble its own system prompt or tool
 * allowlist — session.update on the client can still adjust turn-taking, but
 * the tool set and base instructions are set here, server-side.
 *
 * @param {{ instructions: string, tools: Array<object>, voice?: string, model?: string }} opts
 * @returns {Promise<{ clientSecret: string, expiresAt: number|null, model: string, voice: string }>}
 */
async function createEphemeralSession({ instructions, tools = [], voice = DEFAULT_VOICE, model = DEFAULT_MODEL } = {}) {
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
          // changes. See mobile/src/lib/realtimeVoice.ts's transcript handling.
          transcription: { model: process.env.REALTIME_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe' },
          turn_detection: {
            type: 'semantic_vad',
            // Interrupt the model's own audio the instant the user starts
            // talking over it — this IS the barge-in requirement; without it
            // the server would wait for the model to finish before noticing
            // the new user turn.
            interrupt_response: true,
          },
        },
      },
      tools,
    },
  };

  const { data } = await axios.post(`${BASE}/realtime/client_secrets`, payload, {
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
    timeout: timeoutMs,
  });

  const clientSecret = data?.value ?? data?.client_secret?.value ?? null;
  if (!clientSecret) throw new Error('no client secret in OpenAI response');
  return {
    clientSecret,
    expiresAt: data?.expires_at ?? data?.client_secret?.expires_at ?? null,
    model,
    voice,
  };
}

module.exports = { createEphemeralSession, isConfigured, DEFAULT_MODEL, DEFAULT_VOICE };
