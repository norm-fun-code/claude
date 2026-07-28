// Pure turn-acceptance decision for realtimeVoice.ts's pre-response
// audio-turn gate. Split out from the WebRTC session class (which imports
// config.ts and, transitively through the app, react-native-webrtc — neither
// of which plain Node can resolve) specifically so the DECISION itself is
// directly unit-testable under `node --experimental-strip-types --test`
// (mirrors this codebase's existing pattern: playbackOwnership.ts wrapped by
// voice.ts, audioFormat.ts wrapped by voice.ts). realtimeVoice.ts's
// handleSpokenTranscript() calls this and mechanically executes whatever it
// returns — see realtimeTurnGate.test.ts for the decision logic itself,
// transcriptGuard.test.ts for the underlying classifier.
// Explicit '.ts' extension: this module is loaded directly by plain Node
// under `npm test` (see realtimeTurnGate.test.ts), and Node's ESM resolver
// (unlike Metro's) requires a fully resolvable specifier on relative
// imports — Metro resolves this identically either way (see tsconfig.json's
// allowImportingTsExtensions comment), so this is safe for the app bundle too.
import { classifySpokenTranscript, describeRejection } from './transcriptGuard.ts';
import type { ClassifyOptions, TranscriptGuardResult } from './transcriptGuard.ts';

export type SpokenTurnDecision =
  | { kind: 'duplicate' }
  | { kind: 'rejected'; result: TranscriptGuardResult; logLine: string; deleteItemId: string | null }
  | { kind: 'accepted'; transcript: string };

/**
 * Decide what to do with one finalized spoken transcript.
 *
 * Mutates `processedItemIds` (adds `itemId` the first time it's seen) so
 * that passing the SAME Set instance across a session's events makes this
 * idempotent by item_id: a duplicate delivery of the same completion event
 * always comes back `{ kind: 'duplicate' }` on the second and later calls,
 * before classification even runs — a duplicate must never re-classify,
 * re-render, or send a second response/delete for the same item.
 */
export function decideSpokenTurn(
  itemId: string | undefined,
  transcript: string,
  processedItemIds: Set<string>,
  classifyOpts: ClassifyOptions = {}
): SpokenTurnDecision {
  if (itemId) {
    if (processedItemIds.has(itemId)) return { kind: 'duplicate' };
    processedItemIds.add(itemId);
  }

  const result = classifySpokenTranscript(transcript, classifyOpts);
  if (!result.accepted) {
    return { kind: 'rejected', result, logLine: describeRejection(result), deleteItemId: itemId ?? null };
  }
  return { kind: 'accepted', transcript };
}

/**
 * A tool-call result, transcript delta, or response event tagged with an
 * older turnId than the CURRENT turn is stale — the turn it belonged to was
 * cancelled (barge-in) or superseded before it resolved. realtimeVoice.ts
 * increments its own turnId on every new accepted user turn and stamps it
 * onto every tool call it issues; a stale event must be dropped rather than
 * rendered or executed, so a cancelled response can never surface a late
 * tool-call receipt or transcript fragment as if it were current, and a
 * barge-in can never let the interrupted response's action still land.
 */
export function isStaleTurn(eventTurnId: number, currentTurnId: number): boolean {
  return eventTurnId < currentTurnId;
}
