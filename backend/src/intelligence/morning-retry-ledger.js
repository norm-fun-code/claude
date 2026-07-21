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

function config(overrides = {}) {
  return {
    // How long to wait after a degraded automatic attempt before trying again.
    backoffMs: (Number(process.env.MORNING_RETRY_BACKOFF_MIN) || 20) * MIN,
    // Hard cap on automatic attempts per day — after this many degraded
    // attempts, stop retrying until tomorrow rather than burning tokens
    // indefinitely on a night that just isn't going to produce a fresh brief.
    maxAttemptsPerDay: Number(process.env.MORNING_RETRY_MAX_ATTEMPTS) || 5,
    ...overrides,
  };
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

/** Pure decision: given the persisted ledger state, is another automatic
 *  attempt allowed right now? Yesterday's (or any other day's) state can
 *  never gate today — a fresh day always starts with a clean allowance. */
function evaluate(state, { today, now, cfg }) {
  if (!state || state.day !== today) return { allowed: true, reason: 'first_attempt_today' };
  if (state.attempts >= cfg.maxAttemptsPerDay) return { allowed: false, reason: 'max_attempts_reached' };
  const sinceLastMs = now - state.lastAttemptAt;
  if (sinceLastMs < cfg.backoffMs) return { allowed: false, reason: 'backoff_active' };
  return { allowed: true, reason: 'backoff_elapsed' };
}

/** @param {{ asOf?: Date, tz?: string, deps?: { load?: Function }, config?: Object }} [opts] */
async function canAttempt({ asOf = new Date(), tz = process.env.TZ || 'America/New_York', deps = {}, config: overrides = {} } = {}) {
  const cfg = config(overrides);
  const load = deps.load || defaultLoad;
  const today = localDay(asOf, tz);
  let state = null;
  try {
    state = await load();
  } catch (e) {
    console.error('[morning-retry] state load failed (treating as fresh):', e.message);
  }
  return evaluate(state, { today, now: asOf.getTime(), cfg });
}

/** Record that an automatic attempt just happened (degraded/skipped/failed —
 *  NOT called for a successful fresh-and-published build, since the ledger
 *  only exists to pace RETRIES). Never throws. */
async function recordAttempt({ asOf = new Date(), tz = process.env.TZ || 'America/New_York', deps = {} } = {}) {
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
  const state = { day: today, attempts, lastAttemptAt: asOf.getTime() };
  await save(state);
  return state;
}

module.exports = { canAttempt, recordAttempt, evaluate, config, LEDGER_SOURCE_ID };
