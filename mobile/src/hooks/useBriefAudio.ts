// Shared "Listen" playback state machine for brief-audio narration (Chief
// Brief, Evening Brief, Wisdom — see backend/src/services/brief-audio.js).
// Extracted out of BriefCard/EveningBriefCard, which had duplicated this
// nearly verbatim (down to the same idle/loading/playing/error states and
// the same 3s auto-reset-after-error "retry" pattern) with only the URL and
// timeout differing. One implementation now, so a fix (or the ownership/
// cancellation guarantees below) lands for every Listen button at once
// instead of needing to be copied three times.
//
// Audit fix, item 3 — root causes this hook now guards against:
//  1. No fetch cancellation: unmounting (or a second tap) mid-request left
//     the fetch running; when it eventually resolved, playBase64() and
//     setState() still fired for a screen the user had already left.
//  2. No request-generation guard: a stale response (superseded by a later
//     toggle() call, or arriving after unmount) could still win the race
//     and clobber newer/absent state.
//  3. No explicit ownership: cleanup used to infer "was I playing?" from
//     local React state, which can be stale by the time an unmount runs;
//     now cleanup calls releaseIfOwner(ownerId), an explicit check against
//     the ONE shared "who currently owns the sound" pointer in lib/voice.ts
//     — a card that was already pre-empted by a different card can never
//     stop someone else's audio.
import { useEffect, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { authHeaders, fetchWithTimeout } from '../config';
import { voiceAvailable, playBase64, claimOwnership, releaseIfOwner } from '../lib/voice';
import { createRequestGuard } from '../lib/playbackOwnership';

export type BriefAudioState = 'idle' | 'loading' | 'playing' | 'error';

/**
 * @param url the brief-audio endpoint to fetch (BRIEFING_AUDIO_URL,
 *   EVENING_BRIEF_AUDIO_URL, WISDOM_AUDIO_URL, ...).
 * @param timeoutMs client fetch timeout. The backend's own overall TTS
 *   deadline (services/voice.js's GEMINI_TTS_OVERALL_TIMEOUT_MS) is
 *   deliberately kept under this default (50s vs 60s) so the server can
 *   return a clean error before the client's own AbortController fires in
 *   the common case, rather than racing it (audit fix, item 7) — don't drop
 *   this below the backend's budget without lowering that too.
 * @param snapshotId optional — binds narration to the EXACT build currently
 *   on screen (BriefingData.snapshotId) rather than "whatever the server
 *   thinks is most recent right now" (audit fix, item 4). Omit for Evening
 *   Brief, which has its own day-based (not snapshot-based) identity.
 */
export function useBriefAudio(url: string, timeoutMs = 60000, snapshotId?: string | null) {
  const [state, setState] = useState<BriefAudioState>('idle');
  // A unique, stable identity for THIS hook instance — the playback-
  // ownership token (lib/voice.ts). useRef(...).current is computed once
  // per mount and never changes across re-renders.
  const ownerId = useRef(Symbol('briefAudio')).current;
  // Request-generation + liveness guard (lib/playbackOwnership.ts, unit-
  // tested there) — a stale response (superseded by a later toggle() call,
  // or arriving after unmount) can never call playBase64 or update state.
  const guard = useRef(createRequestGuard()).current;
  // Synchronous (not React-state-dependent) in-flight guard: two onPress
  // calls fired in the same tick, before React has re-rendered with
  // state==='loading', would otherwise both pass a `state === 'loading'`
  // check — a real rapid-double-tap failure mode a ref closes correctly
  // where reading `state` cannot.
  const loadingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      guard.invalidate();
      abortRef.current?.abort();
      // Ownership-checked: only actually stops (and clears the global
      // "currently playing" pointer) if THIS hook instance is still the
      // owner. A card that was never playing, or was already pre-empted by
      // a different card starting its own narration, must never stop that
      // other card's audio just because IT happens to unmount.
      releaseIfOwner(ownerId);
    };
  }, [ownerId, guard]);

  // Only ever updates state while the component is still mounted — no React
  // state updates after unmount (guard.invalidate() runs in the cleanup
  // effect above, so isLive() reads false from that point on).
  const safeSetState = (s: BriefAudioState) => {
    if (guard.isLive()) setState(s);
  };

  async function toggle() {
    if (state === 'playing') {
      abortRef.current?.abort();
      await releaseIfOwner(ownerId);
      safeSetState('idle');
      return;
    }
    if (loadingRef.current) return; // already in flight — a second tap is a no-op, not a duplicate request
    loadingRef.current = true;

    const myRequestId = guard.begin();
    // True once a NEWER toggle() call (or unmount) has superseded this one —
    // checked after every await so a stale response can never call
    // playBase64 or update state for a request nobody's waiting on anymore.
    const isStale = () => guard.isStale(myRequestId);

    Haptics.selectionAsync();
    safeSetState('loading');
    const controller = new AbortController();
    abortRef.current = controller;
    const requestUrl = snapshotId ? `${url}${url.includes('?') ? '&' : '?'}snapshotId=${encodeURIComponent(snapshotId)}` : url;
    try {
      const res = await fetchWithTimeout(requestUrl, { headers: authHeaders(), signal: controller.signal }, timeoutMs);
      if (isStale()) return;
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data = await res.json();
      if (isStale()) return;
      if (!data?.audio) throw new Error('no audio');
      // Fetch the narration as base64 JSON (auth headers sent reliably via
      // fetch), then play from a local file — the same path the voice reply
      // uses. Streaming the URL through expo-av dropped auth on iOS and 401'd.
      const ok = await playBase64(data.audio, data.mime || 'audio/wav', () => {
        if (!isStale()) safeSetState('idle');
      });
      if (isStale()) {
        // The sound started (or failed to) for a request nobody wants
        // anymore — e.g. unmounted or superseded WHILE playBase64 itself
        // was awaiting. Release ownership immediately rather than leaving
        // an orphaned "owner" nothing will ever clean up.
        await releaseIfOwner(ownerId);
        return;
      }
      if (!ok) { safeSetState('idle'); return; }
      // Claim ownership AFTER playback has actually started (playBase64 ->
      // playRemote already stopped/replaced whatever was playing before) —
      // so a LATER play elsewhere correctly finds and evicts THIS owner.
      claimOwnership(ownerId, () => safeSetState('idle'));
      safeSetState('playing');
    } catch {
      if (isStale()) return;
      // No brief / TTS unavailable / playback failed / fetch aborted —
      // surface it briefly instead of silently doing nothing. Auto-reset
      // after 3s IS the retry affordance: the button's label returns to
      // "Listen" and a tap re-fires toggle() from scratch, no separate
      // "Retry" control needed.
      safeSetState('error');
      setTimeout(() => {
        if (!isStale()) setState((s) => (s === 'error' ? 'idle' : s));
      }, 3000);
    } finally {
      loadingRef.current = false;
    }
  }

  return { state, toggle, voiceAvailable };
}
