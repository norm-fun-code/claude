// Morning briefing pre-build + push. Runs on the scheduler (~8am): forces a
// fresh briefing build so the cache is warm when you open the app (no 15-40s
// wait), then sends a "Your morning briefing is ready!" push to your devices.
//
// We warm the cache by calling our own /api/briefing?refresh=1 over loopback —
// the exact code path the app uses — so there's no duplicate briefing logic to
// drift. The bearer token (if set) is included so the auth gate lets us through.
const devicesStore = require('../store/devices');
const { sendPush } = require('./expo');

// Default: don't auto-rebuild + push if the user already built a brief within
// the last 2 hours (opened the app / hit Rebuild this morning). Overridable via
// BRIEFING_FRESH_SKIP_MS (0 disables the guard entirely).
const FRESH_SKIP_MS = Number(process.env.BRIEFING_FRESH_SKIP_MS ?? 2 * 60 * 60 * 1000);

/**
 * Pure: was a briefing built recently enough that an automatic rebuild + "ready"
 * push would be redundant? `lastGeneratedAt` is the newest daily briefing's
 * timestamp (or null/undefined if none).
 */
function isRecentlyBuilt(lastGeneratedAt, { now = Date.now(), windowMs = FRESH_SKIP_MS } = {}) {
  if (!lastGeneratedAt || windowMs <= 0) return false;
  const t = new Date(lastGeneratedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t < windowMs;
}

/** The newest daily briefing's build time, or null. */
async function lastBriefingBuiltAt() {
  try {
    const rows = await require('../store/briefings').listBriefings({ kind: 'daily', limit: 1 });
    return rows[0]?.generated_at ?? null;
  } catch (e) {
    console.error('[morning] freshness lookup failed (proceeding):', e.message);
    return null; // on error, don't suppress — better a rare dup than a missed brief
  }
}

function selfBase() {
  const port = process.env.PORT || 3001;
  return `http://127.0.0.1:${port}`;
}

/** Force a fresh briefing build so the app opens to a ready briefing. */
async function warmBriefing() {
  const url = `${selfBase()}/api/briefing?refresh=1`;
  const headers = {};
  if (process.env.NORMOS_API_TOKEN) headers.Authorization = `Bearer ${process.env.NORMOS_API_TOKEN}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150000); // LLM can take up to ~110s
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`briefing build returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Local-day dedup key for the "Good morning" push — ONE brief-ready ping per
 *  day, total, across every trigger (watcher, external cron, sleep check-in).
 *  The content can rebuild as often as it likes; the push cannot repeat. */
function morningPushKey(d = new Date()) {
  const tz = process.env.TZ || 'America/New_York';
  return `morning_brief_push:${d.toLocaleDateString('en-CA', { timeZone: tz })}`;
}

/** Build the briefing and push the "ready" notification. Shared by the morning
 *  routine AND the sleep check-in (which triggers it after you log). */
async function warmAndNotify(opts = {}) {
  const send = opts.send !== false;
  let built = false;
  let briefing = null;
  try {
    briefing = await warmBriefing();
    built = true;
  } catch (err) {
    console.error('[morning] briefing warm failed:', err.message);
  }

  if (!send) return { built, sent: 0 };

  // Hard once-per-day gate on the push itself. Every earlier dedup lived on the
  // trigger side (in-flight guard, 2-hour freshness window) and each new trigger
  // path (external cron, sleep check-in, watcher) re-opened a permutation — a
  // cron build at 6:50 plus a watcher run at 9:00 is over the 2h window and
  // would ping twice. Deduping at the single point where the push leaves the
  // building closes all of them at once, including ones not written yet.
  const nudgesStore = require('../store/nudges');
  try {
    const recent = await nudgesStore.recentlySentKeys(1);
    if (recent.has(morningPushKey())) {
      console.log('[morning] brief-ready push already sent today — rebuilt content, skipping duplicate push');
      return { built, sent: 0, skipped: 'already_pushed_today' };
    }
  } catch (e) {
    console.error('[morning] push-dedup check failed (proceeding):', e.message);
  }

  const tokens = await devicesStore.listActiveTokens();
  if (tokens.length === 0) return { built, sent: 0, reason: 'no_devices' };

  // A touch of useful context in the body when we have it (e.g. weather/date).
  let body = 'Your morning briefing is ready — tap to start your day.';
  try {
    const t = briefing?.weather?.temp;
    const cond = briefing?.weather?.condition;
    if (t != null && cond) body = `Your morning briefing is ready — ${Math.round(t)}° and ${String(cond).toLowerCase()}. Tap to start your day.`;
  } catch { /* keep default */ }

  try {
    const r = await sendPush(tokens, {
      title: 'Good morning ☀️',
      body,
      data: { type: 'morning_briefing' },
    });
    for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
    // Record the once-per-day key only after the push actually went out, so a
    // failed send doesn't burn the day's one allowed ping.
    if (r.sent > 0) {
      try {
        const id = await nudgesStore.recordNudge({
          dedupKey: morningPushKey(),
          title: 'Good morning ☀️',
          body,
          basis: { type: 'morning_brief_push' },
          status: 'pending',
        });
        if (id != null) await nudgesStore.markStatus(id, 'sent');
      } catch (e) {
        console.error('[morning] push-dedup record failed:', e.message);
      }
    }
    return { built, sent: r.sent };
  } catch (err) {
    console.error('[morning] push failed:', err.message);
    return { built, sent: 0, error: err.message };
  }
}

/** Push the "log your sleep" prompt (no brief is built — it waits for the log). */
async function pushSleepCheckIn(opts = {}) {
  if (opts.send === false) return { built: false, sleepCheckIn: true, sent: 0 };
  const tokens = await devicesStore.listActiveTokens();
  if (tokens.length === 0) return { built: false, sleepCheckIn: true, sent: 0, reason: 'no_devices' };
  try {
    const r = await sendPush(tokens, {
      title: 'How did you sleep? 🛌',
      body: 'No Eight Sleep reading last night — log your sleep and I’ll build your brief with a recovery score.',
      data: { type: 'sleep_checkin' },
    });
    for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
    return { built: false, sleepCheckIn: true, sent: r.sent };
  } catch (err) {
    console.error('[morning] sleep check-in push failed:', err.message);
    return { built: false, sleepCheckIn: true, sent: 0, error: err.message };
  }
}

/**
 * Morning routine. On nights with no Eight Sleep reading, DON'T build a brief on
 * empty recovery — push the sleep check-in instead, and the brief builds itself
 * when the user logs (POST /api/recovery/self-report → warmAndNotify). Otherwise
 * pre-build the briefing and push "ready".
 * @param {{ send?: boolean }} [opts]
 */
async function runMorningBriefing(opts = {}) {
  // Skip the automatic morning rebuild + push (brief-ready OR sleep check-in) if
  // the user already built a briefing themselves within the freshness window —
  // otherwise the scheduled run overwrites their fresh brief and pings a
  // redundant "ready" notification. Explicit test triggers pass { force: true }.
  if (opts.force !== true) {
    const builtAt = await lastBriefingBuiltAt();
    if (isRecentlyBuilt(builtAt)) {
      const ageMin = Math.round((Date.now() - new Date(builtAt).getTime()) / 60000);
      console.log(`[morning] briefing built ${ageMin}m ago — skipping automatic rebuild + push`);
      return { built: false, sent: 0, skipped: 'recently_built', ageMinutes: ageMin };
    }
  }
  try {
    const needs = await require('../intelligence/recovery').needsSleepCheckIn();
    if (needs) return await pushSleepCheckIn(opts);
  } catch (err) {
    console.error('[morning] sleep check-in check failed:', err.message);
    // fall through to the normal briefing build
  }
  return warmAndNotify(opts);
}

/**
 * Generate the weekly review and push a "your weekly review is ready" notice.
 * Run on the Sunday-morning schedule. Best-effort push.
 * @param {{ send?: boolean }} [opts]
 */
async function runWeeklyReviewWithPush(opts = {}) {
  const send = opts.send !== false;
  const { runReview } = require('../intelligence/review');

  let review = null;
  try {
    review = await runReview(); // generates + persists the weekly review
  } catch (err) {
    console.error('[weekly] review generation failed:', err.message);
    return { generated: false, sent: 0, error: err.message };
  }

  if (!send) return { generated: true, sent: 0 };

  const tokens = await devicesStore.listActiveTokens();
  if (tokens.length === 0) return { generated: true, sent: 0, reason: 'no_devices' };

  // Use the review headline as the notification body when we have one.
  const body = review?.headline
    ? `${review.headline} — tap to read your weekly review.`
    : 'Your weekly review is ready — see how the week went and what to focus on.';

  try {
    const r = await sendPush(tokens, {
      title: 'Your weekly review is ready 📊',
      body,
      data: { type: 'weekly_review' },
    });
    for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
    return { generated: true, sent: r.sent };
  } catch (err) {
    console.error('[weekly] push failed:', err.message);
    return { generated: true, sent: 0, error: err.message };
  }
}

module.exports = { runMorningBriefing, warmBriefing, warmAndNotify, pushSleepCheckIn, runWeeklyReviewWithPush, isRecentlyBuilt };
