// Pure, dependency-free playback-ownership + request-generation bookkeeping
// (audit fix, item 3) — deliberately has NO expo-av/expo-file-system import,
// so it can be unit-tested directly under plain Node even though this
// project has no mobile test framework (see playbackOwnership.test.ts,
// run via `node --experimental-strip-types --test`). lib/voice.ts wraps
// createOwnershipRegistry() with the actual native Sound calls; hooks/
// useBriefAudio.ts wraps createRequestGuard() with React state.

export type OwnerId = symbol;

/**
 * Tracks WHO currently owns the single shared audio-playback slot, and lets
 * a caller check "am I still the owner?" before taking an action that should
 * only ever be performed by the current owner (stopping playback on
 * unmount, or on an explicit "tap to stop") — the explicit-ownership
 * guarantee: a card that was already pre-empted by a different card
 * starting its own narration can never affect that other card's playback or
 * UI state.
 */
export function createOwnershipRegistry() {
  let currentOwner: OwnerId | null = null;
  let activeNotifier: (() => void) | null = null;

  /**
   * Register `ownerId` as the current owner. If a DIFFERENT owner was
   * previously registered, its own notifier fires (letting its UI reset to
   * idle) before this call returns — evicting the old owner is synchronous
   * and unconditional. Registering the SAME owner again just updates its
   * notifier without evicting anyone (a no-op eviction).
   */
  function claim(ownerId: OwnerId, resetSelf: () => void): void {
    const evict = currentOwner !== null && currentOwner !== ownerId ? activeNotifier : null;
    currentOwner = ownerId;
    activeNotifier = resetSelf;
    evict?.();
  }

  /** True if `ownerId` is the currently registered owner. */
  function isOwner(ownerId: OwnerId): boolean {
    return currentOwner === ownerId;
  }

  /**
   * Unconditionally clear ownership (no one owns the slot afterward) and
   * fire whichever notifier was registered, if any — the "kill everything"
   * primitive, used for natural playback completion/error and for an
   * explicit stop once the caller has already confirmed ownership via
   * `isOwner`.
   */
  function clear(): void {
    const notify = activeNotifier;
    currentOwner = null;
    activeNotifier = null;
    notify?.();
  }

  return { claim, isOwner, clear };
}

/**
 * A monotonically-increasing request generation counter + a synchronous
 * "still relevant" check — the cancellation guard that keeps a stale async
 * response (superseded by a newer call, or arriving after the caller tore
 * itself down) from acting on state nobody's waiting on anymore. Deliberately
 * synchronous (not dependent on any framework's re-render timing): calling
 * `begin()` twice in the same tick, before anything else runs, still
 * produces two DIFFERENT ids, so the first is correctly stale the instant
 * the second begins — a real rapid-double-tap failure mode a React-state
 * boolean alone cannot close (state updates batch; two synchronous calls can
 * both observe the same pre-update value).
 */
export function createRequestGuard() {
  let currentId = 0;
  let live = true;

  /** Start a new request generation; returns its id. */
  function begin(): number {
    currentId += 1;
    return currentId;
  }

  /** True if `id` is no longer the current generation, or the guard has
   *  been invalidated (e.g. the owning component unmounted). */
  function isStale(id: number): boolean {
    return id !== currentId || !live;
  }

  /** True if the guard hasn't been invalidated — for a general "is the
   *  owning component still mounted?" check that isn't tied to any one
   *  request generation (e.g. guarding a state update triggered by
   *  something other than begin()'s own async chain). */
  function isLive(): boolean {
    return live;
  }

  /** Mark the guard permanently invalid — every id (past or future) reads
   *  as stale from this point on. Call on unmount. */
  function invalidate(): void {
    live = false;
  }

  return { begin, isStale, isLive, invalidate };
}

export type FirstAttemptOutcome = 'stale' | 'retry' | 'terminal';

/**
 * Classifies what useBriefAudio.ts's toggle() should do after its FIRST
 * fetch-and-play attempt throws — the exact decision behind the Wisdom
 * Listen timeout fix: a request superseded/unmounted mid-flight does
 * nothing; the first attempt's OWN local timer firing (AbortError) while
 * still relevant gets one automatic follow-up attempt (a truthful
 * "Preparing…" state) instead of an immediate "Unavailable", since the
 * backend's bounded TTS deadline may only just be finishing; anything else
 * (bad status, no audio, playback failure, a real network error) is
 * terminal immediately — no free pass. Pure so this is unit-testable
 * without a React harness (this project has none) — see
 * playbackOwnership.test.ts.
 */
export function classifyFirstAttemptFailure(errName: string | undefined, stale: boolean): FirstAttemptOutcome {
  if (stale) return 'stale';
  return errName === 'AbortError' ? 'retry' : 'terminal';
}
