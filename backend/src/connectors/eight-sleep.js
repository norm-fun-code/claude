// Eight Sleep auto-sync connector: pulls last night's sleep session straight
// from Eight Sleep's API each morning, so HRV / resting HR / sleep score land in
// the spine WITHOUT you opening the app to log them. Writes source 'eight_sleep'
// — the same source manual entry uses — so it's idempotent with anything already
// logged (last write wins on the ELSE branch of the metrics upsert).
//
// Dormant unless EIGHT_SLEEP_EMAIL / EIGHT_SLEEP_PASSWORD are set. Caches the
// bearer token in the source config so intraday briefing rebuilds don't re-login.
const { login, resolveUserId, getTrends } = require('../services/eight-sleep-api');
const { registerSource } = require('../store/sources');

const DAY = 24 * 60 * 60 * 1000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

// Physiological bounds — identical to the manual /api/ingest/sleep endpoint, so
// the auto-sync can never write a value the manual path would have rejected.
const ALLOWED = {
  hrv: [2, 300],
  resting_hr: [25, 130],
  sleep_score: [0, 100],
  sleep_hours: [0.5, 16],
  deep_sleep_hours: [0, 14],
  rem_sleep_hours: [0, 14],
  respiratory_rate: [4, 50],
  // Eight Sleep's own model: its computed daily sleep debt + your personalized
  // baseline (the nightly duration Eight Sleep considers your true need).
  sleep_debt: [0, 40],
  sleep_need: [4, 12],
};

const num = (v) => (v == null ? null : Number(v));
const hrs = (sec) => (sec == null || !Number.isFinite(Number(sec)) ? null : Number(sec) / 3600);

/** Map one Eight Sleep `day` trend object to NormOS metric values. */
function mapDay(day) {
  const sq = day?.sleepQualityScore || {};
  const sd = sq.sleepDebt || {};
  return {
    hrv: num(sq.hrv?.current),
    resting_hr: num(sq.heartRate?.current),
    respiratory_rate: num(sq.respiratoryRate?.current),
    sleep_score: num(day?.score),
    sleep_hours: hrs(day?.sleepDuration),
    deep_sleep_hours: hrs(day?.deepDuration),
    rem_sleep_hours: hrs(day?.remDuration),
    // Eight Sleep's own sleep-debt model (personalized to your baseline, not a
    // generic 8h need). sleep_need is the baseline duration Eight Sleep computes.
    sleep_debt: hrs(sd.dailySleepDebtSeconds),
    sleep_need: hrs(sd.baselineSleepDurationSeconds),
  };
}

module.exports = {
  id: 'eight_sleep_api',
  domain: 'health',
  displayName: 'Eight Sleep (auto-sync)',

  async sync(ctx = {}) {
    const email = process.env.EIGHT_SLEEP_EMAIL;
    const password = process.env.EIGHT_SLEEP_PASSWORD;
    if (!email || !password) {
      return { metrics: [], documents: [] }; // not configured — stay dormant
    }

    // Metrics are written under source 'eight_sleep' (shared with manual entry),
    // so ensure that source row exists for the FK before inserting.
    await registerSource({ id: 'eight_sleep', domain: 'health', displayName: 'Eight Sleep' });

    const tz = process.env.TZ || 'America/New_York';

    // Reuse a cached, unexpired token to avoid logging in on every rebuild.
    let token = ctx.config?.eightToken || null;
    let userId = ctx.config?.eightUserId || null;
    const tokenValid = token && ctx.config?.eightTokenExpiresAt && Date.now() < ctx.config.eightTokenExpiresAt - 60_000;

    let newConfig;
    const doLogin = async () => {
      const auth = await login(email, password);
      token = auth.token;
      userId = auth.userId || userId || (await resolveUserId(token));
      newConfig = { ...(ctx.config || {}), eightToken: token, eightUserId: userId, eightTokenExpiresAt: auth.expiresAt };
    };

    if (!tokenValid) await doLogin();
    if (!userId) {
      userId = await resolveUserId(token);
      newConfig = { ...(ctx.config || {}), ...(newConfig || {}), eightUserId: userId };
    }

    // Pull a short window (last 4 days) so a missed morning backfills itself.
    const to = new Date();
    const from = new Date(to.getTime() - 4 * DAY);
    let days;
    try {
      days = await getTrends({ token, userId, from: ymd(from), to: ymd(to), tz });
    } catch (err) {
      // Token expired/invalid mid-window — re-login once and retry.
      if (err.status === 401) {
        await doLogin();
        days = await getTrends({ token, userId, from: ymd(from), to: ymd(to), tz });
      } else {
        throw err;
      }
    }

    // Map each day → metric rows, anchored at noon UTC of THAT day (matches the
    // manual sleep ingest + Apple Health anchoring so rows upsert onto one key).
    const metrics = [];
    for (const day of days) {
      if (!day?.day) continue;
      const ts = new Date(`${day.day}T12:00:00Z`);
      const mapped = mapDay(day);
      for (const [metric, value] of Object.entries(mapped)) {
        if (value == null || !Number.isFinite(value)) continue;
        const bounds = ALLOWED[metric];
        if (bounds && (value < bounds[0] || value > bounds[1])) continue;
        const unit = metric === 'hrv' ? 'ms'
          : metric === 'resting_hr' ? 'bpm'
          : metric.endsWith('_hours') || metric === 'sleep_debt' || metric === 'sleep_need' ? 'hours'
          : metric === 'sleep_score' ? 'score'
          : metric === 'respiratory_rate' ? 'brpm'
          : null;
        metrics.push({ ts, domain: 'health', metric, value: Math.round(value * 100) / 100, source: 'eight_sleep', unit });
      }
    }

    return { metrics, documents: [], config: newConfig };
  },
};
