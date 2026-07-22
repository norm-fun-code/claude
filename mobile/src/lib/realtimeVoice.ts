// Talk to NormOS — the live OpenAI Realtime voice session manager.
//
// Connects the mobile client DIRECTLY to OpenAI over WebRTC (that's the
// point of the ephemeral secret our backend mints: no audio proxy through
// us). This module owns the peer connection, the mic track, the "oai-events"
// data channel, and the tool-call relay (OpenAI's function-call events land
// on THIS client's data channel, not the backend's — so tool execution is
// relayed to our backend over plain HTTP, and the result is sent back to
// OpenAI over the SAME data channel).
//
// Guarded import (same pattern as lib/voice.ts's expo-av guard): react-native-
// webrtc is a NEW native module this JS bundle may run against a binary that
// doesn't have yet (until the next EAS dev-client build). A top-level import
// would crash the whole app on an OTA update to older binaries — everything
// loads via try/catch, and callers hide the "Talk to NormOS" entry point
// when `realtimeVoiceAvailable` is false.
let WebRTC: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  WebRTC = require('react-native-webrtc');
} catch {
  WebRTC = null;
}

export const realtimeVoiceAvailable: boolean = !!(WebRTC?.RTCPeerConnection && WebRTC?.mediaDevices);

// Bug: assistant audio played back very quietly even at full device volume.
// react-native-webrtc configures iOS's AVAudioSession as category
// `playAndRecord` / mode `voiceChat` by default — the mode built for a private
// phone call, which iOS routes to the EARPIECE receiver (quiet, held-to-ear
// volume), not the loud bottom-firing speaker. Talk to NormOS is a hands-free
// conversation, not a phone call, so it needs the speaker explicitly forced
// on. react-native-incall-manager (maintained by the same org as
// react-native-webrtc — the standard companion for exactly this) does that.
// Same guarded-import pattern as WebRTC above: a NEW native module the JS
// bundle may run against a binary that doesn't have it yet, so a missing
// module degrades to today's (quiet) behavior instead of crashing.
let InCallManager: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  InCallManager = require('react-native-incall-manager').default;
} catch {
  InCallManager = null;
}

import {
  REALTIME_SESSION_URL,
  REALTIME_TOOL_URL,
  REALTIME_TURN_URL,
  REALTIME_METRIC_URL,
  REALTIME_CALLS_URL,
  authHeaders,
  fetchWithTimeout,
} from '../config';
import { decideSpokenTurn } from './realtimeTurnGate';
import { createBargeInGate, BargeInGate } from './bargeInGate';

export type RealtimeState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'executing' | 'error';

export interface RealtimeHandlers {
  onStateChange?: (state: RealtimeState) => void;
  /** Fires as transcript text streams in for either side. `final` marks a
   *  completed utterance — that's the moment to append it to a transcript list. */
  onTranscript?: (role: 'user' | 'assistant', text: string, final: boolean) => void;
  /** A tool is about to run (e.g. show "checking your recovery…" or "let me
   *  look across your history…" as a UI cue while it resolves). */
  onToolStart?: (name: string) => void;
  onError?: (message: string) => void;
  /** Fires once a turn has actually been persisted to the shared Ask thread
   *  (or was already persisted server-side by deep_ask) — the right moment
   *  for a caller to resync its own copy of that thread, as opposed to
   *  onTranscript's 'final' flag, which only means the TEXT is complete, not
   *  that it has been saved. */
  onTurnPersisted?: () => void;
}

type PendingCall = { name: string; argsText: string };

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const ICE_GATHER_TIMEOUT_MS = 4000;

/** Wait for local ICE gathering to finish (or time out) so the single SDP
 *  offer we send OpenAI carries every local candidate — this exchange is a
 *  one-shot HTTP POST, not a trickle-ICE signaling channel. */
function waitForIceGatheringComplete(pc: any, timeoutMs = ICE_GATHER_TIMEOUT_MS): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener?.('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener?.('icegatheringstatechange', onChange);
    setTimeout(finish, timeoutMs);
  });
}

async function postJson(url: string, body: unknown, timeoutMs = 15000) {
  const res = await fetchWithTimeout(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) }, timeoutMs);
  if (!res.ok) throw new Error(`Server ${res.status}`);
  return res.json();
}

function logMetric(sessionId: string, type: string, valueMs?: number, meta?: Record<string, unknown>) {
  postJson(REALTIME_METRIC_URL, { sessionId, type, valueMs, meta }, 8000).catch(() => {});
}

/**
 * One live Talk-to-NormOS session. Usage:
 *   const session = new RealtimeVoiceSession(handlers);
 *   await session.start();
 *   ...
 *   session.stop();
 */
export class RealtimeVoiceSession {
  private pc: any = null;
  private dc: any = null;
  private localStream: any = null;
  private sessionId: string | null = null;
  private model: string | null = null;
  /** Spoken language the transcriber was configured for (from the session
   *  mint response — mirrors backend's REALTIME_TRANSCRIBE_LANGUAGE). Governs
   *  whether transcriptGuard's script check applies. Defaults to 'en' so a
   *  session response that omits it (older backend) still gets the guard. */
  private language = 'en';
  private handlers: RealtimeHandlers;
  private state: RealtimeState = 'idle';
  private startedAt = 0;
  private speechStoppedAt: number | null = null;
  /** VAD speech_started timestamp for the CURRENT turn — paired with
   *  speechStoppedAt to compute a captured speech duration for
   *  transcriptGuard's implausibly-short-noise-turn check. */
  private turnSpeechStartedAt: number | null = null;
  private firstAudioLogged = false;
  private pendingCalls = new Map<string, PendingCall>();
  private turnUserText = '';
  private turnAssistantText = '';
  private turnUserFinal = false;
  private turnAssistantFinal = false;
  private turnUsedDeepAsk = false;
  private turnPersisted = false;
  private muted = false;
  /** Duration-gated barge-in cancellation (see bargeInGate.ts) — replaces
   *  the server's automatic interrupt_response, which the session no longer
   *  sets, so a stray noise blip can't cut off assistant audio before a
   *  turn is validated. */
  private bargeInGate: BargeInGate = createBargeInGate();
  /** Realtime conversation item_ids already handled by the transcription-
   *  completed handler — makes that handler idempotent so a duplicate
   *  completion event (a delivery replay, not a new turn) can never create a
   *  second response or a second reject/delete cycle for the same item. */
  private processedItemIds = new Set<string>();
  /** Set true at the start of stop() — checked after every `await` in a
   *  data-channel event handler so a message that finishes resolving AFTER
   *  the user ended the session never touches a torn-down dc/pc. */
  private stopped = false;

  constructor(handlers: RealtimeHandlers = {}) {
    this.handlers = handlers;
  }

  private setState(s: RealtimeState) {
    this.state = s;
    this.handlers.onStateChange?.(s);
  }

  /** Mint a session from our backend and negotiate the WebRTC connection.
   *  Throws with `.fallback === true` when the caller should fall back to
   *  the old push-to-talk path (Realtime disabled, OpenAI not configured, or
   *  the mint call itself failed) rather than showing a hard error. */
  async start(): Promise<void> {
    if (!realtimeVoiceAvailable) {
      // Defensive only — the UI hides its entry point via this same flag, so
      // this path shouldn't be reachable in practice.
      const err: any = new Error('react-native-webrtc not available in this build');
      err.code = 'session_mint_failed';
      err.fallback = true;
      throw err;
    }
    this.startedAt = Date.now();
    this.setState('connecting');

    let session: { sessionId: string; clientSecret: string; model: string; language?: string };
    try {
      const res = await fetchWithTimeout(REALTIME_SESSION_URL, { method: 'POST', headers: authHeaders(), body: '{}' }, 15000);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // The backend already classified WHY the mint failed (see routes/
        // realtime.js) — carry that stable reason code through so the UI can
        // show a specific, useful message instead of one generic string for
        // every failure mode.
        const err: any = new Error(body.error || `Server ${res.status}`);
        err.code = body.error || 'session_mint_failed';
        err.fallback = body.fallback !== false;
        throw err;
      }
      session = await res.json();
    } catch (err: any) {
      this.setState('error');
      // No `.code` at this point means fetch() itself threw before a response
      // ever came back (timeout, DNS failure, offline) — a real network
      // failure, distinct from the backend explicitly reporting a reason.
      if (!err.code) err.code = 'network_failure';
      if (err.fallback === undefined) err.fallback = true;
      throw err;
    }
    this.sessionId = session.sessionId;
    this.model = session.model;
    this.language = session.language || 'en';

    try {
      // Force loud-speaker routing before any audio track exists — must run
      // before getUserMedia/peer setup, since webrtc's own audio-session
      // config (defaulting to the quiet earpiece route) activates as soon as
      // the mic track and connection come up.
      try {
        InCallManager?.start({ media: 'audio' });
        InCallManager?.setForceSpeakerphoneOn(true);
      } catch { /* module present but native call failed — keep going, worst case stays quiet */ }

      const { RTCPeerConnection, mediaDevices } = WebRTC;
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      this.pc = pc;

      this.localStream = await mediaDevices.getUserMedia({ audio: true, video: false });
      // A concurrent stop() (fast double-tap End, or the caller retrying
      // before this resolves) already tore down pc — don't keep configuring
      // a connection nobody holds a reference to anymore.
      if (this.stopped) { this.teardownPeer(); return; }
      this.localStream.getTracks().forEach((track: any) => pc.addTrack(track, this.localStream));

      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.onmessage = (e: any) => this.handleEvent(e);
      dc.onopen = () => {
        logMetric(this.sessionId!, 'connect', Date.now() - this.startedAt);
        this.setState('listening');
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          this.handlers.onError?.('Connection lost.');
          logMetric(this.sessionId!, 'reconnect', undefined, { state: pc.connectionState });
        }
      };

      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);
      if (this.stopped) { this.teardownPeer(); return; }

      const sdpRes = await fetch(`${REALTIME_CALLS_URL}?model=${encodeURIComponent(session.model)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.clientSecret}`, 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
      });
      if (!sdpRes.ok) {
        const err: any = new Error(`OpenAI WebRTC handshake failed (${sdpRes.status})`);
        err.code = 'webrtc_handshake_failed';
        err.fallback = true;
        throw err;
      }
      const answerSdp = await sdpRes.text();
      if (this.stopped) { this.teardownPeer(); return; }
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      // Remote (assistant) audio plays automatically once the track arrives —
      // react-native-webrtc routes an audio-only remote track through the
      // native audio session without needing a visible <RTCView>.
    } catch (err: any) {
      // A partial connect (mic acquired, SDP exchange failed, etc.) must not
      // leak an open peer connection or a live mic track — tear down
      // whatever got created before rethrowing so the caller's retry starts
      // clean instead of stacking connections/mic handles on every attempt.
      this.teardownPeer();
      this.setState('error');
      // Anything reaching here without an explicit code (e.g. getUserMedia
      // rejecting on a denied mic permission, an ICE failure) is bucketed as
      // a handshake failure — the closest fit among the documented reasons
      // for "something about setting up the live connection didn't work."
      if (!err.code) err.code = 'webrtc_handshake_failed';
      if (err.fallback === undefined) err.fallback = true;
      throw err;
    }
  }

  /** Close whatever WebRTC state exists without touching turn/UI state — the
   *  shared cleanup both stop() and a failed/aborted start() call into, so
   *  there is exactly one place that knows how to release the mic/peer. */
  private teardownPeer() {
    try { this.dc?.close(); } catch { /* noop */ }
    try { this.localStream?.getTracks().forEach((t: any) => t.stop()); } catch { /* noop */ }
    try { this.pc?.close(); } catch { /* noop */ }
    try { InCallManager?.stop(); } catch { /* noop */ }
    try { this.bargeInGate.dispose(); } catch { /* noop */ }
    this.dc = null;
    this.pc = null;
    this.localStream = null;
  }

  /** Inject typed text mid-session (the "keep typed Ask available" requirement) —
   *  same conversational turn, just a text item instead of a mic utterance. */
  sendText(text: string) {
    if (!this.dc || this.dc.readyState !== 'open') return;
    // A typed turn gets no `speech_started` event, so reset the per-turn state
    // here — otherwise this turn's assistant text would concatenate onto the
    // PREVIOUS turn's, and the stale `turnPersisted=true` from the last turn
    // would suppress persisting this one entirely.
    this.resetTurn();
    this.turnUserText = text;
    this.turnUserFinal = true; // typed text is final immediately (no transcription round trip)
    this.dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    }));
    this.dc.send(JSON.stringify({ type: 'response.create' }));
  }

  /** Reset all per-turn accumulators. Called at the start of BOTH a spoken
   *  turn (speech_started) and a typed turn (sendText) so neither leaks state
   *  from the previous exchange. */
  private resetTurn() {
    this.speechStoppedAt = null;
    this.turnSpeechStartedAt = null;
    this.firstAudioLogged = false;
    this.turnUserText = '';
    this.turnAssistantText = '';
    this.turnUserFinal = false;
    this.turnAssistantFinal = false;
    this.turnUsedDeepAsk = false;
    this.turnPersisted = false;
  }

  /** Explicit "tap to stop talking" affordance — an immediate, unconditional
   *  interrupt, unlike the automatic duration-gated one in bargeInGate.ts
   *  (which only fires after sustained VAD speech). A deliberate tap is
   *  never ambiguous, so it skips the gate entirely. */
  interrupt() {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.dc.send(JSON.stringify({ type: 'response.cancel' }));
    if (this.sessionId) logMetric(this.sessionId, 'interruption', undefined, { manual: true });
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach((t: any) => { t.enabled = !muted; });
  }

  isMuted(): boolean {
    return this.muted;
  }

  stop() {
    this.stopped = true;
    this.teardownPeer();
    this.setState('idle');
  }

  private async handleEvent(e: any) {
    let evt: any;
    try { evt = JSON.parse(e.data); } catch { return; }

    // The GA Realtime API renamed several beta `response.audio*` events to
    // `response.output_audio*` (e.g. `response.output_audio_transcript.delta`),
    // and different model versions / SDKs have shipped both spellings.
    // Normalize to the shorter form so the assistant transcript renders
    // regardless of which the server actually emits — this is the one part of
    // the contract that can't be exercised by a stubbed test, so tolerate both
    // rather than bet on a single string.
    const type = String(evt.type || '').replace('response.output_audio_transcript.', 'response.audio_transcript.');

    switch (type) {
      case 'input_audio_buffer.speech_started': {
        // Genuine barge-in is now duration-gated client-side (bargeInGate.ts)
        // instead of the server's automatic interrupt_response (which the
        // session no longer sets — see createEphemeralSession): a stray noise
        // blip mid-playback must not instantly cut off the assistant's audio
        // before anything has been validated. Only actually cancel once this
        // speech burst has SUSTAINED past the short gate.
        if (this.state === 'speaking') {
          this.bargeInGate.speechStarted(() => this.cancelAssistantResponse());
        }
        this.resetTurn();
        this.turnSpeechStartedAt = Date.now();
        this.setState('listening');
        break;
      }

      case 'input_audio_buffer.speech_stopped':
        this.bargeInGate.speechStopped();
        this.speechStoppedAt = Date.now();
        this.setState('thinking');
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.handleSpokenTranscript(evt.item_id, evt.transcript || '');
        break;

      case 'response.audio_transcript.delta':
        if (!this.firstAudioLogged && this.speechStoppedAt && this.sessionId) {
          this.firstAudioLogged = true;
          logMetric(this.sessionId, 'first_audio', Date.now() - this.speechStoppedAt);
        }
        this.setState('speaking');
        this.turnAssistantText += evt.delta || '';
        this.handlers.onTranscript?.('assistant', evt.delta || '', false);
        break;

      case 'response.audio_transcript.done':
        this.turnAssistantText = evt.transcript || this.turnAssistantText;
        this.turnAssistantFinal = true;
        this.handlers.onTranscript?.('assistant', evt.transcript || this.turnAssistantText, true);
        this.maybePersistTurn();
        break;

      case 'response.function_call_arguments.delta':
        this.accumulateCallArgs(evt.call_id, evt.name, evt.delta || '');
        break;

      case 'response.function_call_arguments.done':
        this.accumulateCallArgs(evt.call_id, evt.name, evt.arguments || '', true);
        await this.runToolCall(evt.call_id);
        break;

      case 'response.done':
        // Fallback persistence point: if BOTH transcripts already arrived,
        // maybePersistTurn() below already fired from whichever completion
        // event landed last and this is a no-op (turnPersisted guards it).
        // `force` covers the case where the user-transcription event never
        // arrives at all (very short utterance, a transient STT miss) — at
        // this point the turn is definitely over, so persist with whatever
        // text exists rather than silently dropping the exchange.
        this.maybePersistTurn(true);
        this.setState('listening');
        break;

      case 'error':
        this.handlers.onError?.(evt.error?.message || 'Realtime error');
        if (this.sessionId) logMetric(this.sessionId, 'error', undefined, { message: evt.error?.message });
        break;

      default:
        break; // session.created/updated, response.created, output_item events — no action needed
    }
  }

  /** Fires when a barge-in has sustained past the gate — distinct from
   *  interrupt()'s user-tap path, but sends the same event. Note: by fire
   *  time `state` has already moved to 'listening' (speech_started resets
   *  optimistically the instant it's detected, before the gate even starts),
   *  so this can't re-check "still speaking" — response.cancel is a no-op on
   *  OpenAI's side if there's nothing left to cancel, which is the correct
   *  behavior for a response that already finished naturally in the interim. */
  private cancelAssistantResponse() {
    if (this.stopped || !this.dc || this.dc.readyState !== 'open') return;
    this.dc.send(JSON.stringify({ type: 'response.cancel' }));
    if (this.sessionId) logMetric(this.sessionId, 'interruption', undefined, { auto: true });
  }

  /** The pre-response audio-turn gate. The session no longer auto-creates a
   *  response when VAD detects end-of-turn (create_response: false — see
   *  createEphemeralSession) specifically so this can run BEFORE anything
   *  user-visible or agentic happens: a rejected transcript never renders,
   *  never gets a response, never runs a tool, and never persists. Accepted
   *  transcripts are the only path that sends response.create. The actual
   *  accept/reject/idempotency DECISION lives in realtimeTurnGate.ts (a pure
   *  function, independently unit-tested) — this method just executes it. */
  private handleSpokenTranscript(itemId: string | undefined, transcript: string) {
    const durationMs = this.turnSpeechStartedAt != null && this.speechStoppedAt != null
      ? this.speechStoppedAt - this.turnSpeechStartedAt
      : null;
    const decision = decideSpokenTurn(itemId, transcript, this.processedItemIds, {
      language: this.language,
      speechDurationMs: durationMs,
    });

    if (decision.kind === 'duplicate') return;

    if (decision.kind === 'rejected') {
      // Safe diagnostics only — reason, character count, detected script
      // category, and speech duration. NEVER the transcript text or audio.
      console.warn(`[voice] rejected phantom turn — ${decision.logLine}`);
      // Delete the rejected item at OpenAI so it can never contaminate a
      // later turn's context (e.g. the model "remembering" a phantom
      // utterance a few turns later).
      if (decision.deleteItemId && this.dc && this.dc.readyState === 'open') {
        this.dc.send(JSON.stringify({ type: 'conversation.item.delete', item_id: decision.deleteItemId }));
      }
      this.resetTurn();
      this.setState('listening');
      return;
    }

    this.turnUserText = decision.transcript;
    this.turnUserFinal = true;
    this.handlers.onTranscript?.('user', decision.transcript, true);
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify({ type: 'response.create' }));
    }
    // The user-transcript and assistant-reply events resolve on independent,
    // non-deterministically-ordered timelines — either can finish last. Try
    // persisting from BOTH completion points rather than assuming this one
    // always precedes response.done.
    this.maybePersistTurn();
  }

  /** Persist the current turn to the shared Ask thread once both sides are
   *  available — called from whichever of {user transcript, assistant
   *  transcript} completes LAST (order is not guaranteed), plus a forced
   *  fallback from response.done. Idempotent via `turnPersisted`. Skipped
   *  entirely for a deep_ask turn, which already persisted itself
   *  server-side (chat/realtimeTools.js's deepAsk) — persisting both would
   *  double-write the same exchange. */
  private maybePersistTurn(force = false) {
    if (this.turnPersisted) return;
    if (this.turnUsedDeepAsk) {
      this.turnPersisted = true;
      this.handlers.onTurnPersisted?.();
      return;
    }
    if (!this.turnUserText || !this.turnAssistantText) return;
    if (!force && !(this.turnUserFinal && this.turnAssistantFinal)) return;
    this.turnPersisted = true;
    postJson(REALTIME_TURN_URL, { question: this.turnUserText, answer: this.turnAssistantText }, 10000)
      .then(() => this.handlers.onTurnPersisted?.())
      .catch(() => {});
  }

  private accumulateCallArgs(callId: string, name: string | undefined, chunk: string, done = false) {
    const existing = this.pendingCalls.get(callId) || { name: name || '', argsText: '' };
    if (name) existing.name = name;
    existing.argsText = done ? chunk : existing.argsText + chunk;
    this.pendingCalls.set(callId, existing);
  }

  private async runToolCall(callId: string) {
    const call = this.pendingCalls.get(callId);
    this.pendingCalls.delete(callId);
    if (!call || !this.sessionId || !this.dc) return;

    let args: Record<string, unknown> = {};
    try { args = call.argsText ? JSON.parse(call.argsText) : {}; } catch { /* malformed args -> empty object, tool validates */ }

    this.setState('executing');
    this.handlers.onToolStart?.(call.name);
    if (call.name === 'deep_ask') this.turnUsedDeepAsk = true;

    let output: unknown;
    try {
      const res = await postJson(REALTIME_TOOL_URL, { sessionId: this.sessionId, name: call.name, arguments: args }, 30000);
      output = res.result;
    } catch (err: any) {
      output = { error: err?.message || 'tool failed' };
    }

    // The session may have been stopped (or torn down by a failed reconnect)
    // while that HTTP round trip was in flight — re-check after the await,
    // not just before it, or this dereferences a dc that teardownPeer()
    // already nulled out.
    if (this.stopped || !this.dc) return;
    if (this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
      }));
      this.dc.send(JSON.stringify({ type: 'response.create' }));
    }
  }
}
