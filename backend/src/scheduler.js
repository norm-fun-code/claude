// Optional in-process scheduler so a single cloud instance runs its own morning
// routine — no external cron service needed. Enable with ENABLE_SCHEDULER=true.
//
// Times are in the server's local time; set the TZ env var (e.g. America/New_York)
// on your host so "7am" means your 7am. Defaults: ingest+analyze+nudge daily at
// 07:00, weekly review Sunday 07:10. Every job is best-effort and isolated — one
// failing never stops the others or crashes the server.
const ingestRun = require('./ingest/run');
const analyzeMod = require('./intelligence/analyze');
const { consolidate } = require('./intelligence/consolidate');
const crossContextMod = require('./intelligence/crossContext');
const experimentsMod = require('./intelligence/experiments');
const { runNudges, runCheckinReminder, runEveningReminder } = require('./notify/run');
const watchMod = require('./intelligence/watch');
const morningNotify = require('./notify/morning');
const { runEveningHealthBrief } = require('./notify/evening-brief');
const { runCommitmentReminders } = require('./notify/commitments');
const wealthNudgesMod = require('./intelligence/wealth-nudges');
const nudgesStore = require('./store/nudges');
const { pool } = require('./db');
const sleepReadiness = require('./intelligence/sleep-readiness');
const morningRetryLedger = require('./intelligence/morning-retry-ledger');

/** Is the Eight Sleep auto-sync configured (creds present)? */
function eightSleepConfigured() {
  return Boolean(process.env.EIGHT_SLEEP_EMAIL && process.env.EIGHT_SLEEP_PASSWORD);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local (TZ-aware) YYYY-MM-DD — toISOString() would give UTC and roll the date
 *  over at the wrong hour for the morning marker. Explicitly resolves via the
 *  configured TZ (not d.getFullYear()/etc., which are correct only insofar as
 *  the OS-level TZ env var happens to be set — an unenforced assumption that
 *  silently breaks the morning-routine dedup boundary if it's ever unset). */
function localDateKey(d = new Date()) {
  const tz = process.env.TZ || 'America/New_York';
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/** Per-day dedup key so the morning routine runs at most once per calendar day,
 *  whether it fired on the timer or as a startup catch-up. */
function morningKey(d = new Date()) {
  return `morning_routine:${localDateKey(d)}`;
}

/** Record that today's morning routine ran, so a later restart's catch-up check
 *  knows to skip it (prevents duplicate briefing pushes on repeated deploys). */
async function markMorningRan() {
  try {
    const id = await nudgesStore.recordNudge({
      dedupKey: morningKey(),
      title: 'morning routine ran',
      body: '',
      basis: { type: 'morning_marker' },
      status: 'sent',
    });
    if (id != null) await nudgesStore.markStatus(id, 'sent'); // populate sent_at
  } catch (e) {
    console.error('[scheduler] morning marker failed:', e.message);
  }
}

/** Did the morning routine already run today? Checks the dedup ledger.
 *  Tri-state (audit fix, item 7): a transient DB read failure is NEITHER
 *  "ran" nor "didn't run" — it's unknown, and the old code's "assume it ran"
 *  fail-safe against a duplicate push was ALSO a fail-closed against ever
 *  running/retrying the morning routine that day (a single blip silently
 *  skipped the whole day's brief). Returns { ran, error }: callers that only
 *  care about "should I skip" check `.ran`, but on `.error` they must NOT
 *  treat it as "ran" — they schedule a retry instead, relying on the
 *  existing push-dedup key (morningPushKey) and publish idempotency
 *  (morning.js's hasPublishableFreshBriefToday pre-check) to prevent an
 *  actual duplicate if the marker genuinely was already set. */
async function morningRanToday() {
  try {
    const keys = await nudgesStore.recentlySentKeys(1);
    return { ran: keys.has(morningKey()), error: false };
  } catch (e) {
    console.error('[scheduler] morning marker check failed (treating as UNKNOWN, not "ran" — will retry):', e.message);
    return { ran: false, error: true };
  }
}

/** ms from now until the next HH:MM (local), optionally restricted to a weekday (0=Sun). */
function msUntil(hour, minute, weekday = null) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  if (weekday != null) {
    while (next.getDay() !== weekday) next.setDate(next.getDate() + 1);
  }
  return next - now;
}

function scheduleDaily(hour, minute, fn) {
  const tick = () => {
    Promise.resolve().then(fn).catch((e) => console.error('[scheduler] job error:', e.message));
    setTimeout(tick, DAY_MS); // same time tomorrow
  };
  setTimeout(tick, msUntil(hour, minute));
}

function scheduleWeekly(weekday, hour, minute, fn) {
  const tick = () => {
    Promise.resolve().then(fn).catch((e) => console.error('[scheduler] job error:', e.message));
    setTimeout(tick, 7 * DAY_MS);
  };
  setTimeout(tick, msUntil(hour, minute, weekday));
}

// In-flight guard: morningRoutine is reachable from ~5 call sites (the daily
// tick, the startup catch-up path, and 3 distinct Eight-Sleep watcher
// backstops). The full routine (ingest + analyze + LLM narrative generation)
// can take well over the watcher's poll interval, and markMorningRan() only
// writes at the very end — so without this guard, a second tick can see
// "not run yet" while the first run is still in progress and fire a
// duplicate build + push. Same single-flight pattern as server.js's
// _rebuildInFlight for /api/briefing/rebuild.
let _morningRoutineInFlight = false;

/**
 * The single automatic morning entry point. EVERY automatic trigger — the
 * Eight Sleep watcher, the external cron, and the startup/redeploy catch-up —
 * funnels through here, so the sleep-readiness gate can never be bypassed by one
 * path keeping a weaker copy of the check.
 *
 * When Eight Sleep is configured and this isn't a forced/manual run:
 *   1. Skip if today's routine already ran (durable per-day marker).
 *   2. GATE on sleep-readiness. Not ready → return without building or pushing.
 *      There is no 10am "backstop" that overrides an unfinalized night anymore:
 *      a late or missed brief is preferable to an early one that wakes the user.
 *   3. Run the ONE final Eight Sleep ingest (inside runIngest below), so the
 *      brief reflects the finalized night's numbers.
 *   4. REVALIDATE readiness after that ingest — if the user climbed back into
 *      bed while it ran (presence now active), abort before building.
 *   5. Only then analyze + build + push, exactly once.
 *
 * force:true (admin/test) bypasses the gate entirely for deliberate testing.
 * @param {{ reason?: string, force?: boolean, asOf?: Date }} [opts]
 * @returns {Promise<{ built: boolean, sent?: number, skipped?: string, reason?: string }>}
 */
// Skip reasons that mean "no real generation attempt happened" — a hold like
// this must NEVER consume a bounded retry attempt (audit fix, item 6): the
// system wasn't ready to try, or another caller already owns the build, or a
// late safety re-check aborted before generation even ran. Only a genuine
// attempt that ran generation and came back non-fresh (or failed to persist)
// should count against the daily attempt cap.
const NO_ATTEMPT_SKIP_REASONS = new Set(['rebuild_in_progress', 'final_gate_failed']);

/** Nonessential post-brief work (audit fix, item 2): anomaly watch, cross-
 *  domain synthesis, experiment propose/autostart, and nudges all read
 *  today's already-ingested data but do NOT feed the BrainSnapshot the brief
 *  itself needs — buildFreshBriefing already runs its own analyze()/
 *  crossContext()/consolidate() internally as part of cutting that snapshot
 *  (see routes/briefing.js), so re-running them here BEFORE the brief was
 *  pure duplicated work sitting on the user-facing critical path. Fired
 *  without blocking the caller; each step is independently best-effort. */
function runNonEssentialMorningWork(label) {
  (async () => {
    try { await watchMod.runWatch(); } catch (e) { console.error('[scheduler] watch:', e.message); }
    try { await crossContextMod.generateCrossContext(); } catch (e) { console.error('[scheduler] crossContext:', e.message); }
    try {
      const p = await experimentsMod.proposeExperiments();
      if (p.created) console.log(`[scheduler] proposed ${p.created} new experiment(s)`);
      const started = await experimentsMod.autoStartExperiment();
      if (started) console.log(`[scheduler] auto-started experiment: "${started.hypothesis}"`);
    } catch (e) { console.error('[scheduler] experiments:', e.message); }
    try { await runNudges({ suppressCheckin: true }); } catch (e) { console.error('[scheduler] nudge:', e.message); }
    try {
      const w = await wealthNudgesMod.runWealthNudges({});
      if (w.sent > 0) console.log(`[scheduler] wealth nudges: sent=${w.sent}`);
    } catch (e) { console.error('[scheduler] wealth nudges:', e.message); }
    console.log(`[scheduler] post-brief housekeeping done (${label})`);
  })().catch((e) => console.error('[scheduler] post-brief housekeeping error:', e.message));
}

async function morningRoutine({ reason = 'scheduled', force = false, asOf = new Date() } = {}) {
  if (_morningRoutineInFlight) {
    console.log(`[scheduler] morning routine already in flight — skipping duplicate trigger (${reason})`);
    return { built: false, skipped: 'in_flight' };
  }
  _morningRoutineInFlight = true;
  try {
    if (!force) {
      const marker = await morningRanToday();
      if (marker.error) {
        console.log(`[scheduler] morning-marker lookup failed — treating as UNKNOWN, not skipping (${reason})`);
      } else if (marker.ran) {
        console.log(`[scheduler] morning already ran today — skipping (${reason})`);
        return { built: false, skipped: 'already_ran_today' };
      }
    }

    // A degraded automatic build (grounded-fallback/underfilled chief brief —
    // see brain/claimValidator.js's assessChiefBriefQuality) does NOT mark the
    // day done (below), so without this check every ~6-minute automatic
    // trigger would re-attempt the full expensive build (ingest+analyze+Opus)
    // chasing the same degraded result. Bounded backoff/attempt cap instead —
    // see intelligence/morning-retry-ledger.js. Gated on the CURRENT
    // readiness fingerprint (when Eight Sleep is configured) so a genuinely
    // new night's data resets an obsolete hold rather than waiting out a
    // backoff computed against yesterday's failed attempt.
    let currentFingerprint = null;
    if (!force) {
      if (eightSleepConfigured()) {
        try {
          const peek = await sleepReadiness.getMorningSleepReadiness({ asOf, trigger: `${reason}:fingerprint-peek` });
          currentFingerprint = peek.evidence?.fingerprint ?? null;
        } catch { /* non-critical — falls back to time-only backoff */ }
      }
      const attempt = await morningRetryLedger.canAttempt({ asOf, fingerprint: currentFingerprint });
      if (!attempt.allowed) {
        console.log(`[scheduler] morning retry backoff active — skipping (${reason}): ${attempt.reason}`);
        return { built: false, skipped: 'retry_backoff', reason: attempt.reason };
      }
    }

    const gated = !force && eightSleepConfigured();
    if (gated) {
      const readiness = await sleepReadiness.getMorningSleepReadiness({ asOf, trigger: reason });
      console.log(sleepReadiness.readinessLogLine(readiness));
      if (!readiness.ready) {
        return { built: false, skipped: 'not_ready', reason: readiness.reason };
      }
    }

    console.log(`[scheduler] morning routine starting (trigger: ${reason})`);
    // Critical path (audit fix, item 2): ONLY what's actually required to cut
    // an accurate BrainSnapshot and generate the brief. Use the smallest
    // existing TARGETED ingest (the same one routes/briefing.js's own
    // buildFreshBriefing pre-cut step already uses) rather than a full
    // all-connectors ingest — the brief only needs last night's Eight Sleep
    // data to be current before the readiness revalidation below; every
    // other connector's data is refreshed inside buildFreshBriefing itself
    // (analyze/crossContext/consolidate) or by primeNextBuildCycle after
    // publish. analyze()/watch()/crossContext()/experiments()/nudges()/
    // wealthNudges() all moved OFF this path — see runNonEssentialMorningWork
    // below, fired only AFTER the brief is durably published.
    try { await ingestRun.runIngest({ only: 'eight_sleep_api' }); } catch (e) { console.error('[scheduler] ingest:', e.message); }

    // Revalidate the finalized snapshot AFTER the final ingest — a bed re-entry
    // during ingest (presence flips active) must abort the build, not race it.
    if (gated) {
      const recheck = await sleepReadiness.getMorningSleepReadiness({ asOf: new Date(), trigger: `${reason}:revalidate` });
      console.log(sleepReadiness.readinessLogLine(recheck));
      if (!recheck.ready) {
        console.log('[scheduler] readiness revalidation failed after final ingest — aborting build (no brief, no push)');
        return { built: false, skipped: 'revalidation_failed', reason: recheck.reason };
      }
    }

    // Pre-build the briefing (warm the cache) and push "briefing ready", so the
    // app opens instantly with today's briefing instead of waiting to build it.
    // buildFreshBriefing (called inside runMorningBriefing) already runs its
    // own analyze()/crossContext()/consolidate() as part of cutting the
    // snapshot — nothing above duplicates that.
    let briefResult = { built: false, sent: 0 };
    try {
      briefResult = await morningNotify.runMorningBriefing({});
      console.log(`[scheduler] morning briefing: built=${briefResult.built} pushed=${briefResult.sent} quality=${briefResult.quality ?? 'n/a'}`);
    } catch (e) { console.error('[scheduler] morning briefing:', e.message); }
    // The day is only "done" on a genuine terminal outcome: the sleep
    // check-in prompt went out (waiting on the user to log, not a build
    // failure), OR a build actually published with FRESH quality. Anything
    // else (skipped, discarded by the final readiness gate, or published but
    // DEGRADED) must NOT burn the once-a-day marker — record the attempt in
    // the retry ledger instead so a later automatic trigger can try again,
    // bounded by its own backoff/attempt cap.
    const reachedTerminalOutcome = briefResult.sleepCheckIn === true
      || (briefResult.built === true && briefResult.quality === 'fresh')
      // A fresh brief already existed for today (built by a concurrent manual
      // rebuild, or an earlier automatic trigger this same morning) — the day
      // genuinely IS done, even though THIS call didn't do the building.
      || briefResult.skipped === 'already_built_today';
    if (reachedTerminalOutcome) {
      await markMorningRan();
      // Nonessential work runs AFTER the fresh brief is durably published —
      // never blocks marking the day done or the response the watcher/cron
      // caller sees.
      runNonEssentialMorningWork(reason);
    } else if (!force && !NO_ATTEMPT_SKIP_REASONS.has(briefResult.skipped)) {
      console.log(`[scheduler] morning routine did not reach a terminal outcome (built=${briefResult.built} quality=${briefResult.quality ?? 'n/a'} skipped=${briefResult.skipped ?? 'n/a'}) — NOT marking the day done; recording a retry attempt instead.`);
      const reason2 = briefResult.skipped === 'quality_not_fresh'
        ? (briefResult.quality === 'failed' ? morningRetryLedger.REASON.QUALITY_FAILED : morningRetryLedger.REASON.QUALITY_DEGRADED)
        : (briefResult.skipped === 'publish_failed' ? morningRetryLedger.REASON.PERSISTENCE_FAILED
          : (briefResult.skipped === 'draft_build_failed' ? morningRetryLedger.REASON.PROVIDER_FAILED : (briefResult.skipped || 'unknown')));
      await morningRetryLedger.recordAttempt({ asOf, reason: reason2, fingerprint: currentFingerprint });
    } else if (!force) {
      console.log(`[scheduler] morning routine held (${briefResult.skipped}) — not a generation attempt; retry ledger left untouched.`);
    }
    console.log('[scheduler] morning routine done');
    return { built: !!briefResult.built, sent: briefResult.sent || 0, quality: briefResult.quality ?? null, skipped: briefResult.skipped ?? null };
  } finally {
    _morningRoutineInFlight = false;
  }
}

// Once-per-day marker for the "gave up for the day" diagnostic, so it's logged
// exactly once (not every poll) after the give-up hour passes with no brief.
let giveupLoggedDay = null;

/**
 * Eight Sleep morning watcher — the data-arrival trigger. Poll through the
 * morning and let morningRoutine's sleep-readiness gate decide when (if ever)
 * last night's tracking is genuinely finalized, then build once.
 *
 * There is deliberately NO force-build backstop: if the night never finalizes
 * (still tracking, inconclusive, or the API is down) the brief is simply not
 * built — a late or missing brief is preferable to an early one that wakes the
 * user. After a configurable GIVE-UP hour we stop attempting for the day and log
 * a clear diagnostic (with the current readiness decision) so a held morning can
 * be understood, rather than guessing and building anyway.
 */
function startMorningWatcher() {
  const pollMin = Number(process.env.EIGHT_SLEEP_POLL_MIN) || 6;
  // Rate-limit guard against pointless overnight polling — the readiness gate,
  // not this floor, is what actually decides when to build.
  const pollStartHour = Number(process.env.EIGHT_SLEEP_POLL_START_HOUR) || 6;
  const pollStartMinute = Number(process.env.EIGHT_SLEEP_POLL_START_MINUTE) || 30;
  // Give-up hour: after this, stop trying for the day and leave the brief
  // unbuilt rather than force-building an unfinalized night. Default noon.
  const giveupHour = Number(process.env.EIGHT_SLEEP_GIVEUP_HOUR) || 12;
  const giveupMinute = Number(process.env.EIGHT_SLEEP_GIVEUP_MINUTE) || 0;

  const tick = async () => {
    try {
      const marker = await morningRanToday();
      if (marker.ran) return;
      if (marker.error) console.log('[scheduler] morning-marker lookup failed this poll — treating as unknown, will retry next poll');
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      if (mins < pollStartHour * 60 + pollStartMinute) return; // too early to poll

      if (mins >= giveupHour * 60 + giveupMinute) {
        // Past the cutoff with no finalized brief — do NOT build. Log once, with
        // the current sanitized readiness decision, so the hold is diagnosable.
        const day = localDateKey(now);
        if (giveupLoggedDay !== day) {
          giveupLoggedDay = day;
          console.log(`[scheduler] past give-up hour (${String(giveupHour).padStart(2, '0')}:${String(giveupMinute).padStart(2, '0')}) with no finalized sleep — leaving today's brief UNBUILT (no early/incomplete brief)`);
          try {
            const r = await sleepReadiness.getMorningSleepReadiness({ asOf: now, trigger: 'giveup-diagnostic' });
            console.log(sleepReadiness.readinessLogLine(r, { pastCutoff: true, pastGiveup: true }));
          } catch (e) { console.error('[scheduler] give-up diagnostic failed:', e.message); }
        }
        return;
      }

      // Gate lives inside morningRoutine — the watcher just asks it to try.
      const result = await morningRoutine({ reason: 'watcher', asOf: now });
      if (result.built) console.log(`[scheduler] watcher built the morning brief (sent=${result.sent})`);
    } catch (e) {
      console.error('[scheduler] watcher tick error:', e.message);
    }
  };

  setInterval(tick, pollMin * 60 * 1000);
  setTimeout(tick, 30 * 1000);
  console.log(
    `[scheduler] Eight Sleep watcher enabled — poll every ${pollMin}m from ` +
    `${String(pollStartHour).padStart(2, '0')}:${String(pollStartMinute).padStart(2, '0')}, ` +
    `give-up ${String(giveupHour).padStart(2, '0')}:${String(giveupMinute).padStart(2, '0')} (no force-build)`
  );
}

// Arbitrary constant identifying "the NormOS scheduler leader lock" in
// Postgres's advisory-lock keyspace (any int works; just needs to not
// collide with another feature's advisory lock, and none currently exist).
const LEADER_LOCK_ID = 727001;
let leaderClient = null;

/**
 * Postgres session-level advisory-lock leader election: only ONE process,
 * across however many replicas are running, ever holds this lock — so only
 * one instance's scheduler actually registers timers. Without this, N
 * replicas each running their own in-process scheduler would N-way
 * duplicate every scheduled job (morning routine, nudges, pushes, weekly
 * review...) the moment this app scales past a single instance.
 *
 * pg_try_advisory_lock is tied to the SESSION (connection) that acquired
 * it, so this deliberately bypasses the shared query() helper — that goes
 * through the pool, which checks connections back in after every call,
 * silently losing the lock's identity. A dedicated client is checked out
 * and held open for the process's lifetime instead.
 */
async function tryBecomeLeader() {
  try {
    leaderClient = await pool.connect();
    const { rows } = await leaderClient.query('SELECT pg_try_advisory_lock($1) AS acquired', [LEADER_LOCK_ID]);
    if (rows[0]?.acquired) return true;
    leaderClient.release();
    leaderClient = null;
    return false;
  } catch (e) {
    console.error('[scheduler] leader-election check failed — proceeding as leader (fail open):', e.message);
    if (leaderClient) { leaderClient.release(); leaderClient = null; }
    // Fail open: today's real deployment is a single instance, so a
    // transient DB hiccup during boot must not silently disable the
    // scheduler entirely. If this app ever does scale to 2+ replicas, a
    // failure here is rare enough that the small residual duplication risk
    // is far better than "the scheduler mysteriously stopped running."
    return true;
  }
}

/** Release the leader lock and close its dedicated connection, if held —
 *  graceful-shutdown hygiene, and lets tests reset state between cases. */
async function releaseLeaderLock() {
  if (!leaderClient) return;
  const c = leaderClient;
  leaderClient = null;
  try { await c.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_ID]); } catch { /* connection may already be gone */ }
  try { c.release(); } catch { /* already released */ }
}

// How often a dormant follower re-attempts the leader election. Kept short
// relative to the deploy overlap window so a promoted follower starts running
// jobs within seconds of the old leader dying.
const LEADER_RETRY_MS = Number(process.env.SCHEDULER_LEADER_RETRY_MS) || 30000;
let leaderRetryTimer = null;
let jobsStarted = false;

function start() {
  if (process.env.ENABLE_SCHEDULER !== 'true') {
    console.log('[scheduler] disabled — set ENABLE_SCHEDULER=true to enable the morning routine');
    return false;
  }
  // Leader election needs a DB round-trip, so it's deferred/async — start()
  // itself still returns synchronously (unchanged contract for server.js's
  // fire-and-forget call site).
  electLeaderThenStart();
  return true;
}

// Single-shot election was the root cause of "the scheduler mysteriously
// stopped running — nothing fired at all." During a deploy Railway briefly
// runs the OLD and NEW containers at once; a freshly-booted instance can lose
// the race for the advisory lock to the still-alive previous container, and
// the old code gave up FOREVER at that point ("not registering jobs here").
// Seconds later the old container is killed, its Postgres session ends, the
// lock frees — and nobody is left running the scheduler until the next deploy.
// A burst of deploys makes it near-certain to land in that leaderless state.
// Retrying until the lock frees means a follower always promotes itself once
// the old leader dies.
function electLeaderThenStart() {
  tryBecomeLeader()
    .then((isLeader) => {
      if (isLeader) {
        if (leaderRetryTimer) { clearTimeout(leaderRetryTimer); leaderRetryTimer = null; }
        startJobs();
        jobsStarted = true;
        return;
      }
      if (!leaderRetryTimer) {
        console.log(`[scheduler] leader lock held by another instance — retrying every ${Math.round(LEADER_RETRY_MS / 1000)}s until it frees`);
      }
      leaderRetryTimer = setTimeout(electLeaderThenStart, LEADER_RETRY_MS);
    })
    .catch((e) => {
      // tryBecomeLeader already fails open (returns true) on a DB error, so
      // reaching here is unusual — retry rather than silently give up.
      console.error('[scheduler] election attempt errored, will retry:', e.message);
      leaderRetryTimer = setTimeout(electLeaderThenStart, LEADER_RETRY_MS);
    });
}

/** Observable scheduler state for the health check / diagnostics — lets us
 *  confirm from OUTSIDE the process whether jobs are actually registered,
 *  instead of inferring it from the presence of a boot log line. */
function schedulerState() {
  return {
    enabled: process.env.ENABLE_SCHEDULER === 'true',
    isLeader: !!leaderClient,
    jobsStarted,
    awaitingLeadership: !!leaderRetryTimer,
  };
}

function startJobs() {
  const hour = Number(process.env.SCHEDULE_HOUR) || 8;       // default 8am
  const minute = Number(process.env.SCHEDULE_MINUTE) || 30;  // default :30

  if (eightSleepConfigured()) {
    // Data-driven: fire when last night's Eight Sleep session syncs (with a
    // backstop), so the brief reflects real overnight HRV/recovery — not a
    // fixed time that may land before you've even woken up.
    startMorningWatcher();
  } else {
    // No Eight Sleep auto-sync — fall back to the fixed morning time.
    scheduleDaily(hour, minute, morningRoutine);
    // Catch-up: the in-process timer only fires while the process is alive, so a
    // deploy/restart AFTER 8:30am pushes the next run to tomorrow — the morning
    // briefing silently never lands (while same-day jobs like the 3pm check-in
    // still re-arm). If we boot past 8:30am and today's routine hasn't run, run it
    // now. The per-day marker keeps repeated restarts from re-pushing.
    const now = new Date();
    const pastMorning = now.getHours() * 60 + now.getMinutes() >= hour * 60 + minute;
    if (pastMorning) {
      morningRanToday().then((marker) => {
        if (marker.ran) return;
        if (marker.error) {
          console.log('[scheduler] morning-marker lookup failed at boot — proceeding with catch-up rather than silently skipping the day');
        }
        console.log('[scheduler] booted after morning time with no run today — catching up');
        Promise.resolve().then(morningRoutine).catch((e) => console.error('[scheduler] catch-up error:', e.message));
      });
    }
  }
  // Weekly review generates Sunday morning (weekday 0), 10 min after the daily
  // routine's ingest/analyze, and pushes "your weekly review is ready".
  scheduleWeekly(0, hour, minute + 10, () => morningNotify.runWeeklyReviewWithPush({}));
  // Afternoon check-in reminder (3pm) — only pushes if you haven't logged your
  // mood/energy/focus yet (you can't meaningfully rate the day at 8am).
  const checkinHour = Number(process.env.CHECKIN_REMINDER_HOUR) || 15; // 3pm
  const checkinMinute = Number(process.env.CHECKIN_REMINDER_MINUTE) || 0;
  scheduleDaily(checkinHour, checkinMinute, () => runCheckinReminder({}));
  // Evening analyze + consolidate (9:30pm) — captures the day's check-in and habits
  // data, then rebuilds the self-model so every voice surface starts tomorrow
  // fully informed about who this person is.
  const analyzeEveningHour = Number(process.env.ANALYZE_EVENING_HOUR) || 21;
  const analyzeEveningMinute = Number(process.env.ANALYZE_EVENING_MINUTE) || 30;
  scheduleDaily(analyzeEveningHour, analyzeEveningMinute, async () => {
    try { await analyzeMod.analyze(); } catch (e) { console.error('[scheduler] evening analyze:', e.message); }
    try { await crossContextMod.generateCrossContext(); } catch (e) { console.error('[scheduler] evening crossContext:', e.message); }
    try { await consolidate(); console.log('[scheduler] self-model consolidated'); } catch (e) { console.error('[scheduler] consolidate:', e.message); }
    // Wind-down brief LAST, so it reads the freshest analyze/consolidate output.
    try {
      const r = await runEveningHealthBrief({});
      console.log(`[scheduler] evening wind-down brief: built=${r.built} pushed=${r.sent}`);
    } catch (e) { console.error('[scheduler] evening wind-down brief:', e.message); }
  });

  // Midday wealth watch (1pm + 5pm) — the temporal audit's scenario (b): a
  // large transaction or a budget crossing at 2pm used to produce no reaction
  // until tomorrow morning, because wealth nudges only ran in the morning
  // routine. runWealthNudges reads Monarch's budget pacing/recurring streams
  // LIVE (no stored-sync dependency) and dedupes each alert per billing
  // period, so extra runs are cheap and can never re-fire an already-sent
  // alert — these two checks purely narrow the notice-latency window.
  const wealthWatchHours = String(process.env.WEALTH_WATCH_HOURS || '13,17')
    .split(',').map((h) => Number(h.trim())).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  for (const h of wealthWatchHours) {
    scheduleDaily(h, 0, () => {
      wealthNudgesMod.runWealthNudges({}).then((r) => {
        if (r.sent > 0) console.log(`[scheduler] midday wealth watch: sent=${r.sent}`);
      }).catch((e) => console.error('[scheduler] midday wealth watch:', e.message));
    });
  }

  // Combined evening reminder (9pm) — used to be three separate pushes (evening
  // check-in, habits, "tell me about your day") landing within 5 minutes of each
  // other; merged into one that names whichever pieces are still open
  // (notification-load review). Only pushes if at least one is outstanding.
  const eveningReminderHour = Number(process.env.EVENING_REMINDER_HOUR) || 21; // 9pm
  const eveningReminderMinute = Number(process.env.EVENING_REMINDER_MINUTE) || 0;
  scheduleDaily(eveningReminderHour, eveningReminderMinute, () => runEveningReminder({}));

  // Commitment follow-through — the time-aware nudge. Unlike the fixed-time jobs
  // above, commitments come due at arbitrary user-chosen moments, so poll on a
  // short interval and fire the moment one is due (quiet hours + daily cap are
  // enforced inside the runner). Every few minutes is plenty — a reminder landing
  // within ~5 min of its time reads as "on time".
  // Precise near-term reminders are armed on-create (same process); this poll is
  // the backstop that catches anything armed before a restart, or set while the
  // process was down. A tight 2-min cadence keeps worst-case lateness small.
  const commitmentPollMin = Number(process.env.COMMITMENT_POLL_MIN) || 2;
  const commitmentTick = () => {
    runCommitmentReminders({}).then((r) => {
      if (r.sent > 0 || r.autoCompleted > 0) {
        console.log(`[scheduler] commitments: sent=${r.sent} autoCompleted=${r.autoCompleted} expired=${r.expired}`);
      }
    }).catch((e) => console.error('[scheduler] commitment reminders:', e.message));
  };
  setInterval(commitmentTick, commitmentPollMin * 60 * 1000);
  setTimeout(commitmentTick, 20 * 1000); // immediate catch-up shortly after boot

  const hm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const nextIso = (h, m) => new Date(Date.now() + msUntil(h, m)).toISOString();
  console.log(
    `[scheduler] enabled (TZ=${process.env.TZ || 'system/UTC'}) — ` +
    `morning ${hm(hour, minute)} (next: ${nextIso(hour, minute)}), ` +
    `check-in ${hm(checkinHour, checkinMinute)}, ` +
    `evening reminder ${hm(eveningReminderHour, eveningReminderMinute)}, ` +
    `analyze evening ${hm(analyzeEveningHour, analyzeEveningMinute)}`
  );
  return true;
}

module.exports = {
  start, msUntil, morningRoutine, morningRanToday, markMorningRan, localDateKey,
  eightSleepConfigured,
  tryBecomeLeader, releaseLeaderLock, schedulerState,
};
