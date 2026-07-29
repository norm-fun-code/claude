// Server-authoritative "which turn is current" tracker for realtime voice
// sessions — the missing half of barge-in safety. Before this module, turn
// staleness was checked ONLY client-side, AFTER a mutating tool call's HTTP
// response had already arrived — by then the mutation had already committed
// server-side (see chat/executeAction.js), so a "stale" result was silently
// dropped while its write stood. This module lets the backend itself know
// "which turn is currently authorized" per session, so a mutation can be
// rejected BEFORE it commits, not just hidden from the UI after the fact.
//
// Deliberately in-memory, bounded, single-instance — mirrors
// chat/voiceIdempotency.js's documented scope: correct within one
// instance/session (today's deployment topology); a multi-instance
// deployment would need this promoted to a shared store for the guarantee
// to hold across instances, same follow-up note as voiceIdempotency.js.
'use strict';

const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes — well beyond any real voice session

const sessions = new Map(); // sessionId -> { currentTurnId: number, updatedAt: number }

function sweep(now) {
  if (sessions.size <= MAX_SESSIONS) return;
  for (const [id, v] of sessions) {
    if (now - v.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
  while (sessions.size > MAX_SESSIONS) {
    const oldestKey = sessions.keys().next().value;
    sessions.delete(oldestKey);
  }
}

/**
 * Client calls this whenever ITS OWN turn counter advances — a newly
 * accepted spoken/typed turn, an explicit interrupt, or a barge-in the
 * duration-gate confirmed. Advances the server's notion of "the current
 * turn" for this session; monotonic (a lower/equal turnId never regresses
 * the stored value, so an out-of-order network arrival can't un-advance it).
 * Anything still in flight tagged with an older turnId is now authoritatively
 * superseded, even though its own HTTP request may still be executing.
 */
function advanceTurn(sessionId, turnId) {
  if (!sessionId || turnId == null) return;
  const n = Number(turnId);
  if (!Number.isFinite(n)) return;
  const now = Date.now();
  const existing = sessions.get(sessionId);
  if (!existing || n > existing.currentTurnId) {
    sessions.set(sessionId, { currentTurnId: n, updatedAt: now });
  } else {
    existing.updatedAt = now;
  }
  sweep(now);
}

/**
 * True if `turnId` is still the session's current turn (or the session has
 * no recorded turn yet, e.g. the very first tool call) — false if a LATER
 * `advanceTurn()` call has already superseded it. Call this immediately
 * before committing a mutation, not just when the request first arrives —
 * a cancellation can race in during validation/idempotency-key setup.
 */
function isTurnAuthorized(sessionId, turnId) {
  if (!sessionId || turnId == null) return true;
  const n = Number(turnId);
  if (!Number.isFinite(n)) return true;
  const existing = sessions.get(sessionId);
  if (!existing) return true;
  return n >= existing.currentTurnId;
}

/** Test-only hook — clears all tracked sessions. Never called from production code. */
function _reset() {
  sessions.clear();
}

module.exports = { advanceTurn, isTurnAuthorized, _reset };
