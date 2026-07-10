// Optional in-process scheduler so a single cloud instance runs its own morning
// routine — no external cron service needed. Enable with ENABLE_SCHEDULER=true.
//
// Times are in the server's local time; set the TZ env var (e.g. America/New_York)
// on your host so "7am" means your 7am. Defaults: ingest+analyze+nudge daily at
// 07:00, weekly review Monday 07:05. Every job is best-effort and isolated — one
// failing never stops the others or crashes the server.
const { runIngest } = require('./ingest/run');
const { analyze } = require('./intelligence/analyze');
const { consolidate } = require('./intelligence/consolidate');
const { generateCrossContext } = require('./intelligence/crossContext');
const { autoStartExperiment, proposeExperiments } = require('./intelligence/experiments');
const { runNudges, runCheckinReminder, runEveningReminder } = require('./notify/run');
const { runWatch } = require('./intelligence/watch');
const { runMorningBriefing, runWeeklyReviewWithPush } = require('./notify/morning');
const { runEveningBriefing } = require('./notify/evening');
const { runEveningHealthBrief } = require('./notify/evening-brief');
const { runCommitmentReminders } = require('./notify/commitments');
const { runWealthNudges } = require('./intelligence/wealth-nudges');
const nudgesStore = require('./store/nudges');
const { runIngest: _runIngest } = require('./ingest/run');
const { query, pool } = require('./db');
const { getSource, updateConfig } = require('./store/sources');
const eightSleepApi = require('./services/eight-sleep-api');

/** Is the Eight Sleep auto-sync configured (creds present)? */
function eightSleepConfigured() {
  return Boolean(process.env.EIGHT_SLEEP_EMAIL && process.env.EIGHT_SLEEP_PASSWORD);
}

/** Has last night's Eight Sleep session posted to the spine for today? */
async function eightSleepReadyToday() {
  const tz = process.env.TZ || 'America/New_York';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const { rows } = await query(
    `SELECT 1 FROM metrics
      WHERE domain = 'health' AND metric = 'sleep_score' AND source = 'eight_sleep'
        AND date_trunc('day', ts AT TIME ZONE $1) = $2::date
        AND value > 0
      LIMIT 1`,
    [tz, today]
  );
  return rows.length > 0;
}

/** Retrieve a valid Eight Sleep token from the cached source config, re-logging
 *  if expired. Returns null if credentials aren't configured. */
async function getEightSleepCreds() {
  const email = process.env.EIGHT_SLEEP_EMAIL;
  const password = process.env.EIGHT_SLEEP_PASSWORD;
  if (!email || !password) return null;
  try {
    const source = await getSource('eight_sleep_api');
    const cfg = source?.config ?? {};
    if (cfg.eightToken && cfg.eightTokenExpiresAt && Date.now() < cfg.eightTokenExpiresAt - 60_000) {
      return { token: cfg.eightToken, userId: cfg.eightUserId };
    }
    const auth = await eightSleepApi.login(email, password);
    const newCfg = { ...cfg, eightToken: auth.token, eightUserId: cfg.eightUserId, eightTokenExpiresAt: auth.expiresAt };
    await updateConfig('eight_sleep_api', newCfg);
    return { token: auth.token, userId: cfg.eightUserId };
  } catch (e) {
    console.error('[scheduler] getEightSleepCreds failed:', e.message);
    return null;
  }
}

/** Returns true if an Eight Sleep interval is currently in progress (still sleeping).
 *  Fails SAFE — returns true (assume still sleeping) on any error or missing creds,
 *  so an API hiccup can never wake the user early. The backstop handles the case
 *  where this stays true all morning. */
async function eightSleepSessionInProgress() {
  try {
    const creds = await getEightSleepCreds();
    if (!creds?.token || !creds?.userId) return true; // can't check → assume sleeping
    return await eightSleepApi.getIntervalPresent(creds.token, creds.userId);
  } catch (e) {
    console.error('[scheduler] session-present check failed (assuming in-progress):', e.message);
    return true; // fail safe: don't fire if we can't confirm the session ended
  }
}

/**
 * Personal earliest-plausible-wake floor, in decimal hours since local midnight.
 *
 * Eight Sleep finalizes the night's interval when you enter the smart-alarm
 * wake window or briefly leave the bed — which can be HOURS before you actually
 * get up (sleep-in past the alarm, back to bed after a bathroom trip that the
 * Pod never re-opens a session for). The `/intervals/present` check then reads
 * "ended" for the rest of the morning, and a fixed 12-minute buffer happily
 * fires a 6:5x brief at a user who sleeps until 9. A single unverifiable
 * "session ended" bit is not evidence the user is UP — but their own trailing
 * wake-time history is evidence of when they plausibly COULD be up.
 *
 * Floor = 25th percentile of the last 14 days of `health:wake_time` (the
 * session-end clock time Eight Sleep itself reports, already ingested by the
 * connector) minus a 30-minute margin — early enough that a genuinely early
 * morning still lands on time, late enough that an alarm-window finalization
 * hours before their real wake can't fire the brief. Falls back to
 * EIGHT_SLEEP_MIN_WAKE_HOUR (default 7.5 = 7:30am) with thin history, and is
 * clamped so it can never move before the poll start nor pin against the
 * backstop. The backstop always overrides — a brief is never lost to this.
 */
async function personalWakeFloorHours({ pollStartH = 6.5, backstopH = 10 } = {}) {
  const fallback = Number(process.env.EIGHT_SLEEP_MIN_WAKE_HOUR) || 7.5;
  let floor = fallback;
  try {
    const { rows } = await query(
      `SELECT value FROM metrics
        WHERE domain = 'health' AND metric = 'wake_time' AND source = 'eight_sleep'
          AND ts >= now() - interval '14 days'
        ORDER BY value ASC`
    );
    const vals = rows.map((r) => Number(r.value)).filter(Number.isFinite);
    if (vals.length >= 5) {
      const p25 = vals[Math.floor(0.25 * (vals.length - 1))];
      floor = p25 - 0.5; // 30-minute margin under their own early-side wake
    }
  } catch (e) {
    console.error('[scheduler] wake-floor lookup failed (using fallback):', e.message);
  }
  return Math.min(Math.max(floor, pollStartH), backstopH - 0.75);
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

/** Did the morning routine already run today? Checks the dedup ledger. */
async function morningRanToday() {
  try {
    const keys = await nudgesStore.recentlySentKeys(1);
    return keys.has(morningKey());
  } catch (e) {
    // On error, assume it ran so we don't risk a duplicate push.
    console.error('[scheduler] morning marker check failed:', e.message);
    return true;
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

async function morningRoutine({ reason = 'scheduled' } = {}) {
  if (_morningRoutineInFlight) {
    console.log(`[scheduler] morning routine already in flight — skipping duplicate trigger (${reason})`);
    return;
  }
  _morningRoutineInFlight = true;
  try {
    console.log(`[scheduler] morning routine starting (trigger: ${reason})`);
    // Refresh the data + intelligence first, so the briefing reflects today.
    try { await runIngest(); } catch (e) { console.error('[scheduler] ingest:', e.message); }
    try { await analyze(); } catch (e) { console.error('[scheduler] analyze:', e.message); }
    // Anomaly watch on fresh overnight data — pushes "your HRV dropped" within the
    // morning routine (runNudges has no anomaly builder). Deduped to one ping per
    // metric per day, so a same-night HTTP ingest that already fired won't repeat.
    try { await runWatch(); } catch (e) { console.error('[scheduler] watch:', e.message); }
    // Synthesize the day's cross-domain relationships into plain-language insights.
    try { await generateCrossContext(); } catch (e) { console.error('[scheduler] crossContext:', e.message); }
    // Propose new experiments from fresh correlations, then auto-start one if the
    // queue is empty — keeps the hypothesis loop self-sustaining.
    try {
      const p = await proposeExperiments();
      if (p.created) console.log(`[scheduler] proposed ${p.created} new experiment(s)`);
      const started = await autoStartExperiment();
      if (started) console.log(`[scheduler] auto-started experiment: "${started.hypothesis}"`);
    } catch (e) { console.error('[scheduler] experiments:', e.message); }
    // Check-in reminder is suppressed here — it has its own 3pm schedule.
    try { await runNudges({ suppressCheckin: true }); } catch (e) { console.error('[scheduler] nudge:', e.message); }
    // Wealth threshold alerts: over-budget categories, new recurring charges.
    try {
      const w = await runWealthNudges({});
      if (w.sent > 0) console.log(`[scheduler] wealth nudges: sent=${w.sent}`);
    } catch (e) { console.error('[scheduler] wealth nudges:', e.message); }
    // Pre-build the briefing (warm the cache) and push "briefing ready", so the
    // app opens instantly with today's briefing instead of waiting to build it.
    try {
      const r = await runMorningBriefing({});
      console.log(`[scheduler] morning briefing: built=${r.built} pushed=${r.sent}`);
    } catch (e) { console.error('[scheduler] morning briefing:', e.message); }
    // Mark the day done so a post-8:30am restart's catch-up check skips it.
    await markMorningRan();
    console.log('[scheduler] morning routine done');
  } finally {
    _morningRoutineInFlight = false;
  }
}

/**
 * Eight Sleep morning watcher — the data-arrival trigger. Instead of firing the
 * morning brief at a fixed clock time, poll Eight Sleep through the morning and
 * run the routine the moment last night's session posts. Self-adjusts to when
 * you actually wake. A backstop time guarantees a brief still lands on days the
 * data never shows (didn't sleep on the Pod, API down).
 */
// When we first observe the Eight Sleep session as ended (this process run). The
// session's "present interval" disappears a few minutes BEFORE the smart alarm
// fires (Eight Sleep finalizes once you enter the wake-up light-sleep window), so
// we hold a short wake buffer past this before building — otherwise the brief
// lands while the user is still asleep. Reset whenever the session reads in
// progress again. Module-level so it persists across ticks; a process restart
// resets it, which is fine (the once-per-day guard prevents a double brief).
let sessionEndedSeenAt = null;

function startMorningWatcher() {
  // Poll fairly often so the wake buffer below resolves promptly (the buffer, not
  // the poll cadence, is what gates the build).
  const pollMin = Number(process.env.EIGHT_SLEEP_POLL_MIN) || 6;
  // This floor is a rate-limit guard against pointless overnight polling, not the
  // wake-detection logic itself (that's the stillSleeping + wake-buffer check
  // below, which already adapts to whenever the session really ends). Still, early
  // morning sleep is lighter and more prone to brief stirring, so keep some margin
  // before the earliest realistic wake rather than pushing this down to the floor.
  const pollStartHour = Number(process.env.EIGHT_SLEEP_POLL_START_HOUR) || 6;
  const pollStartMinute = Number(process.env.EIGHT_SLEEP_POLL_START_MINUTE) || 30;
  const backstopHour = Number(process.env.EIGHT_SLEEP_BACKSTOP_HOUR) || 10;
  const backstopMinute = Number(process.env.EIGHT_SLEEP_BACKSTOP_MINUTE) || 0;
  // How long after the session reads "ended" to wait before building, so the brief
  // lands after the smart alarm / actual wake rather than in the gap before it.
  const wakeBufferMs = (Number(process.env.EIGHT_SLEEP_WAKE_BUFFER_MIN) || 12) * 60 * 1000;

  const tick = async () => {
    try {
      if (await morningRanToday()) return;
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      if (mins < pollStartHour * 60 + pollStartMinute) return; // too early
      const pastBackstop = mins >= backstopHour * 60 + backstopMinute;

      let ready = false;
      try {
        await _runIngest({ only: 'eight_sleep_api' });
        ready = await eightSleepReadyToday();
      } catch (e) {
        console.error('[scheduler] eight-sleep poll failed:', e.message);
      }

      if (ready) {
        // Eight Sleep can return a non-zero score for an in-progress session.
        // Check the /intervals/present endpoint to confirm the session has ended
        // before waking the user with a "briefing ready" push.
        const stillSleeping = await eightSleepSessionInProgress();
        if (stillSleeping) {
          sessionEndedSeenAt = null; // back in a session — restart the buffer clock
          if (pastBackstop) {
            console.log('[scheduler] Eight Sleep session still flagged in-progress past backstop — firing anyway');
            await morningRoutine({ reason: 'eight-sleep data arrived (backstop)' });
          } else {
            console.log('[scheduler] Eight Sleep score ready but session still in progress — waiting for wake');
          }
        } else {
          // Session reads ended. Hold a wake buffer past the first time we see it
          // ended, so we don't fire in the gap before the smart alarm wakes them.
          if (sessionEndedSeenAt == null) sessionEndedSeenAt = Date.now();
          const sinceEnded = Date.now() - sessionEndedSeenAt;
          // Personal wake floor: an "ended" reading long before the user's own
          // typical wake is Eight Sleep finalizing at the alarm window / a bed
          // exit — NOT the user being up. Don't fire on it; keep ticking. If the
          // Pod re-opens a session (they're back asleep), the stillSleeping
          // branch resets the buffer; otherwise the brief fires the moment the
          // floor passes (buffer already satisfied). Backstop always overrides.
          const floorH = await personalWakeFloorHours({
            pollStartH: pollStartHour + pollStartMinute / 60,
            backstopH: backstopHour + backstopMinute / 60,
          });
          const beforeFloor = mins < Math.round(floorH * 60);
          if (beforeFloor && !pastBackstop) {
            console.log(`[scheduler] Eight Sleep session reads ended ${Math.round(sinceEnded / 60000)}m ago, but it's before the personal wake floor (${floorH.toFixed(2)}h) — holding (alarm-window finalization protection)`);
          } else if (sinceEnded >= wakeBufferMs || pastBackstop) {
            await morningRoutine({ reason: 'eight-sleep data arrived (post-wake buffer)' });
          } else {
            console.log(`[scheduler] Eight Sleep session ended ${Math.round(sinceEnded / 60000)}m ago — holding ${Math.round(wakeBufferMs / 60000)}m wake buffer before briefing`);
          }
        }
      } else if (pastBackstop) {
        await morningRoutine({ reason: 'backstop (no eight-sleep data yet)' });
      }
    } catch (e) {
      console.error('[scheduler] watcher tick error:', e.message);
    }
  };

  setInterval(tick, pollMin * 60 * 1000);
  setTimeout(tick, 30 * 1000);
  console.log(
    `[scheduler] Eight Sleep watcher enabled — poll every ${pollMin}m from ` +
    `${String(pollStartHour).padStart(2, '0')}:${String(pollStartMinute).padStart(2, '0')}, ` +
    `backstop ${String(backstopHour).padStart(2, '0')}:${String(backstopMinute).padStart(2, '0')}`
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
      morningRanToday().then((ran) => {
        if (ran) return;
        console.log('[scheduler] booted after morning time with no run today — catching up');
        Promise.resolve().then(morningRoutine).catch((e) => console.error('[scheduler] catch-up error:', e.message));
      });
    }
  }
  // Weekly review generates Sunday morning (weekday 0), 10 min after the daily
  // routine's ingest/analyze, and pushes "your weekly review is ready".
  scheduleWeekly(0, hour, minute + 10, () => runWeeklyReviewWithPush({}));
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
    try { await analyze(); } catch (e) { console.error('[scheduler] evening analyze:', e.message); }
    try { await generateCrossContext(); } catch (e) { console.error('[scheduler] evening crossContext:', e.message); }
    try { await consolidate(); console.log('[scheduler] self-model consolidated'); } catch (e) { console.error('[scheduler] consolidate:', e.message); }
    // Wind-down brief LAST, so it reads the freshest analyze/consolidate output.
    try {
      const r = await runEveningHealthBrief({});
      console.log(`[scheduler] evening wind-down brief: built=${r.built} pushed=${r.sent}`);
    } catch (e) { console.error('[scheduler] evening wind-down brief:', e.message); }
  });

  // Combined evening reminder (9pm) — used to be three separate pushes (evening
  // check-in, habits, "tell me about your day") landing within 5 minutes of each
  // other; merged into one that names whichever pieces are still open
  // (notification-load review). Only pushes if at least one is outstanding.
  const eveningReminderHour = Number(process.env.EVENING_REMINDER_HOUR) || 21; // 9pm
  const eveningReminderMinute = Number(process.env.EVENING_REMINDER_MINUTE) || 0;
  scheduleDaily(eveningReminderHour, eveningReminderMinute, () => runEveningReminder({}));

  // PM / EOD briefing (6pm) — spend snapshot, portfolio performance, budget flags.
  const eveningBriefingHour = Number(process.env.EVENING_BRIEFING_HOUR) || 18; // 6pm
  const eveningBriefingMinute = Number(process.env.EVENING_BRIEFING_MINUTE) || 0;
  scheduleDaily(eveningBriefingHour, eveningBriefingMinute, () => runEveningBriefing({}));

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
  eightSleepConfigured, eightSleepSessionInProgress, personalWakeFloorHours,
  tryBecomeLeader, releaseLeaderLock, schedulerState,
};
