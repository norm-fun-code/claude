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

// key -> { state: 'pending', promise } while fn() is in flight, or
// key -> { state: 'done', result, expiresAt } once it has resolved.
const entries = new Map();

function sweep(now) {
  if (entries.size <= MAX_ENTRIES) return;
  for (const [key, v] of entries) {
    if (v.state === 'done' && v.expiresAt <= now) entries.delete(key);
  }
  // Still over budget after expiry sweep (all entries genuinely live) —
  // drop the oldest (Map preserves insertion order) rather than grow
  // unbounded. Skip anything still pending — evicting an in-flight entry
  // would make a not-yet-arrived concurrent caller miss the join and
  // double-execute fn().
  if (entries.size > MAX_ENTRIES) {
    for (const [key, v] of entries) {
      if (entries.size <= MAX_ENTRIES) break;
      if (v.state === 'done') entries.delete(key);
    }
  }
}

/**
 * Run `fn` at most once per `key` within `ttlMs`. A second call with the
 * same key inside the window returns the FIRST call's resolved result
 * (never re-invokes `fn`) and sets `fromCache: true` on the returned
 * envelope so callers can log/skip side effects accordingly. A call that
 * THROWS is not cached — a genuine failure should be retryable.
 *
 * Concurrency-safe: the in-flight Promise is registered in `entries`
 * SYNCHRONOUSLY, before `fn()` is awaited, so two calls issued back-to-back
 * for the same key (no `await` between them) both see the same pending
 * entry and join the same Promise — `fn()` runs exactly once. A rejected
 * call removes its entry so every joiner (and the caller itself) can retry.
 *
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @param {number} [ttlMs]
 * @returns {Promise<{ result: T, fromCache: boolean }>}
 */
async function once(key, fn, ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  const hit = entries.get(key);
  if (hit) {
    if (hit.state === 'done' && hit.expiresAt > now) {
      return { result: hit.result, fromCache: true };
    }
    if (hit.state === 'pending') {
      const result = await hit.promise;
      return { result, fromCache: true };
    }
  }

  const promise = Promise.resolve().then(fn);
  entries.set(key, { state: 'pending', promise });
  try {
    const result = await promise;
    entries.set(key, { state: 'done', result, expiresAt: now + ttlMs });
    sweep(now);
    return { result, fromCache: false };
  } catch (err) {
    // Only remove the entry if it's still OUR pending marker — a slower
    // stale check could otherwise clobber a newer entry for the same key.
    const current = entries.get(key);
    if (current && current.state === 'pending' && current.promise === promise) entries.delete(key);
    throw err;
  }
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
