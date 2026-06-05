// Optional in-process scheduler so a single cloud instance runs its own morning
// routine — no external cron service needed. Enable with ENABLE_SCHEDULER=true.
//
// Times are in the server's local time; set the TZ env var (e.g. America/New_York)
// on your host so "7am" means your 7am. Defaults: ingest+analyze+nudge daily at
// 07:00, weekly review Monday 07:05. Every job is best-effort and isolated — one
// failing never stops the others or crashes the server.
const { runIngest } = require('./ingest/run');
const { analyze } = require('./intelligence/analyze');
const { runNudges, runCheckinReminder, runHabitsReminder } = require('./notify/run');
const { runMorningBriefing, runWeeklyReviewWithPush } = require('./notify/morning');

const DAY_MS = 24 * 60 * 60 * 1000;

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
  console.log('[scheduler] morning routine done');
}

function start() {
  if (process.env.ENABLE_SCHEDULER !== 'true') return false;
  const hour = Number(process.env.SCHEDULE_HOUR) || 8;       // default 8am
  const minute = Number(process.env.SCHEDULE_MINUTE) || 30;  // default :30
  scheduleDaily(hour, minute, morningRoutine);
  // Weekly review generates Sunday morning (weekday 0), 10 min after the daily
  // routine's ingest/analyze, and pushes "your weekly review is ready".
  scheduleWeekly(0, hour, minute + 10, () => runWeeklyReviewWithPush({}));
  // Afternoon check-in reminder (3pm) — only pushes if you haven't logged your
  // mood/energy/focus yet (you can't meaningfully rate the day at 8am).
  const checkinHour = Number(process.env.CHECKIN_REMINDER_HOUR) || 15; // 3pm
  const checkinMinute = Number(process.env.CHECKIN_REMINDER_MINUTE) || 0;
  scheduleDaily(checkinHour, checkinMinute, () => runCheckinReminder({}));
  // Evening habits reminder (10pm) — only pushes if you haven't logged habits yet.
  const habitsHour = Number(process.env.HABITS_REMINDER_HOUR) || 22; // 10pm
  const habitsMinute = Number(process.env.HABITS_REMINDER_MINUTE) || 0;
  scheduleDaily(habitsHour, habitsMinute, () => runHabitsReminder({}));
  const hm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  console.log(`[scheduler] enabled — morning ${hm(hour, minute)}, weekly review Sun ${hm(hour, minute + 10)}, check-in ${hm(checkinHour, checkinMinute)}, habits ${hm(habitsHour, habitsMinute)} (TZ=${process.env.TZ || 'system'})`);
  return true;
}

module.exports = { start, msUntil, morningRoutine };
