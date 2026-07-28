// Turn/action idempotency for conversational voice — a bounded, in-process
// dedup cache. Neither Realtime tool calls nor push-to-talk turns had ANY
// idempotency guard before this (a client network retry, or a model
// re-issuing the same tool call, could double-execute a non-idempotent
// mutation like log_activity/add_chapter, or double-persist a chat turn).
//
// Deliberately in-memory, not a DB table: this guards against retries within
// a single short-lived voice turn/session (seconds, not days), the exact
// window a client-side retry or a duplicated model tool-call would land in.
// A multi-instance deployment would need this promoted to a shared store
// (e.g. a small Postgres table with a unique key + short TTL sweep) for the
// guarantee to hold across instances — noted as follow-up work, not a gap
// silently accepted: within a single instance/session (today's deployment
// topology) this is a complete, correct guard.
'use strict';

const MAX_ENTRIES = 2000;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes — well beyond any real turn

const entries = new Map(); // key -> { result, expiresAt }

function sweep(now) {
  if (entries.size <= MAX_ENTRIES) return;
  for (const [key, v] of entries) {
    if (v.expiresAt <= now) entries.delete(key);
  }
  // Still over budget after expiry sweep (all entries genuinely live) —
  // drop the oldest (Map preserves insertion order) rather than grow unbounded.
  while (entries.size > MAX_ENTRIES) {
    const oldestKey = entries.keys().next().value;
    entries.delete(oldestKey);
  }
}

/**
 * Run `fn` at most once per `key` within `ttlMs`. A second call with the
 * same key inside the window returns the FIRST call's resolved result
 * (never re-invokes `fn`) and sets `fromCache: true` on the returned
 * envelope so callers can log/skip side effects accordingly. A call that
 * THROWS is not cached — a genuine failure should be retryable.
 *
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @param {number} [ttlMs]
 * @returns {Promise<{ result: T, fromCache: boolean }>}
 */
async function once(key, fn, ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.expiresAt > now) {
    return { result: hit.result, fromCache: true };
  }
  const result = await fn();
  entries.set(key, { result, expiresAt: now + ttlMs });
  sweep(now);
  return { result, fromCache: false };
}

/** Build a stable dedup key from a turn/session/action identity. Pure. */
function keyFor({ sessionId, turnId, action, argsHash }) {
  return [sessionId || 'no-session', turnId || 'no-turn', action || 'no-action', argsHash || ''].join(':');
}

/** Cheap, stable, non-cryptographic hash of a JSON-serializable value —
 *  only used to distinguish two calls' argument shapes within a dedup key,
 *  never for security purposes. */
function hashArgs(args) {
  const s = JSON.stringify(args ?? {});
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h.toString(36);
}

/** Test/diagnostic hook — clears all entries. Never called from production code. */
function _reset() {
  entries.clear();
}

module.exports = { once, keyFor, hashArgs, _reset };
