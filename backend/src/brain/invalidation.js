// Runtime state-invalidation bus — the piece that makes registry.js's dependency
// graph ACTUALLY drive behavior instead of being test/documentation-only.
//
// When a mutation lands (a health-metric write that moves recovery, a workout
// override, a Monarch transaction sync, a goal/weekly-intention/commitment
// change, an annotation retirement), the mutation site calls `bump(TRIGGER.X)`.
// This module looks up the transitive set of registered fields that change is
// defined to invalidate (registry.invalidationSet), increments each field's
// version + a global state version, and fires any registered side-effect
// listeners (e.g. clearing the liveRecovery compute cache so the next read
// recomputes).
//
// DURABILITY / MULTI-INSTANCE: the in-process `versions` map below is a fast
// CACHE, not the authority — it is write-through persisted to the
// `brain_state_version` table (best-effort, fire-and-forget from bump()) and
// merged back from it via `refresh()`. A consumer deciding whether a piece of
// cached state is still good must call `await refresh()` first — that pulls
// whatever ANY instance has bumped, not just this process's own writes. This
// is what keeps a staleness decision from silently depending on process-local
// memory: a single-instance deployment gets identical behavior (refresh() is
// a fast local no-op merge), while a multi-instance one gets correctness
// (instance B sees instance A's bump the next time it calls refresh()). If the
// DB is unreachable, every DB call here degrades to a logged no-op and the
// in-process versions keep working exactly as they did before this table
// existed — a mutation on THIS instance is still visible to THIS instance
// immediately, even if the durable write-through failed.
'use strict';

const { TRIGGER, invalidationSet, FIELDS } = require('./registry');

// Row key for the overall state counter, parallel to the per-field rows.
const GLOBAL_FIELD = '__global__';

// Per-field monotonic version + a global counter — the in-process cache.
const versions = Object.create(null);
for (const key of Object.keys(FIELDS)) versions[key] = 0;
let globalVersion = 0;

// field -> [listener]. Listeners run side effects (cache clears) on invalidation.
const listeners = Object.create(null);

/** Register a side-effect that fires whenever `field` is invalidated. */
function on(field, fn) {
  (listeners[field] || (listeners[field] = [])).push(fn);
}

/** Named error type for a genuine durable-persistence failure (see
 *  persistStrict/bumpDurable below) — lets a caller (or the central error
 *  middleware) distinguish "the invalidation bus's durable write-through
 *  failed" from an arbitrary application error, without inspecting message
 *  text. Carries only field NAMES (never query params, connection strings,
 *  or anything else DB-internal) — safe to log or include in a sanitized
 *  5xx response body the same way every other thrown error in this app is. */
class InvalidationPersistError extends Error {
  constructor(fields, cause) {
    super(`durable brain-state persistence failed for [${fields.join(', ')}]: ${cause.message}`);
    this.name = 'InvalidationPersistError';
    this.fields = [...fields];
    this.cause = cause;
  }
}

/** The raw durable write-through: bump `fields` (+ the global counter) by 1
 *  each in brain_state_version, and merge whatever Postgres reports back
 *  (authoritative in case a concurrent writer — another instance, or another
 *  concurrent request in this process — got there first) into the
 *  in-process cache via max(). THROWS on failure — persist() and
 *  persistStrict() below each wrap this with a DIFFERENT failure policy
 *  (swallow vs. propagate); the raw DB work lives here exactly once so
 *  those two policies can never drift out of sync with each other. */
async function doPersist(fields) {
  const db = require('../db');
  const { rows } = await db.query(
    `INSERT INTO brain_state_version (field, version, updated_at)
     SELECT unnest($1::text[]), 1, now()
     ON CONFLICT (field) DO UPDATE
       SET version = brain_state_version.version + 1, updated_at = now()
     RETURNING field, version`,
    [[...fields, GLOBAL_FIELD]]
  );
  for (const row of rows) {
    const v = Number(row.version);
    if (row.field === GLOBAL_FIELD) globalVersion = Math.max(globalVersion, v);
    else versions[row.field] = Math.max(versions[row.field] ?? 0, v);
  }
}

/** Best-effort durable write-through — for bump() only. Never throws; a
 *  missing/unreachable DB just means this instance's in-process values are
 *  the only copy, same as before this table existed. Cross-instance
 *  freshness is NOT guaranteed to have landed when this resolves — that
 *  guarantee is exactly what persistStrict()/bumpDurable() exist for. */
async function persist(fields) {
  if (!fields.length) return;
  try {
    await doPersist(fields);
  } catch (err) {
    console.error(`[brain/invalidation] durable persist failed (in-process version still applied): ${err.message}`);
  }
}

/** STRICT durable write-through — for bumpDurable() only. Logs safe context
 *  (the affected field names and the DB error message — never raw query
 *  params or connection details) and then RE-THROWS as InvalidationPersistError,
 *  so a caller that specifically asked for a durable, cross-instance-visible
 *  invalidation learns about a genuine failure instead of the call silently
 *  resolving as if it had succeeded (the bug this replaces: persist() always
 *  swallowed, so `await bumpDurable(...)` could never actually fail even
 *  when the durable write never landed). The in-process cache was ALREADY
 *  updated by applyLocal() before this runs (see bumpDurable) — THIS
 *  instance still sees its own write immediately regardless; only
 *  cross-instance durability is what's actually broken when this throws. */
async function persistStrict(fields) {
  if (!fields.length) return;
  try {
    await doPersist(fields);
  } catch (err) {
    console.error(`[brain/invalidation] STRICT durable persist FAILED for [${fields.join(', ')}] — propagating to caller, not silently ignored: ${err.message}`);
    throw new InvalidationPersistError(fields, err);
  }
}

/**
 * The IN-PROCESS half of applying a change trigger: invalidate every field
 * the registry says it reaches (transitively), bump versions synchronously
 * (so a caller that checks versionOf() right after sees its own write with
 * no await), and fire listeners. Does NOT touch the durable store — bump()
 * and bumpDurable() each call this exactly once and then decide separately
 * how to persist, so persist() is never invoked twice for one trigger
 * (Transactional Brain Invalidation, audit recommendation #2: bump() used
 * to persist fire-and-forget internally, and bumpDurable() called bump()
 * AND persisted again itself — one mutation could double-increment the
 * durable version). Returns the invalidated field set + the new (at-least-
 * local) global version. An unknown trigger invalidates nothing.
 */
function applyLocal(trigger, meta) {
  const fields = invalidationSet(trigger);
  if (!fields.length) return { trigger, fields: [], stateVersion: globalVersion };
  for (const field of fields) {
    versions[field] = (versions[field] || 0) + 1;
    for (const fn of (listeners[field] || [])) {
      try { fn(meta, field, trigger); } catch (err) {
        console.error(`[brain/invalidation] listener for '${field}' threw: ${err?.message || err}`);
      }
    }
  }
  globalVersion += 1;
  console.log(`[brain/invalidation] ${trigger} → invalidated [${fields.join(', ')}] (state v${globalVersion})`);
  return { trigger, fields, stateVersion: globalVersion };
}

/**
 * Apply a change trigger and kick off a best-effort, FIRE-AND-FORGET durable
 * write-through so other instances/processes eventually converge on
 * refresh(). Use for mutations where cross-instance freshness isn't
 * immediately load-bearing for the response about to be sent.
 * @param {string} trigger one of TRIGGER.*
 * @param {object} [meta] passed through to listeners (e.g. { asOf })
 */
function bump(trigger, meta = {}) {
  const result = applyLocal(trigger, meta);
  if (result.fields.length) persist(result.fields).catch(() => {}); // persist() already catches internally; this is a pure safety net
  return result;
}

/** Same as bump(), but AWAITS the durable write before resolving, and persists
 *  EXACTLY ONCE (not bump()'s own fire-and-forget PLUS a second awaited
 *  call — see applyLocal's doc comment for the bug this replaced). Use when
 *  the caller must guarantee the invalidation is durably visible to other
 *  instances before it proceeds — e.g. after a transaction COMMITs and
 *  before responding to the client whose action caused the mutation, so a
 *  request that immediately hits a different instance can't observe
 *  pre-mutation state.
 *
 *  REJECTS (InvalidationPersistError) if the durable write itself fails —
 *  it does not silently succeed while only the in-process cache updated.
 *  This is deliberate: "durable" must mean something. A caller whose own
 *  data mutation already committed before this runs should let the
 *  rejection propagate as its own distinct application error (e.g. via
 *  asyncHandler → the central error middleware, same as any other thrown
 *  error) rather than retry the whole user action — the underlying mutation
 *  is not idempotent in general (re-running goal/commitment creation, a
 *  workout swap, etc. from scratch could duplicate it), so an automatic
 *  retry here is NOT safe. The honest outcome is: the user's data change is
 *  saved, but this response reports that cross-instance freshness could not
 *  be confirmed — never a silent "everything's fine" that isn't true. */
async function bumpDurable(trigger, meta = {}) {
  const result = applyLocal(trigger, meta);
  if (result.fields.length) await persistStrict(result.fields);
  return result;
}

/** Pull the authoritative (DB-backed) versions and merge them into the
 *  in-process cache by taking the max per field — so a change bumped by
 *  ANOTHER instance (or a previous process lifetime of THIS instance) becomes
 *  visible here. Call this before any staleness decision that must not
 *  silently depend on process-local memory alone. Best-effort: on DB failure,
 *  logs and returns the in-process values unchanged. */
async function refresh() {
  try {
    const db = require('../db');
    const { rows } = await db.query(`SELECT field, version FROM brain_state_version`);
    for (const row of rows) {
      const v = Number(row.version);
      if (row.field === GLOBAL_FIELD) globalVersion = Math.max(globalVersion, v);
      else versions[row.field] = Math.max(versions[row.field] ?? 0, v);
    }
  } catch (err) {
    console.error(`[brain/invalidation] refresh from DB failed (using in-process versions only): ${err.message}`);
  }
  return { versions: { ...versions }, stateVersion: globalVersion };
}

/** Current version of a single field (0 if never invalidated). Reads the
 *  in-process cache — call refresh() first for a cross-instance-authoritative
 *  read. */
function versionOf(field) { return versions[field] ?? 0; }

/** Monotonic global state version — bumps once per applied trigger (local
 *  cache; see versionOf's note on refresh()). */
function stateVersion() { return globalVersion; }

// ── Default side-effect wiring ───────────────────────────────────────────────
// A recovery change must drop the liveRecovery compute cache so the very next
// snapshot/brief/tab recomputes the score — otherwise the 2-minute promise cache
// would keep serving the pre-change value even though we just declared it stale.
// Lazy-require inside the listener to avoid any load-order cycle.
on('recovery', () => {
  try { require('../intelligence/recovery').invalidateRecoveryCache(); } catch { /* not loaded */ }
});

module.exports = { bump, bumpDurable, refresh, on, versionOf, stateVersion, TRIGGER, GLOBAL_FIELD, InvalidationPersistError };
