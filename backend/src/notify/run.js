// Proactive-nudge runner: read the current findings, decide what (if anything)
// is worth interrupting the day for, persist it, and push it to the phone.
//
// Use as a CLI on a morning schedule (`npm run nudge` via cron/launchd at ~7am)
// or trigger via POST /api/nudges/run. Honors quiet hours unless forced.
require('dotenv').config();
const { query } = require('../db');
const findingsStore = require('../store/findings');
const nudgesStore = require('../store/nudges');
const devicesStore = require('../store/devices');
const { buildNudges, withinQuietHours, checkinReminder } = require('../intelligence/nudges');
const { sendPush } = require('./expo');

/** Which of the given metrics are logged today (TZ-aware), as a Set. */
async function loggedMetricsToday(domain, source) {
  const tz = process.env.TZ || 'America/New_York';
  const { rows } = await query(
    `SELECT DISTINCT metric FROM metrics
      WHERE domain = $1 AND source = $2
        AND (ts AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date`,
    [domain, source, tz]
  );
  return new Set(rows.map((r) => r.metric));
}

// The fields each card needs for "fully logged" — reminder is silent only when
// ALL are present, so a partially-filled card still nudges.
const CHECKIN_FIELDS = ['mood', 'energy', 'focus'];
const HABIT_FIELDS = ['morning_tm', 'afternoon_tm', 'gratitude', 'cold_shower', 'exercise', 'eat_healthy'];

/** Is the check-in FULLY logged today (mood + energy + focus)? Fail-safe: assume
 *  yes on error so a DB hiccup never nags. */
async function checkinLoggedToday() {
  try {
    const have = await loggedMetricsToday('wellbeing', 'checkin');
    return CHECKIN_FIELDS.every((m) => have.has(m));
  } catch {
    return true;
  }
}

/**
 * @param {{ asOf?: Date, send?: boolean, force?: boolean, dedupDays?: number }} [opts]
 */
async function runNudges(opts = {}) {
  const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
  const send = opts.send !== false;
  const dedupDays = opts.dedupDays ?? 2;

  if (!opts.force && withinQuietHours(asOf)) {
    return { skipped: 'quiet_hours', generated: 0, sent: 0 };
  }

  const findings = await findingsStore.listFindings({ status: 'open', limit: 200 });
  const recentKeys = await nudgesStore.recentlySentKeys(dedupDays);
  // The check-in reminder has its own afternoon schedule (you can't rate your day
  // at 8am), so the morning routine suppresses it by reporting "already has one".
  const hasCheckinToday = opts.suppressCheckin ? true : await checkinLoggedToday(asOf);
  const candidates = buildNudges({ findings, recentKeys, hasCheckinToday, asOf });

  if (candidates.length === 0) {
    return { generated: 0, sent: 0, nudges: [] };
  }

  const tokens = send ? await devicesStore.listActiveTokens() : [];
  let sentCount = 0;
  const out = [];

  for (const n of candidates) {
    const status = send && tokens.length === 0 ? 'skipped' : 'pending';
    const id = await nudgesStore.recordNudge({ ...n, dedupKey: n.key, status });
    // null means another concurrent caller already claimed this exact nudge
    // (recordNudge's atomic dedup guard) — don't push a second time.
    if (id == null) { out.push({ ...n, skipped: 'concurrent_duplicate' }); continue; }

    if (send && tokens.length > 0) {
      try {
        const r = await sendPush(tokens, { title: n.title, body: n.body, data: { key: n.key } });
        for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
        await nudgesStore.markStatus(id, 'sent');
        sentCount += 1;
      } catch (err) {
        await nudgesStore.markStatus(id, 'failed');
        out.push({ ...n, error: err.message });
        continue;
      }
    }
    out.push(n);
  }

  return { generated: candidates.length, sent: sentCount, devices: tokens.length, nudges: out };
}

module.exports = { runNudges, runCheckinReminder, runEveningReminder };

/** Is the habit stack FULLY logged today (all 5 binary habits + eat_healthy)?
 *  Fail-safe: assume yes on error. */
async function habitsLoggedToday() {
  try {
    const have = await loggedMetricsToday('habits', 'habits');
    return HABIT_FIELDS.every((m) => have.has(m));
  } catch {
    return true;
  }
}

/** Shared: send a single reminder nudge if it hasn't been sent today. */
async function sendReminder(n, { send }) {
  const recent = await nudgesStore.recentlySentKeys(1);
  if (recent.has(n.key)) return { skipped: 'already_sent', sent: 0 };

  const tokens = send ? await devicesStore.listActiveTokens() : [];
  const status = send && tokens.length === 0 ? 'skipped' : 'pending';
  const id = await nudgesStore.recordNudge({ ...n, dedupKey: n.key, status });
  // null means another concurrent caller already claimed this exact nudge
  // (recordNudge's atomic dedup guard) — don't push a second time.
  if (id == null) return { skipped: 'concurrent_duplicate', sent: 0 };
  if (send && tokens.length > 0) {
    try {
      const r = await sendPush(tokens, { title: n.title, body: n.body, data: { key: n.key } });
      for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
      await nudgesStore.markStatus(id, 'sent');
      return { sent: 1, devices: tokens.length };
    } catch (err) {
      await nudgesStore.markStatus(id, 'failed');
      return { sent: 0, error: err.message };
    }
  }
  return { sent: 0, devices: tokens.length };
}

/**
 * Afternoon check-in reminder: push "log your mood/energy/focus" ONLY if it
 * hasn't been logged today. Run on its own ~3pm schedule (you can't rate your
 * day at 8am). Keyed per-day so it fires at most once.
 * @param {{ send?: boolean, force?: boolean }} [opts]
 */
async function runCheckinReminder(opts = {}) {
  const send = opts.send !== false;
  if (!opts.force && (await checkinLoggedToday())) {
    return { skipped: 'already_logged', sent: 0 };
  }
  return sendReminder(checkinReminder(new Date()), { send });
}

/** Has the user logged any day-context journal entry today? Fail-safe: assume
 *  yes on error so a DB hiccup never nags. */
async function dayContextLoggedToday() {
  try {
    const tz = process.env.TZ || 'America/New_York';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const entries = await require('../store/dayJournal').forDay(today);
    return entries.length > 0;
  } catch {
    return true;
  }
}

/**
 * Combined evening reminder (~9pm) — this used to be three separate pushes
 * (check-in, habits, "tell me about your day") landing within 5 minutes of
 * each other, all asking a version of "log something about today" (flagged in
 * the notification-load review). Now it's one push naming whichever pieces
 * are still open, firing once/day and only if at least one is outstanding.
 * Intentionally does NOT honor quiet hours — this IS the end-of-day nudge,
 * scheduled right at the quiet-hours boundary by design.
 * @param {{ send?: boolean, force?: boolean }} [opts]
 */
async function runEveningReminder(opts = {}) {
  const send = opts.send !== false;
  const [checkinDone, habitsDone, dayContextDone] = await Promise.all([
    checkinLoggedToday(),
    habitsLoggedToday(),
    dayContextLoggedToday(),
  ]);
  if (!opts.force && checkinDone && habitsDone && dayContextDone) {
    return { skipped: 'already_logged', sent: 0 };
  }

  const missing = [];
  if (!checkinDone) missing.push('how your day went');
  if (!habitsDone) missing.push("today's habits");
  if (!dayContextDone) missing.push('a quick recap');
  // force with everything already logged (manual test trigger) — still say something.
  const open = missing.length ? missing : ['a quick recap'];
  const body = open.length === 1
    ? `Before you wind down — log ${open[0]}?`
    : `Before you wind down — ${open.slice(0, -1).join(', ')} and ${open[open.length - 1]} are still open.`;

  const tz = process.env.TZ || 'America/New_York';
  const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  return sendReminder({
    key: `evening_reminder:${day}`,
    title: 'Quick evening check-in 🌙',
    body,
    priority: 0.6,
    basis: { type: 'evening_reminder', day, missing },
  }, { send });
}

module.exports.runEveningReminder = runEveningReminder;

// CLI entrypoint
if (require.main === module) {
  const { pool } = require('../db');
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  runNudges({ force, send: !dryRun })
    .then((s) => {
      if (s.skipped) return console.log(`Skipped (${s.skipped}).`);
      console.log(`Generated ${s.generated} nudge(s), sent ${s.sent} to ${s.devices ?? 0} device(s).`);
      for (const n of s.nudges) console.log(`  • [${n.priority}] ${n.title}: ${n.body}${n.error ? ` (error: ${n.error})` : ''}`);
    })
    .catch((err) => {
      console.error('Nudge run failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
