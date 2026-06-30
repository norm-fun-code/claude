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
const { runNudges, runCheckinReminder, runCheckinEveningReminder, runHabitsReminder } = require('./notify/run');
const { runWatch } = require('./intelligence/watch');
const { runMorningBriefing, runWeeklyReviewWithPush } = require('./notify/morning');
const { runEveningBriefing } = require('./notify/evening');
const { runEveningHealthBrief } = require('./notify/evening-brief');
const { runWealthNudges } = require('./intelligence/wealth-nudges');
const nudgesStore = require('./store/nudges');
const { runIngest: _runIngest } = require('./ingest/run');
const { query } = require('./db');
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local (TZ-aware) YYYY-MM-DD — toISOString() would give UTC and roll the date
 *  over at the wrong hour for the morning marker. */
function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

async function morningRoutine({ reason = 'scheduled' } = {}) {
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
  const pollStartHour = Number(process.env.EIGHT_SLEEP_POLL_START_HOUR) || 7;
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
          if (sinceEnded >= wakeBufferMs || pastBackstop) {
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

function start() {
  if (process.env.ENABLE_SCHEDULER !== 'true') {
    console.log('[scheduler] disabled — set ENABLE_SCHEDULER=true to enable the morning routine');
    return false;
  }
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
  // Evening check-in reminder (9pm) — second nudge with a different dedup key
  // so it can fire even if the 3pm one sent (user may have ignored it).
  const checkinEveningHour = Number(process.env.CHECKIN_EVENING_REMINDER_HOUR) || 21; // 9pm
  const checkinEveningMinute = Number(process.env.CHECKIN_EVENING_REMINDER_MINUTE) || 0;
  scheduleDaily(checkinEveningHour, checkinEveningMinute, () => runCheckinEveningReminder({}));

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

  // Evening habits reminder (9pm) — only pushes if you haven't logged habits yet.
  const habitsHour = Number(process.env.HABITS_REMINDER_HOUR) || 21; // 9pm
  const habitsMinute = Number(process.env.HABITS_REMINDER_MINUTE) || 0;
  scheduleDaily(habitsHour, habitsMinute, () => runHabitsReminder({}));

  // PM / EOD briefing (6pm) — spend snapshot, portfolio performance, budget flags.
  const eveningBriefingHour = Number(process.env.EVENING_BRIEFING_HOUR) || 18; // 6pm
  const eveningBriefingMinute = Number(process.env.EVENING_BRIEFING_MINUTE) || 0;
  scheduleDaily(eveningBriefingHour, eveningBriefingMinute, () => runEveningBriefing({}));

  const hm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const nextIso = (h, m) => new Date(Date.now() + msUntil(h, m)).toISOString();
  console.log(
    `[scheduler] enabled (TZ=${process.env.TZ || 'system/UTC'}) — ` +
    `morning ${hm(hour, minute)} (next: ${nextIso(hour, minute)}), ` +
    `check-in ${hm(checkinHour, checkinMinute)}, ` +
    `check-in evening ${hm(checkinEveningHour, checkinEveningMinute)}, ` +
    `analyze evening ${hm(analyzeEveningHour, analyzeEveningMinute)}, ` +
    `habits ${hm(habitsHour, habitsMinute)}`
  );
  return true;
}

module.exports = { start, msUntil, morningRoutine, morningRanToday, markMorningRan, localDateKey };
