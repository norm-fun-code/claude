// The ONE shared voice-session context builder — every conversational voice
// entry point (Realtime "Talk", push-to-talk in AskOverlay, typed Ask) sends
// this same compact contract to the backend instead of each independently
// deciding what to send (previously: Realtime sent an empty '{}' body,
// push-to-talk sent only {audio, mime}, typed Ask sent only {question} —
// none carried active tab / snapshot / selection). Pure — no I/O, no RN
// imports — so it's directly unit-testable.
//
// Deliberately does NOT send raw page payloads: `selection` is just a
// {kind, id} pointer the backend re-resolves itself against canonical
// stores (backend/src/chat/voiceContext.js) — the client never asserts the
// fact itself, only which stable record it's currently looking at.

export type VoiceTab = 'today' | 'health' | 'wealth' | 'wisdom' | 'ask';
export type VoiceSelectionKind = 'recovery' | 'commitment' | 'insight' | 'workout' | 'entity';

export interface VoiceSelection {
  kind: VoiceSelectionKind;
  id: string;
}

export interface VoiceSessionContext {
  activeTab: VoiceTab;
  localDateTime: string; // ISO string, the device's current local moment
  snapshotId: string | null;
  snapshotVersion: number | null;
  selection: VoiceSelection | null;
  sessionId: string;
  language: string;
}

export interface BuildSessionContextInput {
  tab: VoiceTab;
  snapshotId?: string | null;
  snapshotVersion?: number | null;
  selection?: VoiceSelection | null;
  sessionId: string;
  language?: string;
  /** Injectable for tests — defaults to `new Date()`. */
  now?: Date;
}

/** Pure: build the session-context contract from what the app already has
 *  resident in memory. Never fetches anything itself. */
export function buildSessionContext(input: BuildSessionContextInput): VoiceSessionContext {
  const now = input.now ?? new Date();
  return {
    activeTab: input.tab,
    localDateTime: now.toISOString(),
    snapshotId: input.snapshotId ?? null,
    snapshotVersion: input.snapshotVersion ?? null,
    selection: input.selection ?? null,
    sessionId: input.sessionId,
    language: input.language ?? 'en',
  };
}

/** A short random id, good enough to correlate one voice session's
 *  /session, /tool, /turn, /metric calls — not a security token. */
export function createSessionId(): string {
  return `vs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** A short random id per spoken/typed TURN within a session — used for
 *  server-side idempotency (voiceIdempotency.js) and client-side stale-turn
 *  guarding (a tool-call result or transcript event tagged with an older
 *  turnId than the current one is dropped). */
export function createTurnId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
