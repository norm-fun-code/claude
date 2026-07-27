// Durable per-day backoff ledger for the automatic morning build.
//
// A DEGRADED automatic attempt (a valid brief that fell back to grounded
// placeholder text, or is otherwise underfilled — see brain/claimValidator.js's
// assessChiefBriefQuality) is not a success: the scheduler must be allowed to
// try again later in the morning once more context has arrived (recovery
// drivers, resolved-context annotations, etc. that simply weren't present at
// the automatic build's moment). But without a backoff, the scheduler's own
// short poll cadence would burn Opus calls every few minutes chasing the same
// degraded result. This ledger tracks, per local calendar day: how many
// automatic attempts have been made, and when the last one ran — so a retry
// is allowed only after a configurable cooldown, and capped at a configurable
// number of attempts per day. Mirrors sleep-readiness.js's durable-state
// pattern (Postgres via store/sources.js, reset on a new local day, injectable
// deps for tests).
const { registerSource, getSource, updateConfig } = require('../store/sources');

const LEDGER_SOURCE_ID = 'morning_build_retry';
const MIN = 60 * 1000;
const DEFAULT_BACKOFF_STEPS_MIN = [5, 15, 30];

function parseStepsMin(raw, fallback) {
  if (!raw) return fallback;
  const parsed = String(raw).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length ? parsed : fallback;
}

function config(overrides = {}) {
  return {
    // Bounded STEPPED backoff (audit fix, item E): a rejected draft is no
    // longer published at all (see notify/morning.js's fresh-before-publish
    // invariant), so a flat 20-minute wait before the first retry is too
    // slow — nothing displayable exists in the meantime. Each successive
    // degraded attempt waits progressively longer instead of hammering Opus
    // every few minutes chasing the same result: first retry ~5min, second
    // ~15min, third-and-later ~30min. backoffForAttempts() below indexes
    // this by the number of attempts ALREADY recorded today.
    backoffStepsMs: parseStepsMin(process.env.MORNING_RETRY_BACKOFF_STEPS_MIN, DEFAULT_BACKOFF_STEPS_MIN).map((m) => m * MIN),
    // Hard cap on automatic attempts per day — after this many degraded
    // attempts, stop retrying until tomorrow rather than burning tokens
    // indefinitely on a night that just isn't going to produce a fresh brief.
    maxAttemptsPerDay: Number(process.env.MORNING_RETRY_MAX_ATTEMPTS) || 5,
    ...overrides,
  };
}

/** The backoff to apply before the NEXT attempt, given how many attempts
 *  have already been recorded today. Attempt 1 recorded -> waiting for
 *  attempt 2 uses steps[0] (first retry); attempt 2 recorded -> steps[1]
 *  (second retry); every attempt beyond the configured steps reuses the
 *  last (largest) step rather than growing unbounded. */
function backoffForAttempts(attempts, cfg) {
  const steps = cfg.backoffStepsMs;
  const idx = Math.min(Math.max(attempts - 1, 0), steps.length - 1);
  return steps[idx];
}

function localDay(d, tz) {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

async function defaultLoad() {
  try {
    const src = await getSource(LEDGER_SOURCE_ID);
    return src?.config?.ledger ?? null;
  } catch (e) {
    console.error('[morning-retry] state load failed (treating as fresh):', e.message);
    return null;
  }
}

async function defaultSave(state) {
  try {
    await registerSource({ id: LEDGER_SOURCE_ID, domain: 'system', displayName: 'Morning build retry ledger' });
    await updateConfig(LEDGER_SOURCE_ID, { ledger: state });
  } catch (e) {
    console.error('[morning-retry] state save failed (continuing):', e.message);
  }
}

// Reason codes a caller may pass to recordAttempt (item 6, reason-aware
// retries). 'not_ready'/'lock_contention' are never actually recorded — see
// scheduler.js's NO_ATTEMPT_SKIP_REASONS — but are listed here so callers and
// tests share one vocabulary instead of inventing ad hoc strings per site.
const REASON = Object.freeze({
  QUALITY_DEGRADED: 'quality_degraded',       // generateChiefBrief returned degraded content
  QUALITY_FAILED: 'quality_failed',           // generateChiefBrief returned no usable shape
  PERSISTENCE_FAILED: 'persistence_failed',   // the draft was fresh but saveBriefing failed
  PROVIDER_FAILED: 'provider_failed',         // the draft build itself threw (network/LLM outage)
  FINAL_GATE_FAILED: 'final_gate_failed',     // late readiness re-check failed (not a generation issue)
});

/** Pure decision: given the persisted ledger state, is another automatic
 *  attempt allowed right now? Yesterday's (or any other day's) state can
 *  never gate today — a fresh day always starts with a clean allowance.
 *  `currentFingerprint` (the sleep-readiness gate's OWN fingerprint for this
 *  poll, when the caller has it) resets an obsolete hold: if new overnight
 *  data has genuinely changed since the last recorded attempt, there's no
 *  reason to keep waiting out a backoff computed against stale evidence —
 *  the previous degraded/failed attempt was against a DIFFERENT snapshot. */
function evaluate(state, { today, now, cfg, currentFingerprint = null }) {
  if (!state || state.day !== today) return { allowed: true, reason: 'first_attempt_today' };
  if (currentFingerprint != null && state.fingerprint != null && currentFingerprint !== state.fingerprint) {
    return { allowed: true, reason: 'fingerprint_changed' };
  }
  if (state.attempts >= cfg.maxAttemptsPerDay) return { allowed: false, reason: 'max_attempts_reached' };
  const backoffMs = backoffForAttempts(state.attempts, cfg);
  const sinceLastMs = now - state.lastAttemptAt;
  if (sinceLastMs < backoffMs) return { allowed: false, reason: 'backoff_active' };
  return { allowed: true, reason: 'backoff_elapsed' };
}

/** @param {{ asOf?: Date, tz?: string, deps?: { load?: Function }, config?: Object, fingerprint?: string|null }} [opts] */
async function canAttempt({ asOf = new Date(), tz = process.env.TZ || 'America/New_York', deps = {}, config: overrides = {}, fingerprint = null } = {}) {
  const cfg = config(overrides);
  const load = deps.load || defaultLoad;
  const today = localDay(asOf, tz);
  let state = null;
  try {
    state = await load();
  } catch (e) {
    console.error('[morning-retry] state load failed (treating as fresh):', e.message);
  }
  return evaluate(state, { today, now: asOf.getTime(), cfg, currentFingerprint: fingerprint });
}

/** Record that a real generation attempt just happened and did NOT result in
 *  a published fresh brief (degraded/failed/persistence-failed/provider-failed
 *  — NOT called for a successful fresh-and-published build, and NOT called
 *  for a hold that was never a generation attempt at all — not_ready, lock
 *  contention, or a late final-readiness-gate failure; see scheduler.js's
 *  NO_ATTEMPT_SKIP_REASONS). `reason` is one of the REASON codes above, kept
 *  purely for diagnostics (the backoff math is unchanged by which reason
 *  fired). `fingerprint`, when passed, lets a LATER call's `currentFingerprint`
 *  detect that fresh overnight data has arrived and reset an obsolete hold.
 *  Never throws. */
async function recordAttempt({ asOf = new Date(), tz = process.env.TZ || 'America/New_York', deps = {}, reason = null, fingerprint = null } = {}) {
  const load = deps.load || defaultLoad;
  const save = deps.save || defaultSave;
  const today = localDay(asOf, tz);
  let prior = null;
  try {
    prior = await load();
  } catch (e) {
    console.error('[morning-retry] state load failed (treating as fresh):', e.message);
  }
  const attempts = (prior && prior.day === today ? prior.attempts : 0) + 1;
  const state = { day: today, attempts, lastAttemptAt: asOf.getTime(), lastReason: reason, fingerprint };
  await save(state);
  return state;
}

module.exports = { canAttempt, recordAttempt, evaluate, config, backoffForAttempts, LEDGER_SOURCE_ID, REASON };
