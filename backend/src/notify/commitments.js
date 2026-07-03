// Commitment follow-through runner — the time-aware half of the loop. Polled by
// the scheduler every few minutes; when a commitment comes due it fires ONE
// well-timed push ("you said you'd wind down early — now's the moment"), then
// marks it reminded so it never nags twice.
//
// Restraint is the whole point (same philosophy as the brief's one open
// question): a follow-up system that fires constantly gets muted in a week, one
// that speaks rarely gets trusted. So the pure selector below enforces quiet
// hours, a hard daily cap, and — crucially — never nudges about something the
// data already shows you did.
require('dotenv').config();
const { query } = require('../db');
const commitmentsStore = require('../store/commitments');
const devicesStore = require('../store/devices');
const { withinQuietHours } = require('../intelligence/nudges');
const { sendPush } = require('./expo');

const DEFAULT_MAX_PER_DAY = Number(process.env.COMMITMENT_MAX_PER_DAY) || 4;
// Re-nudge cadence for a commitment you haven't done or skipped yet.
const RENUDGE_HOURS = Number(process.env.COMMITMENT_RENUDGE_HOURS) || 3;
const MAX_REMINDERS = Number(process.env.COMMITMENT_MAX_REMINDERS) || 4;
const STALE_HOURS = Number(process.env.COMMITMENT_STALE_HOURS) || 24;

/**
 * Pure: decide what to do with the set of currently-due commitments.
 * Splits them into ones to auto-complete silently (the data already shows they
 * happened) and ones to actually push — the push list bounded by quiet hours and
 * the remaining daily budget.
 *
 * @param {Array} due - open, due, unreminded commitments (from the store)
 * @param {object} opts
 * @param {Set<number>} [opts.satisfiedIds] - ids whose outcome metric is already logged today
 * @param {number} [opts.maxPerDay]
 * @param {number} [opts.sentToday] - reminders already fired today
 * @param {boolean} [opts.quiet] - within quiet hours (suppresses pushes, not auto-completes)
 * @returns {{ toFire: Array, toAutoComplete: Array }}
 */
function selectReminderActions(due = [], { satisfiedIds = new Set(), maxPerDay = DEFAULT_MAX_PER_DAY, sentToday = 0, quiet = false } = {}) {
  const toAutoComplete = due.filter((c) => satisfiedIds.has(c.id));
  const pushable = due.filter((c) => !satisfiedIds.has(c.id));
  // Auto-completes are silent and data-driven, so they're fine any time; only the
  // actual pushes answer to quiet hours and the daily budget.
  const budget = quiet ? 0 : Math.max(0, maxPerDay - sentToday);
  const toFire = pushable.slice(0, budget);
  return { toFire, toAutoComplete };
}

/** Which of these commitments have their outcome metric already logged today? */
async function satisfiedCommitmentIds(due, tz) {
  const withMetric = due.filter((c) => c.metric_key && c.metric_key.includes(':'));
  if (!withMetric.length) return new Set();
  const ids = new Set();
  for (const c of withMetric) {
    const [domain, metric] = c.metric_key.split(':');
    try {
      const { rows } = await query(
        `SELECT 1 FROM metrics
          WHERE domain = $1 AND metric = $2 AND value >= 0.5
            AND (ts AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date
          LIMIT 1`,
        [domain, metric, tz]
      );
      if (rows.length) ids.add(c.id);
    } catch { /* metric check is best-effort */ }
  }
  return ids;
}

/**
 * Fire due commitment reminders. Best-effort and idempotent (marks each reminded
 * so a later poll won't repeat it).
 * @param {{ now?: Date, send?: boolean, force?: boolean, tz?: string, maxPerDay?: number }} [opts]
 */
async function runCommitmentReminders(opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const send = opts.send !== false;
  const tz = opts.tz || process.env.TZ || 'America/New_York';
  const maxPerDay = opts.maxPerDay ?? DEFAULT_MAX_PER_DAY;

  // Age out anything long overdue first, so it can't be nudged uselessly late.
  const expired = await commitmentsStore.expireStale({ now, staleHours: STALE_HOURS }).catch(() => 0);

  // Both first reminders AND follow-ups for still-open commitments.
  const due = await commitmentsStore.dueForReminder({
    now, reNudgeHours: RENUDGE_HOURS, maxReminders: MAX_REMINDERS, maxAgeHours: STALE_HOURS,
  });
  if (!due.length) return { due: 0, sent: 0, autoCompleted: 0, expired };

  const [satisfiedIds, sentToday] = await Promise.all([
    satisfiedCommitmentIds(due, tz),
    commitmentsStore.remindersSentToday(tz),
  ]);
  const quiet = !opts.force && withinQuietHours(now);
  const { toFire, toAutoComplete } = selectReminderActions(due, { satisfiedIds, maxPerDay, sentToday, quiet });

  // Silent auto-completes: the metric already proves it happened.
  for (const c of toAutoComplete) {
    await commitmentsStore.markDone(c.id, { at: now }).catch(() => {});
    await commitmentsStore.markReminded(c.id, { at: now }).catch(() => {});
  }

  let sent = 0;
  if (send && toFire.length) {
    const tokens = await devicesStore.listActiveTokens();
    for (const c of toFire) {
      if (tokens.length) {
        try {
          // reminder_count reflects PRIOR nudges (incremented after this send),
          // so >0 means this is a follow-up: prompt to close the loop.
          const followUp = (c.reminder_count ?? 0) > 0;
          const r = await sendPush(tokens, {
            title: followUp ? 'Still on your list' : 'You committed to this',
            body: followUp ? `${c.title} — did you do it? Mark it done or skip.` : c.title,
            data: { type: 'commitment', id: c.id },
          });
          for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
          sent += 1;
        } catch (err) {
          console.error('[commitments] push failed:', err.message);
        }
      }
      await commitmentsStore.markReminded(c.id, { at: now }).catch(() => {});
    }
  }

  return { due: due.length, sent, autoCompleted: toAutoComplete.length, expired, suppressed: quiet && toFire.length === 0 && due.length > toAutoComplete.length };
}

/**
 * Fire a precise one-shot reminder at `dueAt`, so a short-fuse commitment ("remind
 * me in 2 minutes") lands on time instead of waiting for the next coarse poll.
 * The API and scheduler share one process, so the create path can arm this
 * directly. Only arms things due within `horizonH` (the poll + grace window is
 * the backstop for anything further out or lost to a restart). Idempotent: the
 * runner marks reminded, so a redundant poll won't double-send.
 */
function armPreciseReminder(dueAt, { horizonH = 3, send = true } = {}) {
  if (!dueAt) return null;
  const when = new Date(dueAt).getTime();
  if (Number.isNaN(when)) return null;
  const delay = when - Date.now();
  if (delay <= 0 || delay > horizonH * 60 * 60 * 1000) return null;
  // +1.5s so due_at <= now() is comfortably true when the runner queries.
  const timer = setTimeout(() => {
    runCommitmentReminders({ send }).catch((e) => console.error('[commitments] armed run failed:', e.message));
  }, delay + 1500);
  if (typeof timer.unref === 'function') timer.unref(); // don't keep the process alive just for this
  return timer;
}

module.exports = { runCommitmentReminders, selectReminderActions, armPreciseReminder, DEFAULT_MAX_PER_DAY };

// CLI: node src/notify/commitments.js [--force] [--dry-run]
if (require.main === module) {
  const { pool } = require('../db');
  runCommitmentReminders({ force: process.argv.includes('--force'), send: !process.argv.includes('--dry-run') })
    .then((r) => console.log('[commitments]', JSON.stringify(r)))
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => pool.end());
}
