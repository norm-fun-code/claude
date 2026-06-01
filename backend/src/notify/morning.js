// Morning briefing pre-build + push. Runs on the scheduler (~8am): forces a
// fresh briefing build so the cache is warm when you open the app (no 15-40s
// wait), then sends a "Your morning briefing is ready!" push to your devices.
//
// We warm the cache by calling our own /api/briefing?refresh=1 over loopback —
// the exact code path the app uses — so there's no duplicate briefing logic to
// drift. The bearer token (if set) is included so the auth gate lets us through.
const devicesStore = require('../store/devices');
const { sendPush } = require('./expo');

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
  const timer = setTimeout(() => controller.abort(), 90000); // builds can take ~40s
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`briefing build returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pre-build the briefing and push a "ready" notification.
 * @param {{ send?: boolean }} [opts]
 */
async function runMorningBriefing(opts = {}) {
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
    return { built, sent: r.sent };
  } catch (err) {
    console.error('[morning] push failed:', err.message);
    return { built, sent: 0, error: err.message };
  }
}

module.exports = { runMorningBriefing, warmBriefing };
