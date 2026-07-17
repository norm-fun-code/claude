// Runtime state-invalidation bus — the piece that makes registry.js's dependency
// graph ACTUALLY drive behavior instead of being test/documentation-only.
//
// When a mutation lands (a recovery self-report, a workout override, a Monarch
// transaction sync, a goal/commitment change, an annotation retirement), the
// mutation site calls `bump(TRIGGER.X)`. This module looks up the transitive set
// of registered fields that change is defined to invalidate (registry.invalidationSet),
// increments each field's version + a global state version, and fires any
// registered side-effect listeners (e.g. clearing the liveRecovery compute cache
// so the next read recomputes). Consumers that cache derived state can compare
// `versionOf(field)` / `stateVersion()` to know their copy is stale — and, crucially,
// a recovery change now invalidates recovery, effectiveWorkout, todayForecast, AND
// recoveryComposite atomically through ONE declared graph, not a hand-maintained
// "also refresh X" list copied into each call site.
'use strict';

const { TRIGGER, invalidationSet, FIELDS } = require('./registry');

// Per-field monotonic version + a global counter. Process-local: this is a
// single-instance app (see the scheduler leader-election / advisory-lock notes),
// so an in-process bus is the right scope. A future multi-instance deployment
// would back this with LISTEN/NOTIFY or a version row — the call sites wouldn't
// change, only this module's storage.
const versions = Object.create(null);
for (const key of Object.keys(FIELDS)) versions[key] = 0;
let globalVersion = 0;

// field -> [listener]. Listeners run side effects (cache clears) on invalidation.
const listeners = Object.create(null);

/** Register a side-effect that fires whenever `field` is invalidated. */
function on(field, fn) {
  (listeners[field] || (listeners[field] = [])).push(fn);
}

/**
 * Apply a change trigger: invalidate every field the registry says it reaches
 * (transitively), bump versions, and fire listeners. Returns the invalidated
 * field set + the new global version. Safe to call on any mutation — an unknown
 * trigger invalidates nothing.
 * @param {string} trigger one of TRIGGER.*
 * @param {object} [meta] passed through to listeners (e.g. { asOf })
 */
function bump(trigger, meta = {}) {
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

/** Current version of a single field (0 if never invalidated). */
function versionOf(field) { return versions[field] ?? 0; }

/** Monotonic global state version — bumps once per applied trigger. */
function stateVersion() { return globalVersion; }

// ── Default side-effect wiring ───────────────────────────────────────────────
// A recovery change must drop the liveRecovery compute cache so the very next
// snapshot/brief/tab recomputes the score — otherwise the 2-minute promise cache
// would keep serving the pre-change value even though we just declared it stale.
// Lazy-require inside the listener to avoid any load-order cycle.
on('recovery', () => {
  try { require('../intelligence/recovery').invalidateRecoveryCache(); } catch { /* not loaded */ }
});

module.exports = { bump, on, versionOf, stateVersion, TRIGGER };
