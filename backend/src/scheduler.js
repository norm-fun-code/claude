// Optional in-process scheduler so a single cloud instance runs its own morning
// routine — no external cron service needed. Enable with ENABLE_SCHEDULER=true.
//
// Times are in the server's local time; set the TZ env var (e.g. America/New_York)
// on your host so "7am" means your 7am. Defaults: ingest+analyze+nudge daily at
// 07:00, weekly review Monday 07:05. Every job is best-effort and isolated — one
// failing never stops the others or crashes the server.
const { runIngest } = require('./ingest/run');
const { analyze } = require('./intelligence/analyze');
const { runNudges, runCheckinReminder, runCheckinEveningReminder, runHabitsReminder } = require('./notify/run');
const { runMorningBriefing, runWeeklyReviewWithPush } = require('./notify/morning');
const nudgesStore = require('./store/nudges');

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

async function morningRoutine() {
  console.log('[scheduler] morning routine starting');
  // Refresh the data + intelligence first, so the briefing reflects today.
  try { await runIngest(); } catch (e) { console.error('[scheduler] ingest:', e.message); }
  try { await analyze(); } catch (e) { console.error('[scheduler] analyze:', e.message); }
  // Check-in reminder is suppressed here — it has its own 3pm schedule.
  try { await runNudges({ suppressCheckin: true }); } catch (e) { console.error('[scheduler] nudge:', e.message); }
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

function start() {
  if (process.env.ENABLE_SCHEDULER !== 'true') {
    console.log('[scheduler] disabled — set ENABLE_SCHEDULER=true to enable the morning routine');
    return false;
  }
  const hour = Number(process.env.SCHEDULE_HOUR) || 8;       // default 8am
  const minute = Number(process.env.SCHEDULE_MINUTE) || 30;  // default :30
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

  // Evening analyze re-run (9:30pm) — captures the day's check-in and habits
  // data so insights are current when you review them before bed.
  const analyzeEveningHour = Number(process.env.ANALYZE_EVENING_HOUR) || 21;
  const analyzeEveningMinute = Number(process.env.ANALYZE_EVENING_MINUTE) || 30;
  scheduleDaily(analyzeEveningHour, analyzeEveningMinute, async () => {
    try { await analyze(); } catch (e) { console.error('[scheduler] evening analyze:', e.message); }
  });

  // Evening habits reminder (10pm) — only pushes if you haven't logged habits yet.
  const habitsHour = Number(process.env.HABITS_REMINDER_HOUR) || 22; // 10pm
  const habitsMinute = Number(process.env.HABITS_REMINDER_MINUTE) || 0;
  scheduleDaily(habitsHour, habitsMinute, () => runHabitsReminder({}));
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
