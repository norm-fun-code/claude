// Shared "Listen" playback state machine for brief-audio narration (Chief
// Brief, Evening Brief, Wisdom — see backend/src/services/brief-audio.js).
// Extracted out of BriefCard/EveningBriefCard, which had duplicated this
// nearly verbatim (down to the same idle/loading/playing/error states and
// the same 3s auto-reset-after-error "retry" pattern) with only the URL and
// timeout differing. One implementation now, so a fix (or the cross-card
// stale-state notifier below) lands for every Listen button at once instead
// of needing to be copied three times.
import { useEffect, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { authHeaders, fetchWithTimeout } from '../config';
import { voiceAvailable, playBase64, stopPlayback, setActiveStopNotifier } from '../lib/voice';

export type BriefAudioState = 'idle' | 'loading' | 'playing' | 'error';

/**
 * @param url the brief-audio endpoint to fetch (BRIEFING_AUDIO_URL,
 *   EVENING_BRIEF_AUDIO_URL, WISDOM_AUDIO_URL, ...).
 * @param timeoutMs client fetch timeout — the backend TTS call can itself
 *   take up to ~45s per model attempt before falling back to the next
 *   candidate (see voice.js's GEMINI_TTS_TIMEOUT_MS), so this must stay
 *   generous enough that a slow-but-recoverable request doesn't get aborted
 *   right before it would have succeeded (BriefCard's original 60s reasoning
 *   — reused here as the shared default rather than each caller re-deriving
 *   its own number).
 */
export function useBriefAudio(url: string, timeoutMs = 60000) {
  const [state, setState] = useState<BriefAudioState>('idle');
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    return () => {
      // Only stop playback (and thus the global "one narration at once"
      // engine) if THIS card was actually the one playing/loading — an
      // unrelated card unmounting (e.g. a tab switch away from a screen that
      // wasn't narrating anything) must never kill someone else's audio.
      if (stateRef.current === 'playing' || stateRef.current === 'loading') {
        stopPlayback();
      }
    };
  }, []);

  async function toggle() {
    if (state === 'playing') {
      await stopPlayback();
      setState('idle');
      return;
    }
    if (state === 'loading') return; // already in flight — a second tap is a no-op, not a duplicate request
    Haptics.selectionAsync();
    setState('loading');
    try {
      // Fetch the narration as base64 JSON (auth headers sent reliably via
      // fetch), then play from a local file — the same path the voice reply
      // uses. Streaming the URL through expo-av dropped auth on iOS and 401'd.
      const res = await fetchWithTimeout(url, { headers: authHeaders() }, timeoutMs);
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data = await res.json();
      if (!data?.audio) throw new Error('no audio');
      const ok = await playBase64(data.audio, data.mime || 'audio/wav', () => setState('idle'));
      if (!ok) { setState('idle'); return; }
      // Register AFTER playback has actually started (playBase64 -> playRemote
      // already called stopPlayback() internally to pre-empt whatever was
      // playing before) — so this card becomes the one a LATER play elsewhere
      // will reset to idle.
      setActiveStopNotifier(() => setState('idle'));
      setState('playing');
    } catch {
      // No brief / TTS unavailable / playback failed — surface it briefly
      // instead of silently doing nothing. Auto-reset after 3s IS the retry
      // affordance: the button's label returns to "Listen" and a tap re-fires
      // toggle() from scratch, no separate "Retry" control needed.
      setState('error');
      setTimeout(() => setState((s) => (s === 'error' ? 'idle' : s)), 3000);
    }
  }

  return { state, toggle, voiceAvailable };
}
