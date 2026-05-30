// Optional in-process scheduler so a single cloud instance runs its own morning
// routine — no external cron service needed. Enable with ENABLE_SCHEDULER=true.
//
// Times are in the server's local time; set the TZ env var (e.g. America/New_York)
// on your host so "7am" means your 7am. Defaults: ingest+analyze+nudge daily at
// 07:00, weekly review Monday 07:05. Every job is best-effort and isolated — one
// failing never stops the others or crashes the server.
const { runIngest } = require('./ingest/run');
const { analyze } = require('./intelligence/analyze');
const { runNudges } = require('./notify/run');
const { runReview } = require('./intelligence/review');

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
  try { await runIngest(); } catch (e) { console.error('[scheduler] ingest:', e.message); }
  try { await analyze(); } catch (e) { console.error('[scheduler] analyze:', e.message); }
  try { await runNudges({}); } catch (e) { console.error('[scheduler] nudge:', e.message); }
  console.log('[scheduler] morning routine done');
}

function start() {
  if (process.env.ENABLE_SCHEDULER !== 'true') return false;
  const hour = Number(process.env.SCHEDULE_HOUR) || 7;
  scheduleDaily(hour, 0, morningRoutine);
  scheduleWeekly(1, hour, 5, () => runReview()); // Monday
  console.log(`[scheduler] enabled — daily routine ${String(hour).padStart(2, '0')}:00, weekly review Mon ${String(hour).padStart(2, '0')}:05 (TZ=${process.env.TZ || 'system'})`);
  return true;
}

module.exports = { start, msUntil, morningRoutine };
