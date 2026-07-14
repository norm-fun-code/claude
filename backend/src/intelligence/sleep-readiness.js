// Authoritative morning-sleep readiness gate.
//
// THE PRODUCT RULE (strict): when Eight Sleep is configured, never automatically
// build or push the morning brief until the night's tracking is genuinely
// finalized. A late or missed automatic brief is preferable to an early,
// incomplete brief that wakes the user. Every automatic trigger — the in-process
// watcher, the external cron, the startup/redeploy catch-up, and the automatic
// morning routine — funnels through getMorningSleepReadiness(). No trigger may
// keep a weaker duplicate of this logic.
//
// WHY THE OLD LOGIC WAS UNSAFE:
//   - `/intervals/present` returning null/404 was treated as proof the night
//     finished. That endpoint is CURRENT PRESENCE, not finalization — a bathroom
//     trip the Pod never re-opens a session for, or Eight Sleep finalizing at the
//     smart-alarm window hours before real wake, both read "not present".
//   - A 12-minute buffer + historical wake-time floor PREDICTED when the user
//     might be awake; it never PROVED tracking ended.
//   - A 10am backstop deliberately overrode an active/incomplete session.
//
// THE EVIDENCE MODEL (honest about what the private API actually exposes — see
// scripts/eight-sleep-probe.js for the observed trends shape):
//   - `/intervals/present` active  -> DEFINITELY not ready (hard veto + reset).
//   - `/intervals/present` null/404 -> inconclusive; NOT sufficient on its own.
//   - A finalized, wake-dated trend for TODAY (nonzero score AND sleepDuration)
//     is the required primary evidence.
//   - STABILITY is the finalization proxy. While the user is still in bed the
//     night's presenceDuration / sleepDuration / stage durations keep growing
//     every poll, so the snapshot fingerprint keeps changing. Once tracking is
//     truly finalized those values freeze. Two identical fingerprints separated
//     by the normal polling interval == finalized-and-stable. (The private API
//     exposes no literal "End tracking" event, so finalized+stable trend data is
//     the required proxy — we do NOT invent a field that isn't there.)
//   - `presenceEnd`, WHEN the API populates it, is the moment presence ended; we
//     additionally require it to be at least ~12 minutes old so a just-ended
//     session isn't mistaken for a settled morning. When the API doesn't provide
//     it, the stability window carries the staleness requirement alone.
//   - Any API error / malformed response FAILS CLOSED (not ready).
//
// The per-day stability state is persisted in Postgres (the `sources` config
// row) so a Railway restart or replica change cannot turn one observation into a
// false "stable" state — the observation count is only ever what was genuinely
// persisted across real polls, and yesterday's state can never satisfy today.
const eightSleepApi = require('../services/eight-sleep-api');
const { registerSource, getSource, updateConfig } = require('../store/sources');

const READINESS_SOURCE_ID = 'eight_sleep_readiness';
const MIN = 60 * 1000;

/** Tunable thresholds (env-overridable). Kept in one place so the diagnostic
 *  endpoint can report exactly what gate the morning is being held against. */
function thresholds(overrides = {}) {
  return {
    // How many consecutive polls must show the SAME finalized fingerprint.
    minObservations: Number(process.env.EIGHT_SLEEP_MIN_OBSERVATIONS) || 2,
    // The finalized snapshot must have been unchanged for at least this long —
    // the "separated by the normal polling interval" requirement, made robust to
    // a fast poll cadence. Default ~10 min.
    minStabilityMs: (Number(process.env.EIGHT_SLEEP_STABILITY_MIN_MIN) || 10) * MIN,
    // When presenceEnd IS available, it must be at least this old (10–15 min).
    telemetryMinAgeMs: (Number(process.env.EIGHT_SLEEP_TELEMETRY_MIN_MIN) || 12) * MIN,
    ...overrides,
  };
}

/** Local calendar day (YYYY-MM-DD) in the given tz — wake-date convention. */
function localDay(d, tz) {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Parse a timestamp field that may be an ISO string or epoch ms/seconds. */
function parseTs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Pull presenceEnd from whichever path the API happens to use, if any. We only
 *  READ fields that may exist; a missing presenceEnd is normal, not an error. */
function extractPresenceEnd(day) {
  const raw = day?.presenceEnd
    ?? day?.presenceInfo?.presenceEnd
    ?? day?.presenceInfo?.end
    ?? day?.timing?.presenceEnd
    ?? day?.timingInfo?.presenceEnd
    ?? null;
  return parseTs(raw);
}

/**
 * Build the finalization-sensitive snapshot of a wake-dated trend `day`. Every
 * field here CHANGES while the user is still in bed / tracking continues and
 * FREEZES once the night is finalized — that is what makes the fingerprint a
 * valid finalization proxy. `hasFinalizedTrend` gates whether there's a real,
 * scored night at all (a provisional 0-score in-progress session is not one).
 */
function extractFinalizedSnapshot(day) {
  if (!day || !day.day) return { hasFinalizedTrend: false };
  const sq = day.sleepQualityScore || {};
  const snap = {
    day: day.day,
    score: num(day.score),
    sleepDuration: num(day.sleepDuration),
    presenceDuration: num(day.presenceDuration),
    deepDuration: num(day.deepDuration),
    remDuration: num(day.remDuration),
    lightDuration: num(day.lightDuration),
    hrv: num(sq.hrv?.current),
    restingHr: num(sq.heartRate?.current),
    respiratoryRate: num(sq.respiratoryRate?.current),
    presenceEnd: extractPresenceEnd(day),
  };
  // A finalized night has a real score AND a real sleep duration. A nonzero
  // PROVISIONAL score can appear mid-session, which is exactly why score alone
  // is insufficient — but score>0 combined with the stability window below is
  // safe: a provisional score's companion durations are still growing, so its
  // fingerprint won't hold still across two polls.
  snap.hasFinalizedTrend = snap.score != null && snap.score > 0
    && snap.sleepDuration != null && snap.sleepDuration > 0;
  return snap;
}

/** Deterministic fingerprint of the finalization-sensitive fields. */
function fingerprintOf(snap) {
  return JSON.stringify([
    snap.day, snap.score, snap.sleepDuration, snap.presenceDuration,
    snap.deepDuration, snap.remDuration, snap.lightDuration,
    snap.hrv, snap.restingHr, snap.respiratoryRate, snap.presenceEnd,
  ]);
}

// ── Durable per-day stability state (survives Railway restarts) ──────────────

async function defaultLoadState() {
  try {
    const src = await getSource(READINESS_SOURCE_ID);
    return src?.config?.readiness ?? null;
  } catch (e) {
    console.error('[readiness] state load failed (treating as fresh):', e.message);
    return null;
  }
}

async function defaultSaveState(state) {
  try {
    await registerSource({ id: READINESS_SOURCE_ID, domain: 'health', displayName: 'Eight Sleep readiness state' });
    // `sources.config || $patch` replaces the whole `readiness` key wholesale
    // (top-level shallow merge) — exactly what we want, no nested-merge hazard.
    await updateConfig(READINESS_SOURCE_ID, { readiness: state });
  } catch (e) {
    console.error('[readiness] state save failed (continuing):', e.message);
  }
}

/**
 * The authoritative gate. Returns { ready, reason, evidence } — never throws.
 *
 * @param {Object}  opts
 * @param {Date}    [opts.asOf]     evaluation time (injectable for tests)
 * @param {string}  [opts.trigger]  who's asking ('watcher'|'cron'|'catchup'|...)
 * @param {string}  [opts.tz]
 * @param {Object}  [opts.deps]     { getCreds, getIntervalPresent, getTrends, loadState, saveState }
 * @param {Object}  [opts.config]   threshold overrides
 */
async function getMorningSleepReadiness({ asOf = new Date(), trigger = 'unknown', tz, deps = {}, config = {} } = {}) {
  const timezone = tz || process.env.TZ || 'America/New_York';
  const th = thresholds(config);
  const now = asOf.getTime();
  const today = localDay(asOf, timezone);

  const getCreds = deps.getCreds || (() => eightSleepApi.getCreds());
  const getIntervalPresent = deps.getIntervalPresent || ((t, u) => eightSleepApi.getIntervalPresent(t, u));
  const getTrends = deps.getTrends || ((args) => eightSleepApi.getTrends(args));
  const loadState = deps.loadState || defaultLoadState;
  const saveState = deps.saveState || defaultSaveState;

  const evidence = {
    trigger, day: today, presence: 'unknown', presenceEndAvailable: false,
    hasFinalizedTrend: false, fingerprint: null, observations: 0,
    stableForMs: 0, telemetryAgeMs: null, thresholds: th,
  };
  const done = (ready, reason) => ({ ready, reason, evidence });

  // The whole body is wrapped so this gate NEVER throws — a caller in the
  // scheduler's hot path must always get a structured not-ready, never a
  // rejected promise it might fail to catch (which would fail OPEN).
  try {
    // Prior-day state can NEVER satisfy today. Reload, and if it's for a
    // different local day, start clean so yesterday's "stable" can't leak in.
    let prior;
    try {
      prior = await loadState();
    } catch (e) {
      console.error('[readiness] state load failed (treating as fresh):', e.message);
      prior = null;
    }
    if (!prior || prior.day !== today) prior = { day: today, fingerprint: null, observations: 0, firstStableAt: null };

    // A best-effort persist that itself never throws out of the gate.
    const persist = async (s) => { try { await saveState(s); } catch (e) { console.error('[readiness] state save failed (continuing):', e.message); } };

    // Credentials. null == genuinely not configured (caller shouldn't have
    // gated); a THROW == can't confirm -> fail closed.
    let creds;
    try {
      creds = await getCreds();
    } catch (e) {
      console.error('[readiness] credential fetch failed — failing closed:', e.message);
      return done(false, 'credentials_failed');
    }
    if (!creds?.token || !creds?.userId) return done(false, 'not_configured');

    // 1) Presence is a VETO/SUPPORTING signal only. Active -> definitely not
    //    ready and reset stability. Error -> fail closed. null/404 -> inconclusive.
    let present;
    try {
      present = await getIntervalPresent(creds.token, creds.userId);
    } catch (e) {
      console.error('[readiness] present check failed — failing closed:', e.message);
      return done(false, 'present_check_failed');
    }
    if (present) {
      evidence.presence = 'active';
      await persist({ day: today, fingerprint: null, observations: 0, firstStableAt: null });
      return done(false, 'session_active');
    }
    evidence.presence = 'inactive';

    // 2) Finalized trend for TODAY is the primary evidence.
    let days;
    try {
      const yesterday = localDay(new Date(now - 24 * 60 * MIN), timezone);
      days = await getTrends({ token: creds.token, userId: creds.userId, from: yesterday, to: today, tz: timezone });
    } catch (e) {
      console.error('[readiness] trends fetch failed — failing closed:', e.message);
      return done(false, 'trends_fetch_failed');
    }
    const todayTrend = Array.isArray(days) ? days.find((d) => d?.day === today) : null;
    const snap = extractFinalizedSnapshot(todayTrend);
    evidence.hasFinalizedTrend = !!snap.hasFinalizedTrend;
    evidence.presenceEndAvailable = snap.presenceEnd != null;
    if (!snap.hasFinalizedTrend) {
      // Nothing finalized to be stable ABOUT — clear any partial stability.
      await persist({ day: today, fingerprint: null, observations: 0, firstStableAt: null });
      return done(false, 'no_finalized_trend');
    }

    // 3) Stability: same fingerprint across ≥minObservations polls, ≥minStabilityMs.
    const fingerprint = fingerprintOf(snap);
    evidence.fingerprint = fingerprint;
    const continues = prior.fingerprint === fingerprint;
    const observations = continues ? (prior.observations || 0) + 1 : 1;
    const firstStableAt = continues && prior.firstStableAt ? prior.firstStableAt : now;
    const stableForMs = now - firstStableAt;
    const telemetryAgeMs = snap.presenceEnd != null ? now - snap.presenceEnd : null;

    evidence.observations = observations;
    evidence.stableForMs = stableForMs;
    evidence.telemetryAgeMs = telemetryAgeMs;

    await persist({
      day: today, fingerprint, observations, firstStableAt,
      presenceEnd: snap.presenceEnd, updatedAt: now,
    });

    // 4) Gates. presenceEnd age only applies when the API actually gives us one.
    const telemetryOk = telemetryAgeMs == null || telemetryAgeMs >= th.telemetryMinAgeMs;
    const stableOk = observations >= th.minObservations && stableForMs >= th.minStabilityMs;
    if (!telemetryOk) return done(false, 'telemetry_too_recent');
    if (!stableOk) return done(false, 'insufficient_stability');
    return done(true, 'ready');
  } catch (e) {
    console.error('[readiness] unexpected error — failing closed:', e.message);
    return done(false, 'readiness_error');
  }
}

/**
 * Compact, secret-free one-line summary of a readiness decision for the logs.
 * Deliberately excludes tokens, credentials, raw telemetry, and API bodies —
 * only decision-shaped booleans/durations that explain WHY a morning is held.
 */
function readinessLogLine(result, { pastCutoff = false, pastGiveup = false } = {}) {
  const e = result.evidence;
  const secs = (ms) => (ms == null ? 'n/a' : `${Math.round(ms / 1000)}s`);
  return `[readiness] trigger=${e.trigger} ready=${result.ready} reason=${result.reason} `
    + `presence=${e.presence} presenceEnd=${e.presenceEndAvailable} finalizedTrend=${e.hasFinalizedTrend} `
    + `telemetryAge=${secs(e.telemetryAgeMs)} stableFor=${secs(e.stableForMs)} obs=${e.observations} `
    + `pastCutoff=${pastCutoff} pastGiveup=${pastGiveup}`;
}

module.exports = {
  getMorningSleepReadiness,
  readinessLogLine,
  // exported for unit tests + the diagnostic endpoint
  extractFinalizedSnapshot,
  extractPresenceEnd,
  fingerprintOf,
  thresholds,
  READINESS_SOURCE_ID,
};
