// NormOS backend.
require('dotenv').config();
const crypto = require('crypto');
const { withTimeout } = require('./src/util/async');
const express = require('express');
const cors = require('cors');

const { fetchGmailThreads } = require('./src/services/gmail');
const { fetchCalendarEvents, fetchWorkBusyBlocks } = require('./src/services/calendar');
const { fetchRandomNotionPage, fetchNotionQuotes } = require('./src/services/notion');
const { fetchRandomQuote } = require('./src/services/googleDoc');
const { fetchWeather } = require('./src/services/weather');
const { fetchMarkets } = require('./src/services/markets');
const { generateBriefing, generateEmailBriefs } = require('./src/services/briefing-ai');
const { getTodayWorkout } = require('./src/services/workout');
const { buildWealthInsights } = require('./src/services/wealth-insights');

const db = require('./src/db');
const metricsStore = require('./src/store/metrics');
const findingsStore = require('./src/store/findings');
const sourcesStore = require('./src/store/sources');
const { mapHealthPayload, SOURCE: HEALTH_SOURCE } = require('./src/ingest/health');
const { mapCheckin, SOURCE: CHECKIN_SOURCE } = require('./src/ingest/checkin');
const { mapHabits, SOURCE: HABITS_SOURCE } = require('./src/ingest/habits');
const documentsStore = require('./src/store/documents');
const llm = require('./src/llm');
const { runIngest } = require('./src/ingest/run');
const monarch = require('./src/connectors/monarch');
const { analyze } = require('./src/intelligence/analyze');
const { embedPending } = require('./src/intelligence/embeddings');
const { ask } = require('./src/chat/ask');
const { discover, addToCart, history: shopHistory, ucpProbe } = require('./src/services/shop');
const ucp = require('./src/services/ucp');
const annotationsStore = require('./src/store/annotations');
const experimentsStore = require('./src/store/experiments');
const experiments = require('./src/intelligence/experiments');
const devicesStore = require('./src/store/devices');
const nudgesStore = require('./src/store/nudges');
const { runNudges, runCheckinReminder, runHabitsReminder } = require('./src/notify/run');
const { runMorningBriefing, runWeeklyReviewWithPush } = require('./src/notify/morning');
const { login: eightSleepLogin, resolveUserId: eightSleepResolveUserId, getTrends: eightSleepGetTrends } = require('./src/services/eight-sleep-api');
const surfacedStore = require('./src/store/surfaced');
const briefingsStore = require('./src/store/briefings');
const recommendationsStore = require('./src/store/recommendations');
const workoutChecks = require('./src/store/workoutChecks');
const intentionsStore = require('./src/store/intentions');
const dailyPicksStore = require('./src/store/dailyPicks');
const { runReview } = require('./src/intelligence/review');

// Last-resort safety net: log instead of crashing on an unhandled rejection /
// uncaught exception, so one stray missed .catch() can't silently kill an
// always-on server during an unattended week. (Per-route handlers still catch
// their own errors; this only catches things that slip past them.)
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
});

const app = express();
const PORT = process.env.PORT || 3001;
const BOOT_TIME = new Date().toISOString(); // process start — confirms a fresh deploy restarted the server

// CORS. The mobile app (React Native) isn't subject to CORS, so we only need to
// allow browser origins we actually use. Lock to an allowlist in production
// (set CORS_ORIGINS as a comma-separated list); default-open only in dev.
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : {}));
app.use(express.json({ limit: '2mb' }));

// Bearer-token auth on every /api route except the health check. Set
// NORMOS_API_TOKEN to require `Authorization: Bearer <token>`. In production we
// warn loudly if it's missing, since the same code is deployed to a public host.
if (!process.env.NORMOS_API_TOKEN) {
  const msg = '[auth] NORMOS_API_TOKEN is not set — the /api surface (including admin/reset and ingest) is UNAUTHENTICATED.';
  if (process.env.NODE_ENV === 'production') console.error(`\n⚠️  ${msg} Set it now.\n`);
  else console.warn(msg);
}
app.use('/api', (req, res, next) => {
  const token = process.env.NORMOS_API_TOKEN;
  if (!token || req.path === '/health') return next();
  const auth = req.get('authorization') || '';
  const expected = `Bearer ${token}`;
  // Constant-time compare to avoid a timing side-channel on the token.
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// Recompute today's habit_score (0-100) from whatever binary habits are logged
// for today, so a partial save can't leave the composite disagreeing with its
// components. Best-effort; never throws into the request path.
const BINARY_HABITS = ['morning_tm', 'afternoon_tm', 'gratitude', 'cold_shower', 'exercise'];
async function recomputeHabitScore(tz) {
  try {
    const { rows } = await db.query(
      `SELECT metric, value FROM metrics
        WHERE domain = 'habits' AND source = 'habits'
          AND metric = ANY($1)
          AND (ts AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
      [BINARY_HABITS, tz]
    );
    if (!rows.length) return;
    const done = rows.reduce((s, r) => s + (Number(r.value) ? 1 : 0), 0);
    const score = Math.round((done / rows.length) * 100);
    const when = require('./src/util/date').dayAnchorTs(tz);
    await metricsStore.insertMetrics([
      { ts: when, domain: 'habits', metric: 'habit_score', value: score, unit: 'percent', source: 'habits' },
    ]);
  } catch (err) {
    console.error('[habit_score] recompute failed:', err.message);
  }
}

// Public UCP agent profile — Shopify's Global Catalog fetches this (no auth) to
// negotiate capabilities. Lives outside /api so the bearer gate doesn't block it.
app.get('/.well-known/ucp-agent', (req, res) => {
  res.json(ucp.agentProfile());
});

app.get('/api/health', async (req, res) => {
  let database = 'down';
  try {
    database = (await db.ping()) ? 'ok' : 'down';
  } catch (err) {
    database = `error: ${err.message}`;
  }
  // Surface the deployed commit so we can confirm what code is actually live
  // (Railway/Render inject these at build time). Without this there's no way to
  // tell whether a merge to main has reached production.
  const commit =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.RENDER_GIT_COMMIT ||
    process.env.GIT_COMMIT_SHA ||
    'unknown';
  res.json({
    status: 'ok',
    database,
    commit: commit === 'unknown' ? 'unknown' : commit.slice(0, 7),
    bootedAt: BOOT_TIME,
    timestamp: new Date().toISOString(),
  });
});

// --- Ingestion -----------------------------------------------------------

// Mobile app posts on-device HealthKit data here so it persists to the spine.
app.post('/api/ingest/health', async (req, res) => {
  try {
    await sourcesStore.registerSource({
      id: HEALTH_SOURCE,
      domain: 'health',
      displayName: 'Apple Health',
    });
    const tz = process.env.TZ || 'America/New_York';
    const rows = mapHealthPayload(req.body, { ts: req.query.ts, tz });
    const written = await metricsStore.insertMetrics(rows);
    await sourcesStore.markSync(HEALTH_SOURCE);
    res.json({ written });
    // Fire-and-forget: ping if a just-synced metric deviates sharply from baseline.
    require('./src/intelligence/watch').runWatch({ metrics: rows }).catch((e) => console.error('[watch] health ingest:', e.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Seed Eight Sleep baseline averages — runs the pre-computed 180-day seed in-process.
// curl -X POST .../api/ingest/sleep-baseline -H "Authorization: Bearer TOKEN"
// Safe to re-run (upserts). Useful after first setup or when baselines change.
app.post('/api/ingest/sleep-baseline', async (req, res) => {
  try {
    await sourcesStore.registerSource({ id: 'eight_sleep_baseline', domain: 'health', displayName: 'Eight Sleep (baseline averages)' });
    await sourcesStore.registerSource({ id: 'eight_sleep', domain: 'health', displayName: 'Eight Sleep' });
    const tz = process.env.TZ || 'America/New_York';
    const SOURCE = 'eight_sleep_baseline';
    const DOMAIN = 'health';
    const B7   = { hrv: 38, resting_hr: 56, sleep_hours: 7+25/60, deep_sleep_hours: 1+14/60, rem_sleep_hours: 1+56/60, sleep_score: 84 };
    const B30  = { hrv: 39, resting_hr: 55, sleep_hours: 7+45/60, deep_sleep_hours: 1+14/60, rem_sleep_hours: 1+55/60, sleep_score: 87 };
    const B180 = { hrv: 41, resting_hr: 55, sleep_hours: 7+56/60, deep_sleep_hours: 1+25/60, rem_sleep_hours: 1+55/60, sleep_score: 87 };
    const METRICS = ['hrv','resting_hr','sleep_hours','deep_sleep_hours','rem_sleep_hours','sleep_score'];
    const rows = [];
    for (let daysAgo = 1; daysAgo <= 180; daysAgo++) {
      const bl = daysAgo <= 7 ? B7 : daysAgo <= 30 ? B30 : B180;
      const d  = new Date(); d.setDate(d.getDate() - daysAgo);
      const ymd = d.toLocaleDateString('en-CA', { timeZone: tz });
      const ts  = new Date(`${ymd}T12:00:00Z`);
      for (const m of METRICS) rows.push({ ts, domain: DOMAIN, metric: m, value: +bl[m].toFixed(3), source: SOURCE });
    }
    const written = await metricsStore.insertMetrics(rows);
    res.json({ written, nights: 180, message: 'Eight Sleep baselines seeded' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eight Sleep full history import — accepts the sleep_nights.json export directly.
// curl -X POST .../api/ingest/eight-sleep -H "Content-Type: application/json"
//      -H "Authorization: Bearer TOKEN" -d @sleep_nights.json
app.post('/api/ingest/eight-sleep', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { sessions } = req.body;
    if (!Array.isArray(sessions)) return res.status(400).json({ error: 'Expected { sessions: [...] }' });

    await sourcesStore.registerSource({ id: 'eight_sleep', domain: 'health', displayName: 'Eight Sleep' });
    const tz = process.env.TZ || 'America/New_York';
    const { dayAnchorTs } = require('./src/util/date');
    const SOURCE = 'eight_sleep';
    const DOMAIN = 'health';
    const SLEEP_STAGES = new Set(['light', 'deep', 'rem']);
    const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    let written = 0, skipped = 0;
    for (const session of sessions) {
      const { ts, stages = [], timeseries = {} } = session;
      if (!ts) { skipped++; continue; }
      let sleepSec = 0, deepSec = 0, remSec = 0, totalSec = 0;
      for (const { stage, duration } of (stages || [])) {
        const d = Number(duration) || 0;
        totalSec += d;
        if (SLEEP_STAGES.has(stage)) sleepSec += d;
        if (stage === 'deep') deepSec += d;
        if (stage === 'rem')  remSec  += d;
      }
      const wakeTs = new Date((ts + totalSec) * 1000);
      const anchor = dayAnchorTs(tz, wakeTs);
      const tsVals = (key) => (timeseries[key] || []).map(([, v]) => Number(v)).filter(Number.isFinite);
      const hrv = mean(tsVals('hrv'));
      const rhr = mean(tsVals('heartRate'));
      const rr  = mean(tsVals('respiratoryRate'));
      const sleepH = sleepSec / 3600;
      const deepH  = deepSec  / 3600;
      const remH   = remSec   / 3600;
      let score = 50;
      if (sleepH >= 7)  score += 15; if (sleepH >= 8) score += 10; if (sleepH < 6) score -= 15;
      if (deepH  >= 1.5) score += 10; if (deepH >= 2) score += 5;
      if (remH   >= 1.5) score += 10;
      if (hrv != null && hrv >= 50) score += 5; if (hrv != null && hrv < 30) score -= 10;
      score = Math.max(0, Math.min(100, Math.round(score)));
      const rows = [];
      const push = (m, v, lo, hi) => { if (v != null && Number.isFinite(v) && v >= lo && v <= hi) rows.push({ ts: anchor, domain: DOMAIN, metric: m, value: v, source: SOURCE }); };
      push('sleep_hours', sleepH, 0.5, 16); push('deep_sleep_hours', deepH, 0, 14); push('rem_sleep_hours', remH, 0, 14);
      push('sleep_score', score, 0, 100); push('hrv', hrv, 2, 300); push('resting_hr', rhr, 25, 130); push('respiratory_rate', rr, 4, 50);
      if (rows.length) { written += await metricsStore.insertMetrics(rows); } else { skipped++; }
    }
    res.json({ sessions: sessions.length, written, skipped });
    // Fire-and-forget: ping if these overnight metrics deviate sharply from baseline.
    if (written > 0) require('./src/intelligence/watch').runWatch().catch((e) => console.error('[watch] eight-sleep ingest:', e.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pull Eight Sleep history for the last N days (default 60) and upsert into the
// metrics table. Safe to re-run — idempotent. Used for initial baseline backfill
// so the recovery score has enough history to self-calibrate.
app.post('/api/ingest/eight-sleep/backfill', async (req, res) => {
  const email = process.env.EIGHT_SLEEP_EMAIL;
  const password = process.env.EIGHT_SLEEP_PASSWORD;
  if (!email || !password) return res.status(503).json({ error: 'Eight Sleep credentials not configured' });

  const days = Math.min(Math.max(Number(req.query.days) || 60, 7), 365);
  const tz = process.env.TZ || 'America/New_York';
  const ymd = (d) => new Date(d).toISOString().slice(0, 10);
  const DAY = 86400000;
  const ALLOWED = {
    hrv: [2, 300], resting_hr: [25, 130], sleep_score: [0, 100],
    sleep_hours: [0.5, 16], deep_sleep_hours: [0, 14], rem_sleep_hours: [0, 14],
    respiratory_rate: [4, 50], sleep_debt: [0, 40], sleep_need: [4, 12],
  };
  const num = (v) => (v == null ? null : Number(v));
  const hrs = (sec) => (sec == null || !Number.isFinite(Number(sec)) ? null : Number(sec) / 3600);
  const mapDay = (day) => {
    const sq = day?.sleepQualityScore || {};
    const sd = sq.sleepDebt || {};
    return {
      hrv: num(sq.hrv?.current), resting_hr: num(sq.heartRate?.current),
      respiratory_rate: num(sq.respiratoryRate?.current), sleep_score: num(day?.score),
      sleep_hours: hrs(day?.sleepDuration), deep_sleep_hours: hrs(day?.deepDuration),
      rem_sleep_hours: hrs(day?.remDuration),
      sleep_debt: hrs(sd.dailySleepDebtSeconds), sleep_need: hrs(sd.baselineSleepDurationSeconds),
    };
  };

  try {
    await sourcesStore.registerSource({ id: 'eight_sleep', domain: 'health', displayName: 'Eight Sleep' });
    const auth = await eightSleepLogin(email, password);
    const userId = auth.userId || await eightSleepResolveUserId(auth.token);
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY);
    const dayRows = await eightSleepGetTrends({ token: auth.token, userId, from: ymd(from), to: ymd(to), tz });

    const metrics = [];
    for (const day of dayRows) {
      if (!day?.day) continue;
      const ts = new Date(`${day.day}T12:00:00Z`);
      const mapped = mapDay(day);
      for (const [metric, value] of Object.entries(mapped)) {
        if (value == null || !Number.isFinite(value)) continue;
        const bounds = ALLOWED[metric];
        if (bounds && (value < bounds[0] || value > bounds[1])) continue;
        const unit = metric === 'hrv' ? 'ms' : metric === 'resting_hr' ? 'bpm'
          : metric.endsWith('_hours') || metric === 'sleep_debt' || metric === 'sleep_need' ? 'hours'
          : metric === 'sleep_score' ? 'score' : metric === 'respiratory_rate' ? 'brpm' : null;
        metrics.push({ ts, domain: 'health', metric, value: Math.round(value * 100) / 100, source: 'eight_sleep', unit });
      }
    }

    const written = await metricsStore.insertMetrics(metrics);
    res.json({ days: dayRows.length, metrics: written });
    // Re-run analysis so the new history flows into findings and self-model.
    analyze().catch((e) => console.error('[eight-sleep backfill] analyze:', e.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eight Sleep (or manual) overnight metrics: HRV, RHR, sleep score, sleep hours.
// Stored separately from Apple Health (source: 'eight_sleep') so they can coexist
// and the analyze engine can prefer watch data when both are present.
app.post('/api/ingest/sleep', async (req, res) => {
  try {
    await sourcesStore.registerSource({ id: 'eight_sleep', domain: 'health', displayName: 'Eight Sleep' });
    const tz = process.env.TZ || 'America/New_York';
    const { dayAnchorTs } = require('./src/util/date');
    const when = dayAnchorTs(tz); // noon local time — same anchor as Apple Health
    const SOURCE = 'eight_sleep';
    const DOMAIN = 'health';
    const ALLOWED = {
      hrv:          [2,   300],
      resting_hr:   [25,  130],
      sleep_score:  [0,   100],
      sleep_hours:  [0.5, 16],
      deep_sleep_hours: [0, 14],
      rem_sleep_hours:  [0, 14],
      respiratory_rate: [4, 50],
    };
    const { hrv, resting_hr, restingHr, sleep_score, sleepScore, sleep_hours, sleepHours,
            deep_sleep_hours, rem_sleep_hours, respiratory_rate } = req.body;
    const input = {
      hrv,
      resting_hr: resting_hr ?? restingHr,
      sleep_score: sleep_score ?? sleepScore,
      sleep_hours: sleep_hours ?? sleepHours,
      deep_sleep_hours,
      rem_sleep_hours,
      respiratory_rate,
    };
    const rows = [];
    for (const [metric, value] of Object.entries(input)) {
      if (value == null) continue;
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      const bounds = ALLOWED[metric];
      if (bounds && (num < bounds[0] || num > bounds[1])) continue;
      rows.push({ ts: when, domain: DOMAIN, metric, value: num, source: SOURCE });
    }
    if (!rows.length) return res.status(400).json({ error: 'No valid metrics provided' });
    const written = await metricsStore.insertMetrics(rows);
    res.json({ written, metrics: rows.map((r) => r.metric) });
    // Fire-and-forget: ping if last night's overnight metrics deviate from baseline.
    require('./src/intelligence/watch').runWatch({ metrics: rows }).catch((e) => console.error('[watch] sleep ingest:', e.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Today's Eight Sleep metrics — lets the app show what's already been logged.
app.get('/api/sleep/today', async (req, res) => {
  try {
    const tz = process.env.TZ || 'America/New_York';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    const METRICS = ['hrv', 'resting_hr', 'sleep_score', 'sleep_hours', 'respiratory_rate', 'sleep_debt', 'sleep_need'];
    const result = {};
    await Promise.all(METRICS.map(async (m) => {
      // Eight Sleep first; fall back to the manual sleep check-in (self_report)
      // so a night off the pod still shows the sleep the user logged instead
      // of a blank row.
      const { rows } = await require('./src/db').query(
        `SELECT value FROM metrics
          WHERE domain = 'health' AND metric = $1 AND source IN ('eight_sleep', 'self_report')
            AND date_trunc('day', ts AT TIME ZONE $2) = $3::date
          ORDER BY CASE source WHEN 'eight_sleep' THEN 1 ELSE 2 END, ts DESC LIMIT 1`,
        [m, tz, today]
      );
      if (rows[0]) result[m] = Number(rows[0].value);
    }));
    res.json({ date: today, logged: Object.keys(result).length > 0, metrics: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Daily subjective check-in (mood / energy / focus + optional journal note).
app.post('/api/checkin', async (req, res) => {
  try {
    await sourcesStore.registerSource({
      id: CHECKIN_SOURCE,
      domain: 'wellbeing',
      displayName: 'Daily Check-in',
    });
    const tz = process.env.TZ || 'America/New_York';
    const { metrics, document } = mapCheckin(req.body, { ts: req.query.ts, tz });
    const written = await metricsStore.insertMetrics(metrics);
    if (document) await documentsStore.upsertDocument(document);
    await sourcesStore.markSync(CHECKIN_SOURCE);
    res.json({ written, journaled: Boolean(document) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Last N days of check-in data (mood / energy / focus per day) for the
// history card on the Insights tab. Returns days sorted oldest-first so
// the mobile chart can render them left-to-right without reversing.
app.get('/api/checkin/history', async (req, res) => {
  try {
    const tz = process.env.TZ || 'America/New_York';
    const days = Math.min(Number(req.query.days) || 30, 90);
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { rows } = await db.query(
      `SELECT
         (ts AT TIME ZONE $1)::date AS day,
         metric,
         AVG(value) AS value
       FROM metrics
       WHERE domain = 'wellbeing' AND source = 'checkin'
         AND metric = ANY($2)
         AND ts >= $3
       GROUP BY (ts AT TIME ZONE $1)::date, metric
       ORDER BY day ASC`,
      [tz, ['mood', 'energy', 'focus'], from]
    );
    // Pivot: [{day, mood, energy, focus}]
    const byDay = new Map();
    for (const r of rows) {
      const d = r.day.toISOString().slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, { date: d });
      byDay.get(d)[r.metric] = Math.round(Number(r.value) * 10) / 10;
    }
    res.json({ days: [...byDay.values()] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Last N weekly review briefings — for the history panel on the Insights tab.
app.get('/api/briefings/history', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 8, 20);
    const kind = req.query.kind || 'weekly';
    const rows = await briefingsStore.listBriefings({ kind, limit });
    res.json({ reviews: rows.map((r) => ({ content: r.content, generatedAt: r.generated_at })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// What you've already checked in *today* (your timezone), so the card can
// rehydrate after a tab switch / reopen and reset cleanly at midnight.
app.get('/api/checkin/today', async (req, res) => {
  try {
    const tz = process.env.TZ || 'America/New_York';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    const [metricsResult, noteResult] = await Promise.all([
      db.query(
        `SELECT metric, value FROM metrics
          WHERE domain = 'wellbeing' AND source = 'checkin'
            AND (ts AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
          ORDER BY ts ASC`,
        [tz]
      ),
      db.query(
        `SELECT content FROM documents WHERE source = 'checkin' AND external_id = $1 LIMIT 1`,
        [`note:${today}`]
      ),
    ]);
    const v = {};
    for (const r of metricsResult.rows) v[r.metric] = Number(r.value);
    res.json({
      logged: metricsResult.rows.length > 0,
      mood: Number.isFinite(v.mood) ? v.mood : null,
      energy: Number.isFinite(v.energy) ? v.energy : null,
      focus: Number.isFinite(v.focus) ? v.focus : null,
      note: noteResult.rows[0]?.content ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// End-of-day habit stack (5 binary habits + eat-healthy 1–5 → daily metrics).
app.post('/api/habits', async (req, res) => {
  try {
    await sourcesStore.registerSource({
      id: HABITS_SOURCE,
      domain: 'habits',
      displayName: 'Habit Stack',
    });
    const tz = process.env.TZ || 'America/New_York';
    const { metrics } = mapHabits(req.body, { ts: req.query.ts, tz });
    const written = await metricsStore.insertMetrics(metrics);
    // Recompute habit_score from ALL of today's persisted binary habits, so a
    // partial save (e.g. the workout panel toggling just `exercise`) keeps the
    // composite consistent with its components instead of leaving it stale.
    await recomputeHabitScore(tz);
    await sourcesStore.markSync(HABITS_SOURCE);
    // Unchecking the gratitude box must also clear today's reflection text —
    // otherwise a written-then-unchecked reflection survives in gratitude_logs
    // and the evening brief keeps echoing gratitude for a day marked incomplete.
    if (req.body?.gratitude === false) {
      await require('./src/store/gratitudeLogs').upsert({ logDate: mealLogDateStr(tz), text: '' }).catch(() => {});
    }
    res.json({ written });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// What you've already logged *today* (in your timezone), so the app can
// pre-fill the habit stack instead of starting blank each time you open it.
app.get('/api/habits/today', async (req, res) => {
  try {
    const tz = process.env.TZ || 'America/New_York';
    const { rows } = await db.query(
      `SELECT metric, value FROM metrics
       WHERE domain = 'habits'
         AND (ts AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
       ORDER BY ts ASC`,
      [tz]
    );
    const v = {};
    for (const r of rows) v[r.metric] = Number(r.value); // latest wins
    res.json({
      logged: rows.length > 0,
      morningTM: v.morning_tm === 1,
      afternoonTM: v.afternoon_tm === 1,
      gratitude: v.gratitude === 1,
      coldShower: v.cold_shower === 1,
      exercise: v.exercise === 1,
      eatHealthy: Number.isFinite(v.eat_healthy) ? v.eat_healthy : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eating Healthy helper — "not sure how to rate today?" Log free-text of what
// you ate/drank and get an AI-suggested 1-5 score + rationale. Applying the
// suggestion still goes through the normal POST /api/habits eatHealthy field;
// this only produces the suggestion and keeps the raw log for reference.
const mealLogsStore = require('./src/store/mealLogs');

function mealLogDateStr(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

app.get('/api/habits/eat-healthy/today', async (req, res) => {
  try {
    const tz = process.env.TZ || 'America/New_York';
    const row = await mealLogsStore.getByDate(mealLogDateStr(tz));
    res.json({
      text: row?.text ?? '',
      score: row?.score ?? null,
      rationale: row?.rationale ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/habits/eat-healthy/score', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });

    const prompt = `Rate how healthy this day of eating was, on a 1-5 scale (1 = poor, 5 = excellent), based on what they logged eating and drinking:

"${text.slice(0, 2000)}"

Consider: whole/minimally-processed foods vs. ultra-processed or fast food, vegetables/fruit/fiber, protein adequacy, added sugar and alcohol, hydration, and portion reasonableness. This is about long-term health, not calorie-counting or weight loss.

Return ONLY valid JSON — no markdown, no explanation:
{"score": <integer 1-5>, "rationale": "<1-2 sentences, specific to what they actually logged, honest but encouraging>"}`;

    const raw = await llm.generateText({
      system: 'You help someone honestly assess how healthy a day of eating was, from their own free-text log. Return only valid JSON.',
      prompt,
      maxTokens: 250,
    });

    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'parse failed', raw: cleaned.slice(0, 300) });
    }

    const score = Math.max(1, Math.min(5, Math.round(Number(result.score))));
    const rationale = String(result.rationale || '').slice(0, 500);
    if (!Number.isFinite(score)) return res.status(500).json({ error: 'invalid score from model' });

    const tz = process.env.TZ || 'America/New_York';
    await mealLogsStore.upsert({ logDate: mealLogDateStr(tz), text, score, rationale });
    res.json({ score, rationale });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gratitude reflection — turns the binary gratitude checkbox into an actual
// practice: log one line of what you're grateful for. Saving a reflection also
// marks the gratitude habit done (writing it IS doing it). The text is reflected
// back in the evening wind-down brief so it isn't write-only.
const gratitudeLogsStore = require('./src/store/gratitudeLogs');

app.get('/api/habits/gratitude/today', async (req, res) => {
  try {
    const tz = process.env.TZ || 'America/New_York';
    const row = await gratitudeLogsStore.getByDate(mealLogDateStr(tz));
    res.json({ text: row?.text ?? '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/habits/gratitude', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    const tz = process.env.TZ || 'America/New_York';
    await gratitudeLogsStore.upsert({ logDate: mealLogDateStr(tz), text: text.slice(0, 1000) });

    // Writing a reflection counts as doing gratitude — mark the binary habit so
    // the two never drift out of sync (a saved reflection with an unchecked box).
    await sourcesStore.registerSource({ id: HABITS_SOURCE, domain: 'habits', displayName: 'Habit Stack' });
    const { metrics } = mapHabits({ gratitude: true }, { ts: req.query.ts, tz });
    await metricsStore.insertMetrics(metrics);
    await recomputeHabitScore(tz);
    await sourcesStore.markSync(HABITS_SOURCE);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Habit streaks — consecutive days (ending today or yesterday) where each habit
// was logged with value >= 0.5. Covers the last 90 days.
app.get('/api/habits/streaks', async (req, res) => {
  try {
    const tz = process.env.TZ || 'America/New_York';
    const HABIT_METRICS = ['morning_tm', 'afternoon_tm', 'cold_shower', 'gratitude', 'exercise'];
    const { rows } = await db.query(
      `SELECT
         metric,
         date_trunc('day', ts AT TIME ZONE COALESCE($1, 'America/New_York'))::date AS day,
         AVG(value) AS val
       FROM metrics
       WHERE domain = 'habits'
         AND metric = ANY($2)
         AND source != 'seed'
         AND ts >= NOW() - INTERVAL '90 days'
       GROUP BY metric, day
       ORDER BY metric, day DESC`,
      [tz, HABIT_METRICS]
    );

    // Group rows by metric.
    const byMetric = {};
    for (const r of rows) {
      if (!byMetric[r.metric]) byMetric[r.metric] = [];
      byMetric[r.metric].push({ day: String(r.day).slice(0, 10), val: Number(r.val) });
    }

    // Today and yesterday in YYYY-MM-DD (server date; close enough for streaks).
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const today = toDateStr(now);
    const yesterday = toDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

    function countStreak(dayRows) {
      if (!dayRows || dayRows.length === 0) return 0;
      // dayRows is sorted DESC. Streak is active if most recent day is today or yesterday.
      const mostRecent = dayRows[0].day;
      if (mostRecent !== today && mostRecent !== yesterday) return 0;
      // Walk back expecting consecutive days.
      let streak = 0;
      let expected = mostRecent;
      for (const { day, val } of dayRows) {
        if (day !== expected || val < 0.5) break;
        streak++;
        // Next expected day is one day earlier.
        const d = new Date(expected + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        expected = toDateStr(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      }
      return streak;
    }

    res.json({
      streaks: {
        morningTM:    countStreak(byMetric['morning_tm']),
        afternoonTM:  countStreak(byMetric['afternoon_tm']),
        coldShower:   countStreak(byMetric['cold_shower']),
        gratitude:    countStreak(byMetric['gratitude']),
        exercise:     countStreak(byMetric['exercise']),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-habit adherence for the last N days as boolean arrays (oldest→newest), with
// gaps filled false — drives the habit dot-rows. One round trip for all habits.
app.get('/api/habits/history', async (req, res) => {
  try {
    const tz = process.env.TZ || 'America/New_York';
    const days = Math.max(7, Math.min(Number(req.query.days) || 14, 60));
    const HABIT_METRICS = ['morning_tm', 'afternoon_tm', 'cold_shower', 'gratitude', 'exercise'];
    const { rows } = await db.query(
      `SELECT metric,
              (ts AT TIME ZONE $1)::date AS day,
              AVG(value) AS val
         FROM metrics
        WHERE domain = 'habits' AND metric = ANY($2) AND source != 'seed'
          AND (ts AT TIME ZONE $1)::date > (now() AT TIME ZONE $1)::date - $3::int
        GROUP BY metric, day`,
      [tz, HABIT_METRICS, days]
    );
    const done = {}; // metric -> Set(YYYY-MM-DD where val>=0.5)
    for (const r of rows) {
      const key = String(r.day).slice(0, 10);
      if (Number(r.val) >= 0.5) (done[r.metric] ||= new Set()).add(key);
    }
    // Build the contiguous day axis (oldest→newest) in the configured tz.
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const axis = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(`${todayStr}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - i);
      axis.push(d.toISOString().slice(0, 10));
    }
    const series = (metric) => axis.map((day) => done[metric]?.has(day) || false);
    res.json({
      days, axis,
      history: {
        morningTM: series('morning_tm'),
        afternoonTM: series('afternoon_tm'),
        coldShower: series('cold_shower'),
        gratitude: series('gratitude'),
        exercise: series('exercise'),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Nightly context tags (Magnesium, Alcohol, …) -----------------------------
// Stored as daily 0/1 metrics under the `context` domain so the habit-split engine
// correlates them against HRV / sleep — our own version of Eight Sleep's tag
// insights, but cross-domain. Anchored at noon-UTC of the wake date (today), to
// line up with the wake-dated sleep metrics.
app.get('/api/context/tags', (req, res) => {
  res.json({ tags: require('./src/intelligence/context-tags').CONTEXT_TAGS });
});

app.get('/api/context/today', async (req, res) => {
  try {
    const tz = process.env.TZ || 'America/New_York';
    const { rows } = await db.query(
      `SELECT metric, value FROM metrics
        WHERE domain = 'context'
          AND (ts AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
      [tz]
    );
    const active = {};
    let submitted = false;
    for (const r of rows) {
      if (r.metric === '_submitted') { submitted = Number(r.value) >= 0.5; continue; }
      if (Number(r.value) >= 0.5) active[r.metric] = true;
    }
    // `submitted` lets the card hide itself for the rest of the day once dismissed.
    res.json({ logged: rows.length > 0, submitted, active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Log tonight's/last-night's context. Records EVERY catalog tag as 0/1 for the day
// so untagged tags are explicit "off" days for the correlation (not missing).
app.post('/api/context', async (req, res) => {
  try {
    const { TAG_KEYS } = require('./src/intelligence/context-tags');
    const body = req.body || {};
    const active = body.active && typeof body.active === 'object'
      ? new Set(Object.keys(body.active).filter((k) => body.active[k]))
      : new Set(Array.isArray(body.tags) ? body.tags : []);
    const tz = process.env.TZ || 'America/New_York';
    const dateStr = body.date || new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const ts = new Date(`${dateStr}T12:00:00Z`);
    await sourcesStore.registerSource({ id: 'self_report', domain: 'health', displayName: 'Self-reported' }).catch(() => {});
    const metrics = TAG_KEYS.map((k) => ({
      ts, domain: 'context', metric: k, value: active.has(k) ? 1 : 0, unit: 'bool', source: 'self_report',
    }));
    // A `submitted` marker (not a tracked tag, so it never enters correlations) so
    // the card can hide for the rest of the day once the user taps Submit.
    if (body.submitted) {
      metrics.push({ ts, domain: 'context', metric: '_submitted', value: 1, unit: 'bool', source: 'self_report' });
    }
    const written = await metricsStore.insertMetrics(metrics);
    res.json({ ok: true, date: dateStr, active: [...active], submitted: !!body.submitted, written });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Context per day over a window, keyed by date (YYYY-MM-DD). Lets a chart
// tooltip answer "why did HRV plunge here?" by joining the tapped point's date to
// (a) the nightly tags toggled that night (magnesium, alcohol, …) and (b) any
// free-text context you wrote — chief-of-staff briefing answers, travel/illness
// notes, etc. (annotations), attached to every day they span.
app.get('/api/context/history', async (req, res) => {
  const numDays = Math.max(1, Math.min(Number(req.query.days) || 60, 400));
  try {
    const { CONTEXT_TAGS } = require('./src/intelligence/context-tags');
    const meta = Object.fromEntries(CONTEXT_TAGS.map((t) => [t.key, t]));
    const tz = process.env.TZ || 'America/New_York';
    const window = String(numDays);

    const tagRowsP = db.query(
      `SELECT to_char((ts AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day, metric
         FROM metrics
        WHERE domain = 'context' AND value >= 0.5
          AND ts >= now() - ($2 || ' days')::interval`,
      [tz, window]
    );
    // Each annotation contributes its text to every calendar day it covers
    // (start→end), so a multi-day "Travel" note shows on every point it spans.
    const noteRowsP = db.query(
      `SELECT to_char(gd, 'YYYY-MM-DD') AS day, a.category AS category, a.label AS label
         FROM annotations a,
         LATERAL generate_series(
           GREATEST((a.start_ts AT TIME ZONE $1)::date::timestamp,
                    (now() AT TIME ZONE $1)::date - ($2 || ' days')::interval),
           LEAST((COALESCE(a.end_ts, a.start_ts) AT TIME ZONE $1)::date::timestamp,
                 (now() AT TIME ZONE $1)::date::timestamp),
           interval '1 day'
         ) AS gd
        WHERE COALESCE(a.end_ts, a.start_ts) >= now() - ($2 || ' days')::interval
          AND a.start_ts <= now()
          AND a.label IS NOT NULL
          -- Exclude financial/spending context — health charts shouldn't surface
          -- money notes. Catches both the tagged category (answers to spending
          -- prompts → 'spending note') and free-text notes that read as financial
          -- (e.g. "Vacation car rental") which land in the generic brief_context.
          AND a.category NOT ILIKE '%spend%'
          AND a.category NOT ILIKE '%financ%'
          AND a.label !~* '(\y(spent|spend|spending|bill|bills|rent|rental|invoice|purchase|bought|payment|paid|expense|expenses|budget|refund|deposit|salary|paycheck|mortgage|loan|vacation|flight|hotel|dollars?|cost|costs)\y|\$)'`,
      [tz, window]
    );
    const [{ rows: tagRows }, { rows: noteRows }] = await Promise.all([tagRowsP, noteRowsP]);

    const history = {};
    for (const r of tagRows) {
      const m = meta[r.metric]; // skips `_submitted` and any retired tag
      if (!m) continue;
      (history[r.day] ||= []).push({ key: m.key, label: m.label, emoji: m.emoji });
    }
    const notes = {};
    for (const r of noteRows) {
      const text = String(r.label || '').trim().slice(0, 140);
      if (!text) continue;
      const arr = (notes[r.day] ||= []);
      if (arr.length < 4 && !arr.some((x) => x.text === text)) arr.push({ text, category: r.category });
    }
    res.json({ history, notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-exercise / non-negotiable workout checkmarks. Like the check-in, each tap
// saves immediately and the app rehydrates the day's checks on mount. The client
// owns the local date (?date=YYYY-MM-DD, ET) so it matches the workout strip.
app.get('/api/workout/checks', async (req, res) => {
  try {
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
    res.json({ date, checks: await workoutChecks.getChecks(date) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workout/checks', async (req, res) => {
  try {
    const { date, itemKey, itemType, done } = req.body || {};
    if (!date || !itemKey) return res.status(400).json({ error: 'date and itemKey are required' });
    await workoutChecks.setCheck({ date, itemKey, itemType, done: done !== false });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual per-day workout swaps. GET returns a date→workoutId map across a range
// (so the week strip can show swapped days); POST sets one day (empty/null
// workoutId reverts that day to the scheduled split).
const VALID_WORKOUT_IDS = new Set(['push', 'pull', 'zone2', 'mobility', 'intervals', 'rest']);

app.get('/api/workout/overrides', async (req, res) => {
  try {
    const { from = null, to = null } = req.query;
    const { rows } = await db.query(
      `SELECT to_char(log_date, 'YYYY-MM-DD') AS day, workout_id FROM workout_overrides
        WHERE ($1::date IS NULL OR log_date >= $1)
          AND ($2::date IS NULL OR log_date <= $2)`,
      [from, to]
    );
    const overrides = {};
    for (const r of rows) overrides[r.day] = r.workout_id;
    res.json({ overrides });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workout/override', async (req, res) => {
  try {
    const { date, workoutId } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!workoutId) {
      await db.query('DELETE FROM workout_overrides WHERE log_date = $1', [date]);
      return res.json({ ok: true, date, workoutId: null });
    }
    if (!VALID_WORKOUT_IDS.has(workoutId)) return res.status(400).json({ error: 'invalid workoutId' });
    await db.query(
      `INSERT INTO workout_overrides (log_date, workout_id) VALUES ($1, $2)
       ON CONFLICT (log_date) DO UPDATE SET workout_id = EXCLUDED.workout_id, created_at = now()`,
      [date, workoutId]
    );
    res.json({ ok: true, date, workoutId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workout/progression?exercise=A&exercise=B&limit=10 — per-exercise
// progression over recent sessions. For each session it computes estimated 1RM
// (Epley: w × (1 + reps/30), best set) and total volume (Σ reps × weight), then
// the trend across the window. Powers the post-session "Strength progression"
// card. Bodyweight-only exercises fall back to total reps as the trend metric.
app.get('/api/workout/progression', async (req, res) => {
  try {
    const { exercise, limit = 10 } = req.query;
    if (!exercise) return res.status(400).json({ error: 'exercise required' });
    const names = Array.isArray(exercise) ? exercise : [exercise];
    const lim = Math.min(Math.max(Number(limit) || 10, 2), 30);
    const { fetchProgression } = require('./src/intelligence/strength-progression');
    res.json({ progression: await fetchProgression(names, lim) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-set workout logs — actual reps and weight performed, for progressive
// overload tracking and auto-population of "last session" data.

// GET /api/workout/log?day=YYYY-MM-DD — fetch all logged sets for a given day.
app.get('/api/workout/log', async (req, res) => {
  try {
    const day = req.query.day || new Date().toISOString().slice(0, 10);
    const { rows } = await db.query(
      `SELECT exercise, set_number, reps, weight_lbs, note
       FROM workout_logs WHERE log_date = $1
       ORDER BY exercise, set_number`, [day]
    );
    res.json({ logs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/workout/log — upsert a single set.
app.post('/api/workout/log', async (req, res) => {
  try {
    const { day, exercise, set_number, reps, weight_lbs, note = null } = req.body;
    if (!day || !exercise || set_number == null) return res.status(400).json({ error: 'day, exercise, set_number required' });
    await db.query(
      `INSERT INTO workout_logs (log_date, exercise, set_number, reps, weight_lbs, note, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (log_date, exercise, set_number) DO UPDATE
         SET reps = EXCLUDED.reps, weight_lbs = EXCLUDED.weight_lbs,
             note = EXCLUDED.note, updated_at = now()`,
      [day, exercise, set_number, reps ?? null, weight_lbs ?? null, note]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workout/log/history?exercise=NAME&limit=5 — last N sessions for an
// exercise, each with all its sets. Powers the "Last time: 3×12 @ 45 lbs" display.
app.get('/api/workout/log/history', async (req, res) => {
  try {
    const { exercise, limit = 5 } = req.query;
    if (!exercise) return res.status(400).json({ error: 'exercise required' });
    const { rows } = await db.query(
      `SELECT log_date, json_agg(
         json_build_object('set_number', set_number, 'reps', reps, 'weight_lbs', weight_lbs)
         ORDER BY set_number
       ) AS sets
       FROM workout_logs
       WHERE exercise = $1
       GROUP BY log_date
       ORDER BY log_date DESC
       LIMIT $2`,
      [exercise, parseInt(limit)]
    );
    res.json({ history: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activity logs — what you ACTUALLY did when it differs from the plan (e.g.
// scheduled Pull but you walked instead). Free-form, multiple per day allowed.

// Roll a day's logged activity minutes into the metrics spine as
// health:exercise_minutes (source 'activity'), so logged Zone 2 walks etc. feed
// training-load (ACWR), trends, and correlations like any other health metric.
// ALSO estimates the steps + active energy those activities burned (from type ×
// duration × body weight) and writes them under source 'activity_est', so days
// you didn't wear the watch still get credited. Both writes recompute the day's
// full total each call (idempotent via the (ts,domain,metric,source) upsert).
async function syncActivityMinutes(date) {
  try {
    const metricsStore = require('./src/store/metrics');
    const { estimateActivity } = require('./src/intelligence/activity-estimates');
    const ts = new Date(`${date}T12:00:00`);

    const { rows } = await db.query(
      `SELECT activity_type, duration_min, no_watch FROM activity_logs
       WHERE log_date = $1 AND duration_min IS NOT NULL`, [date]
    );
    const mins = rows.reduce((s, r) => s + Number(r.duration_min || 0), 0);

    // Latest logged body weight (lbs) for the energy formula; estimator falls back
    // to a default if none is on record.
    const weightRow = await metricsStore.latest({ domain: 'health', metric: 'weight' }).catch(() => null);
    const weightLb = weightRow ? Number(weightRow.value) : undefined;

    // Only watch-off activities contribute an estimate — otherwise the watch
    // already measured the movement and adding it would double-count.
    let estSteps = 0, estKcal = 0;
    for (const r of rows) {
      if (!r.no_watch) continue;
      const e = estimateActivity({ type: r.activity_type, minutes: r.duration_min, weightLb });
      estSteps += e.steps;
      estKcal += e.kcal;
    }

    await metricsStore.insertMetrics([
      { ts, domain: 'health', metric: 'exercise_minutes', value: mins, unit: 'min', source: 'activity' },
      { ts, domain: 'health', metric: 'steps', value: estSteps, unit: 'count', source: 'activity_est' },
      { ts, domain: 'health', metric: 'active_energy', value: estKcal, unit: 'kcal', source: 'activity_est' },
    ]);
  } catch (err) {
    console.error('[syncActivityMinutes] failed:', err.message);
  }
}

// GET /api/activity?date=YYYY-MM-DD — list activities logged for a day.
app.get('/api/activity', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const { rows } = await db.query(
      `SELECT id, activity_type, label, duration_min, note, planned_type, no_watch, created_at
       FROM activity_logs WHERE log_date = $1
       ORDER BY created_at ASC`, [date]
    );
    // Attach the estimated steps/energy for watch-off activities (the only ones
    // that contribute an estimate to the day's totals).
    const { estimateActivity } = require('./src/intelligence/activity-estimates');
    const weightRow = await require('./src/store/metrics').latest({ domain: 'health', metric: 'weight' }).catch(() => null);
    const weightLb = weightRow ? Number(weightRow.value) : undefined;
    const activities = rows.map((r) => ({
      ...r,
      estimate: r.no_watch ? estimateActivity({ type: r.activity_type, minutes: r.duration_min, weightLb }) : null,
    }));
    res.json({ activities });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/activity — log an activity. Body: { date, activity_type, label?,
// duration_min?, note?, planned_type? }. Returns the inserted row.
app.post('/api/activity', async (req, res) => {
  try {
    const { date, activity_type, label = null, duration_min = null, note = null, planned_type = null, no_watch = false } = req.body || {};
    if (!date || !activity_type) return res.status(400).json({ error: 'date and activity_type required' });
    const { rows } = await db.query(
      `INSERT INTO activity_logs (log_date, activity_type, label, duration_min, note, planned_type, no_watch)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, activity_type, label, duration_min, note, planned_type, no_watch, created_at`,
      [date, activity_type, label, duration_min == null ? null : Number(duration_min), note, planned_type, !!no_watch]
    );
    await syncActivityMinutes(date);
    // Per-activity estimate so the client can show "≈ 1,240 steps · 540 kcal".
    // Only meaningful for watch-off activities (otherwise the watch already counted it).
    const { estimateActivity } = require('./src/intelligence/activity-estimates');
    const weightRow = await require('./src/store/metrics').latest({ domain: 'health', metric: 'weight' }).catch(() => null);
    const estimate = no_watch
      ? estimateActivity({ type: activity_type, minutes: duration_min, weightLb: weightRow ? Number(weightRow.value) : undefined })
      : null;
    res.json({ activity: rows[0], estimate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/activity/:id — remove a logged activity (mis-entry / undo).
app.delete('/api/activity/:id', async (req, res) => {
  try {
    const { rows } = await db.query('DELETE FROM activity_logs WHERE id = $1 RETURNING log_date', [req.params.id]);
    if (rows[0]) {
      const d = rows[0].log_date;
      const ds = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
      await syncActivityMinutes(ds);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Weekly intentions — the Sunday check-in (life context + focus goals). GET
// returns the current week's entry (so the Today card can pre-fill / know if
// it's been set); POST upserts it.
app.get('/api/intentions/current', async (req, res) => {
  try {
    res.json({
      weekStart: intentionsStore.weekStart(),
      intention: await intentionsStore.currentIntention(),
      // Last week's goals, so the Sunday card can show them with a checkbox to
      // mark which were achieved.
      prior: await intentionsStore.priorIntention(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/intentions', async (req, res) => {
  try {
    const { context, goals } = req.body || {};
    res.json({ intention: await intentionsStore.saveIntention({ context, goals }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record which of a (default: prior) week's goals were achieved. Body:
// { weekStart?: 'YYYY-MM-DD', achieved: boolean[] } aligned to that week's goals.
app.post('/api/intentions/results', async (req, res) => {
  try {
    const { weekStart, achieved } = req.body || {};
    res.json({ intention: await intentionsStore.saveGoalResults({ weekStart, achieved }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Life chapters — persistent long-arc facts (a pregnancy + due date, a big
// deadline) that auto-advance and inform every brief without being re-typed
// into weekly context. Creatable here or by telling the Ask chat / voice chief
// ("remember: Nancy is due January 6th").
const lifeChaptersStore = require('./src/store/lifeChapters');

app.get('/api/chapters', async (req, res) => {
  try {
    const chapters = await lifeChaptersStore.listActive();
    res.json({ chapters });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chapters', async (req, res) => {
  try {
    const { kind, label, keyDate, keyDateLabel, notes } = req.body || {};
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'label is required' });
    const chapter = await lifeChaptersStore.create({
      kind: ['pregnancy', 'countdown', 'note'].includes(kind) ? kind : 'countdown',
      label: String(label).trim().slice(0, 120),
      keyDate: keyDate || null,
      keyDateLabel: keyDateLabel ? String(keyDateLabel).slice(0, 40) : null,
      notes: notes ? String(notes).slice(0, 500) : null,
    });
    res.json({ chapter });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/chapters/:id', async (req, res) => {
  try {
    const ok = await lifeChaptersStore.deactivate(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Standalone weather — so the Today card can show/refresh weather on its own,
// fast, without waiting on the full LLM briefing. Cached briefly in-memory so
// repeated loads (and the briefing) don't hammer the provider; ?refresh=1
// forces a fresh pull.
let weatherCache = { at: 0, data: null };
const WEATHER_TTL_MS = Number(process.env.WEATHER_CACHE_MS || 10 * 60 * 1000);
app.get('/api/weather', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const fresh = Date.now() - weatherCache.at < WEATHER_TTL_MS;
    if (!force && fresh && weatherCache.data) {
      return res.json({ weather: weatherCache.data, cached: true });
    }
    const weather = await fetchWeather();
    weatherCache = { at: Date.now(), data: weather };
    res.json({ weather, cached: false });
  } catch (err) {
    // Fall back to a stale cached value rather than failing the card outright.
    if (weatherCache.data) return res.json({ weather: weatherCache.data, cached: true, stale: true });
    res.status(500).json({ error: err.message });
  }
});

// Generic canonical metric ingestion for any future source.
app.post('/api/ingest/metrics', async (req, res) => {
  try {
    const written = await metricsStore.insertMetrics(req.body);
    res.json({ written });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic: show EXACTLY how 30-day income/spending are computed from Monarch
// transactions, so a mismatch with Monarch's report can be debugged from the data
// (not screenshots). Mirrors the sync's classification. ?days=30 by default.
app.get('/api/debug/wealth-income', async (req, res) => {
  try {
    const sync = require('./src/connectors/monarch-mcp-sync');
    const monarchMcp = require('./src/services/monarch-mcp');
    const { isInternalTransfer, isExcludedIncome, isNonIncomePositive, isFixedCategory } = require('./src/connectors/monarch');
    const days = Math.min(Number(req.query.days) || 30, 90);
    const ymd = (d) => new Date(d).toISOString().slice(0, 10);
    const start = ymd(new Date(Date.now() - days * 864e5));
    const end = ymd(new Date());
    const today = end;

    const [txns, incomeCats, transferCats, fixedCats] = await Promise.all([
      sync.fetchTxnsInRange(start, end),
      sync.incomeCategoryNames(),
      sync.transferCategoryNames(),
      sync.fixedCategoryNames(),
    ]);

    // Monarch's OWN aggregation (now the PRIMARY source for the stored metrics).
    // These are the numbers that should match Monarch's Reports view to the dollar.
    const sumCash = (cf) => {
      let total = 0;
      for (const [k, v] of cf || new Map()) {
        if (String(k).slice(0, 10) > today) continue;
        total += Math.abs(v);
      }
      return Math.round(total);
    };
    let cashflow = null;
    try {
      const [ci, ce, cd] = await Promise.all([
        sync.dailyCashflow(start, end, 'income', transferCats),
        sync.dailyCashflow(start, end, 'expense', transferCats),
        sync.dailyCashflow(start, end, 'expense', [...new Set([...transferCats, ...fixedCats])]),
      ]);
      cashflow = {
        income: sumCash(ci),
        spending: sumCash(ce),
        spending_discretionary: sumCash(cd),
        note: 'GetCashFlow (Monarch Reports math) — PRIMARY source for stored metrics',
      };
    } catch (err) {
      cashflow = { error: err.message };
    }

    let income = 0, spend = 0, transfersSkipped = 0;
    const incomeTxns = [], excludedPositives = [];
    for (const t of txns || []) {
      if (!t || !t.date) continue;
      const amount = Number(t.amount);
      if (!Number.isFinite(amount) || amount === 0) continue;
      const category = String(t.category || '');
      const categoryType = String(t.category_type || t.categoryType || '').toLowerCase();
      if (categoryType === 'transfer' || isInternalTransfer(category)) { transfersSkipped++; continue; }
      if (String(t.date).slice(0, 10) > today) continue;
      if (amount < 0) { spend += Math.abs(amount); continue; }
      const inIncomeCategory = incomeCats.size
        ? incomeCats.has(category.toLowerCase())
        : (categoryType ? categoryType === 'income' : (!isExcludedIncome(category) && !isNonIncomePositive(category)));
      const row = { date: String(t.date).slice(0, 10), merchant: t.merchant, category, categoryType, amount: Math.round(amount) };
      if (inIncomeCategory && !isExcludedIncome(category)) { income += amount; incomeTxns.push(row); }
      else excludedPositives.push(row);
    }
    incomeTxns.sort((a, b) => b.amount - a.amount);
    excludedPositives.sort((a, b) => b.amount - a.amount);

    res.json({
      window: { start, end, days },
      mcpConfigured: monarchMcp.isConfigured(),
      cashflow,                                     // ⇐ PRIMARY: should match Monarch Reports
      incomeCategoriesDetected: [...incomeCats],   // empty ⇒ GetCategories shape didn't parse → heuristic fallback
      transferCategoriesDetected: [...transferCats],
      txnCount: (txns || []).length,
      txnDerived: {                                 // FALLBACK math (only used if GetCashFlow is down)
        income30d: Math.round(income),
        spending30d: Math.round(spend),
        transfersSkipped,
      },
      topIncomeTxns: incomeTxns.slice(0, 20),       // what's COUNTED as income (fallback path)
      topExcludedPositives: excludedPositives.slice(0, 20), // positives NOT counted (refunds/transfers)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger all server-side connectors on demand. ?full=1 forces a complete
// re-sync (ignores each source's last-sync timestamp).
app.post('/api/ingest/run', async (req, res) => {
  try {
    const full = req.query.full === '1' || req.query.full === 'true';
    const only = req.query.only || null;
    res.json({ results: await runIngest({ full, only }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retire the demo data once real sources are flowing — deletes exactly what the
// seeder created (source='seed' metrics + seed-tagged goals) and re-analyzes.
app.post('/api/admin/reset-demo', async (req, res) => {
  try {
    const m = await db.query(`DELETE FROM metrics WHERE source = 'seed'`);
    const g = await db.query(`DELETE FROM goals WHERE metadata->>'seed' = 'true'`);
    await db.query(`DELETE FROM sources WHERE id = 'seed'`);
    const summary = await analyze();
    res.json({ deletedMetrics: m.rowCount, deletedGoals: g.rowCount, analyzed: summary || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rebuild the daily wealth flow metrics from stored Monarch transactions with
// the current rules (excludes internal transfers / card payments). The sync
// skips unchanged CSVs, so this is how historical spending gets corrected
// without re-uploading. Re-runs analyze() so Insights reflect the new numbers.
app.post('/api/admin/recompute-wealth', async (req, res) => {
  try {
    const { recomputeWealthFlows } = require('./src/services/recompute-wealth');
    const result = await recomputeWealthFlows();
    const analyzed = await analyze().catch((e) => ({ error: e.message }));
    res.json({ ...result, analyzed: analyzed || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Monarch CSV upload: POST the raw CSV body (transactions OR balances export).
// The cloud can't see files on your Mac, so this is how the monthly export
// reaches it — `curl --data-binary @export.csv`. Idempotent: re-uploading the
// same month overwrites the same daily metrics rather than double-counting.
app.post('/api/import/monarch', express.text({ type: '*/*', limit: '25mb' }), async (req, res) => {
  try {
    const text = typeof req.body === 'string' ? req.body : '';
    if (!text.trim()) return res.status(400).json({ error: 'send the CSV as the request body' });
    const { kind, rows, metrics, documents } = monarch.importText(text);
    if (kind === 'unknown') {
      return res.status(422).json({ error: 'could not recognize this as a Monarch transactions or balances export', rows });
    }
    await sourcesStore.registerSource({ id: 'monarch', domain: 'wealth', displayName: 'Monarch (CSV import)' });
    const written = await metricsStore.insertMetrics(metrics);
    let docs = 0;
    for (const doc of documents) {
      if (await documentsStore.upsertDocument(doc)) docs++;
    }
    await sourcesStore.markSync('monarch');
    const summary = await analyze();
    res.json({ kind, rows, metrics: written, documents: docs, analyzed: summary || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Querying the spine --------------------------------------------------

// GET /api/metrics?domain=health&metric=hrv&from=...&to=...&agg=avg
app.get('/api/metrics', async (req, res) => {
  const { domain, metric, from, to, agg } = req.query;
  if (!domain || !metric) {
    return res.status(400).json({ error: 'domain and metric are required' });
  }
  try {
    const series = agg
      ? await metricsStore.dailyAggregate({ domain, metric, from, to, agg })
      : await metricsStore.getSeries({ domain, metric, from, to });
    res.json({ domain, metric, series });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sources/freshness — most recent DATA date per key source, so the app
// can show "Eight Sleep: last night / 3 days behind" and catch a missed sync.
// Metrics are anchored at noon-UTC of their data date, so the UTC date of the
// latest row IS the day the data covers (not the sync clock time).
app.get('/api/sources/freshness', async (req, res) => {
  try {
    const LABELS = { eight_sleep: 'Eight Sleep', apple_health: 'Apple Watch', monarch: 'Finances' };
    const { rows } = await db.query(
      `SELECT source, to_char(max(ts) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date
         FROM metrics WHERE source = ANY($1) GROUP BY source`,
      [Object.keys(LABELS)]
    );
    const todayUtc = new Date().toISOString().slice(0, 10);
    const ageDays = (d) => Math.round((new Date(todayUtc + 'T00:00:00Z') - new Date(d + 'T00:00:00Z')) / 86400000);
    const sources = rows
      .map((r) => ({ source: r.source, label: LABELS[r.source], date: r.date, ageDays: ageDays(r.date) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    res.json({ sources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/metrics/history?metric=hrv&days=60
// Returns the last N days of raw readings for a single metric, ordered oldest
// to newest. Used by charts that need the full time-series (not aggregated).
app.get('/api/metrics/history', async (req, res) => {
  const { metric, days, source } = req.query;
  if (!metric) return res.status(400).json({ error: 'metric is required' });
  const numDays = Math.max(1, Number(days) || 60);
  try {
    const params = [metric, String(numDays)];
    let sourceClause = '';
    if (source) { params.push(source); sourceClause = `AND source = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT ts, value FROM metrics
       WHERE metric = $1
         AND ts >= now() - ($2 || ' days')::interval
         ${sourceClause}
       ORDER BY ts ASC`,
      params
    );
    res.json({ rows: rows.map((r) => ({ ts: r.ts, value: Number(r.value) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/findings', async (req, res) => {
  try {
    res.json({ findings: await findingsStore.listFindings({ status: req.query.status }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Daily Readwise highlights for the Wisdom tab card. Favorites-first, filling
// with random ones if you've hearted few. Won't repeat a highlight shown in the
// last 30 days (tracked in `surfaced`). DAY-LOCKED: the first request of the day
// picks the set and caches it (daily_picks), so it stays identical all day
// across devices and pull-to-refresh — like the Notion page / daily quote.
// `?refresh=1` forces a fresh set (the "New set" button).
app.get('/api/highlights', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 5, 20));
    const favoritesOnly = req.query.favoritesOnly === '1' || req.query.favoritesOnly === 'true';
    const force = req.query.refresh === '1' || req.query.refresh === 'true';

    // Return today's locked set unless an explicit refresh was requested.
    if (!force) {
      const cached = await dailyPicksStore.get('highlights').catch(() => null);
      if (cached && Array.isArray(cached) && cached.length) {
        return res.json({ highlights: cached });
      }
    }

    const seen = await surfacedStore.recentRefs('highlight', 30);
    const rows = await documentsStore.randomHighlights({ limit, favoritesOnly, exclude: [...seen] });
    if (rows.length) await surfacedStore.record('highlight', rows.map((r) => r.id));
    const highlights = rows.map((r) => ({
      id: r.id,
      text: r.content,
      title: r.title,
      author: r.author,
      url: r.url,
      favorite: !!(r.metadata && r.metadata.favorite),
    }));

    // Lock this set as today's pick (force → replace; otherwise set-if-absent so
    // two same-day first-hits don't diverge).
    if (highlights.length) {
      const stored = force
        ? await dailyPicksStore.replace('highlights', highlights).catch(() => highlights)
        : await dailyPicksStore.set('highlights', highlights).catch(() => highlights);
      return res.json({ highlights: stored });
    }
    res.json({ highlights });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run the intelligence layer (trends + correlations) on demand.
app.post('/api/analyze', async (req, res) => {
  try {
    const result = await analyze();
    // Regenerate cross-context insights from the fresh findings so "Re-run analysis"
    // immediately reflects updated correlations (not just the nightly scheduler run).
    require('./src/intelligence/crossContext').generateCrossContext()
      .catch((e) => console.error('[analyze] crossContext regen failed:', e.message));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rebuild the self-model from today's data — normally runs nightly at 9:30pm,
// but POST here to regenerate on demand (after a check-in, post-backfill, etc.).
app.post('/api/consolidate', async (req, res) => {
  try {
    const { consolidate } = require('./src/intelligence/consolidate');
    const content = await consolidate({ kind: 'manual' });
    res.json({ ok: true, length: content.length, preview: content.slice(0, 200) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read the current self-model back — the full portrait NormOS injects into every
// voice surface. Returns the latest consolidated model (content + when + snapshot).
app.get('/api/consolidate', async (req, res) => {
  try {
    const row = await require('./src/store/selfModel').latestModel();
    if (!row) return res.json({ ok: true, model: null, message: 'No self-model yet — POST /api/consolidate to build one.' });
    res.json({ ok: true, generatedAt: row.generated_at, kind: row.kind, content: row.content, snapshot: row.snapshot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backfill embeddings for the knowledge graph / chat retrieval.
app.post('/api/embed', async (req, res) => {
  try {
    res.json(await embedPending());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shopping agent (UCP). Two-step, fully in-app: discover surfaces product
// options ("white running sneakers under $100"); cart builds a checkout link for
// the one you pick. Only the final checkout leaves the app. Never pays for you.
app.post('/api/shop/discover', async (req, res) => {
  try {
    const { message, country } = req.body || {};
    res.json(await discover(message, { country }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/shop/cart', async (req, res) => {
  try {
    const { business, variantId, quantity, item } = req.body || {};
    res.json(await addToCart({ business, variantId, quantity, item }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shop history for one-tap reorder.
app.get('/api/shop/history', async (req, res) => {
  try {
    res.json({ orders: await shopHistory({ limit: 12 }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic: see what the UCP CLI actually returns on this host.
app.get('/api/shop/ucp-probe', async (req, res) => {
  try {
    res.json(await ucpProbe(req.query.q || 'protein bars'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic: walk the UCP HTTP flow (config → token → search) and surface the
// REAL error at whichever stage fails, instead of discover's silent fallback.
app.get('/api/shop/ucp-diagnose', async (req, res) => {
  try {
    res.json(await ucp.diagnose(req.query.q || 'aloha protein bars'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic: time a raw Gemini call to see if the model/endpoint itself is slow
// or erroring (separate from the full briefing pipeline). ?big=1 sends a large
// prompt to mimic the briefing's load.
app.get('/api/diag/gemini', async (req, res) => {
  const t0 = Date.now();
  try {
    const big = req.query.big === '1';
    const prompt = big
      ? 'Here is a long document:\n' + 'The market rose 2%. '.repeat(2000) + '\nReturn JSON {"summary":"<2 sentences>"}'
      : 'Reply with JSON {"ok":true,"msg":"hello"}';
    const out = await llm.generateText({ system: 'Return only JSON.', prompt, temperature: 0.2, maxTokens: 1024 });
    res.json({ ok: true, ms: Date.now() - t0, model: process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash', replyLen: out.length, sample: out.slice(0, 200) });
  } catch (err) {
    res.json({ ok: false, ms: Date.now() - t0, model: process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash', status: err.response?.status, error: (err.response?.data?.error?.message || err.message || '').slice(0, 300) });
  }
});

// Live recovery score — the same computation the briefing embeds, but
// standalone and fast (a few aggregate queries, no LLM, no briefing build).
// Lets the Health tab refresh the recovery card in under a second instead of
// waiting out a full briefing rebuild.
app.get('/api/recovery', async (req, res) => {
  try {
    // Debug: ?forceCheckIn=1 forces the sleep check-in card to show (so the
    // no-Pod flow can be tested without an actual no-Pod night).
    if (req.query.forceCheckIn === '1') {
      return res.json({ recovery: null, needsSleepCheckIn: true });
    }
    const rec = require('./src/intelligence/recovery');
    const recovery = await rec.liveRecovery();
    // When there's no recovery (no Pod reading last night) AND no self-report yet,
    // tell the client to prompt the sleep check-in.
    const needsSleepCheckIn = recovery ? false : await rec.needsSleepCheckIn();
    res.json({ recovery, needsSleepCheckIn });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recovery-score trend: the last N days of composite recovery, computed with the
// same scorer as the live card. Returns { rows:[{ts,value}] } like metrics/history.
app.get('/api/recovery/history', async (req, res) => {
  try {
    const days = Math.max(7, Math.min(Number(req.query.days) || 30, 90));
    const rec = require('./src/intelligence/recovery');
    res.json({ rows: await rec.recoveryHistory({ days }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Self-reported sleep for nights without an Eight Sleep reading. Stores a 1–5
// quality (and optional hours), then recomputes recovery as a subjective proxy
// that drives the recovery card / forecast / brief for the day.
app.post('/api/recovery/self-report', async (req, res) => {
  try {
    const quality = Number(req.body?.quality);
    const hours = req.body?.hours != null && req.body.hours !== '' ? Number(req.body.hours) : null;
    if (!Number.isFinite(quality) || quality < 1 || quality > 5) {
      return res.status(400).json({ error: 'quality (1-5) required' });
    }
    await sourcesStore.registerSource({ id: 'self_report', domain: 'health', displayName: 'Self-reported sleep' });
    // Anchor at noon UTC of today's LOCAL date so the day-slice matches how
    // liveRecovery compares "today" (wake-date convention).
    const tz = process.env.TZ || 'America/New_York';
    const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const ts = new Date(`${todayLocal}T12:00:00Z`);
    const rows = [{ ts, domain: 'health', metric: 'sleep_quality', value: quality, unit: '', source: 'self_report' }];
    if (Number.isFinite(hours) && hours > 0 && hours <= 24) {
      rows.push({ ts, domain: 'health', metric: 'sleep_hours', value: hours, unit: 'hours', source: 'self_report' });
    }
    const written = await metricsStore.insertMetrics(rows);
    const recovery = await require('./src/intelligence/recovery').liveRecovery();
    // Return the new proxy recovery immediately. The mobile then fires its normal
    // non-blocking briefing rebuild (triggerRebuild) which picks up this stored
    // self-report — so the brief rebuilds with the recovery score AND the app
    // actually refetches it (the old server-only background build never reached
    // the client, so the briefing looked unchanged after submit).
    res.json({ ok: true, written, recovery });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scheduler health check — shows whether the scheduler is enabled and when
// the morning routine will next fire (helps diagnose missing 8:30am briefings).
app.get('/api/diag/scheduler', (req, res) => {
  const { msUntil } = require('./src/scheduler');
  const enabled = process.env.ENABLE_SCHEDULER === 'true';
  const tz = process.env.TZ || '(not set — server uses system/UTC)';
  const hour = Number(process.env.SCHEDULE_HOUR) || 8;
  const minute = Number(process.env.SCHEDULE_MINUTE) || 30;
  const checkinH = Number(process.env.CHECKIN_REMINDER_HOUR) || 15;
  const eveningH = Number(process.env.CHECKIN_EVENING_REMINDER_HOUR) || 21;
  const habitsH = Number(process.env.HABITS_REMINDER_HOUR) || 21;

  const nextMs = (h, m) => {
    try { return msUntil(h, m); } catch { return null; }
  };
  const toWallClock = (ms) => ms == null ? null : new Date(Date.now() + ms).toISOString();

  res.json({
    enabled,
    tz,
    now: new Date().toISOString(),
    serverTime: new Date().toLocaleString('en-US', { timeZone: process.env.TZ || 'UTC' }),
    jobs: {
      morning:         { configured: `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`, nextFireAt: toWallClock(nextMs(hour, minute)) },
      checkinAfternoon:{ configured: `${String(checkinH).padStart(2,'0')}:00`, nextFireAt: toWallClock(nextMs(checkinH, 0)) },
      checkinEvening:  { configured: `${String(eveningH).padStart(2,'0')}:00`, nextFireAt: toWallClock(nextMs(eveningH, 0)) },
      habits:          { configured: `${String(habitsH).padStart(2,'0')}:00`, nextFireAt: toWallClock(nextMs(habitsH, 0)) },
    },
    hint: !enabled
      ? 'Set ENABLE_SCHEDULER=true in Railway env vars to enable the morning routine.'
      : tz.includes('not set')
      ? 'TZ is not set — scheduler fires at UTC times. Set TZ=America/New_York if you want Eastern times.'
      : 'Scheduler is active.',
  });
});

// Diagnostic: dump the RAW metric rows for a metric over the last N days,
// grouped by day + source. Reveals duplication that a daily SUM would inflate —
// e.g. many step rows for the same day (pre-fix per-refresh writes) all summed.
// GET /api/diag/recovery-baseline — shows the raw series and baseline stats
// (mean, std, z, n) that drive the recovery percentile scores, so we can
// verify the data matches what Apple Health reports.
app.get('/api/diag/recovery-baseline', async (req, res) => {
  try {
    const metricsStore = require('./src/store/metrics');
    const recovery = require('./src/intelligence/recovery');
    const METRICS = ['health:hrv', 'health:resting_hr', 'health:sleep_score', 'health:sleep_hours'];
    const from = new Date(Date.now() - 60 * 864e5);
    const out = {};
    // Mirror the live recovery path: HRV/RHR are source-locked to the manual
    // Eight Sleep overnight numbers (+ baseline), so this diagnostic shows the
    // SAME series the recovery score actually uses, not a daytime-polluted one.
    const NIGHT_LOCK = { 'health:hrv': ['eight_sleep', 'eight_sleep_baseline'], 'health:resting_hr': ['eight_sleep', 'eight_sleep_baseline'] };
    for (const key of METRICS) {
      const [domain, metric] = key.split(':');
      const rows = NIGHT_LOCK[key]
        ? await metricsStore.dailyAggregatePreferSource({ domain, metric, from, agg: 'avg', sources: NIGHT_LOCK[key] })
        : await metricsStore.dailyAggregate({ domain, metric, from, agg: 'avg', excludeSource: 'seed' });
      const vals = rows.map((r) => Number(r.value)).filter(Number.isFinite);
      const today = vals.length ? vals[vals.length - 1] : null;
      const baseline = vals.length >= 2 ? vals.slice(-(31), -1) : [];
      const sorted = [...baseline].sort((a, b) => a - b);
      const rankPct = today != null && baseline.length >= 8
        ? Math.round((baseline.filter((v) => v < today).length + baseline.filter((v) => v === today).length * 0.5) / baseline.length * 100)
        : null;
      out[key] = {
        n: rows.length,
        today: today != null ? +today.toFixed(2) : null,
        latestDay: rows.length ? rows[rows.length - 1].day : null,
        baseline: baseline.length >= 8 ? {
          n: baseline.length,
          mean: +(baseline.reduce((a, b) => a + b, 0) / baseline.length).toFixed(2),
          min: +sorted[0].toFixed(2),
          p25: +sorted[Math.floor(sorted.length * 0.25)].toFixed(2),
          median: +sorted[Math.floor(sorted.length * 0.5)].toFixed(2),
          p75: +sorted[Math.floor(sorted.length * 0.75)].toFixed(2),
          max: +sorted[sorted.length - 1].toFixed(2),
          rankPct,
        } : null,
        series: rows.slice(-35).map((r) => ({ day: r.day, value: +Number(r.value).toFixed(1) })),
      };
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//   GET /api/diag/metric-rows?domain=health&metric=steps&days=7
app.get('/api/diag/metric-rows', async (req, res) => {
  try {
    const domain = String(req.query.domain || 'health');
    const metric = String(req.query.metric || 'steps');
    const days = Math.min(Number(req.query.days) || 7, 120);
    const { rows } = await db.query(
      `SELECT date_trunc('day', ts)::date AS day, source,
              count(*)::int AS rows,
              round(sum(value)::numeric, 1) AS sum,
              round(min(value)::numeric, 1) AS min,
              round(max(value)::numeric, 1) AS max
         FROM metrics
        WHERE domain = $1 AND metric = $2
          AND ts >= now() - ($3 || ' days')::interval
        GROUP BY day, source
        ORDER BY day DESC, source`,
      [domain, metric, String(days)]
    );
    // What the daily SUM (used by analyze/review) would produce per day, and the
    // weekly total — so the inflation is visible at a glance.
    const perDay = {};
    for (const r of rows) perDay[r.day] = (perDay[r.day] || 0) + Number(r.sum);
    const weeklyTotalSummed = Object.values(perDay).reduce((a, b) => a + b, 0);
    res.json({ domain, metric, days, groups: rows, perDaySummed: perDay, weeklyTotalSummed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic: the largest "spending" transactions and their categories over the
// last N days. Reveals whether big spend days are real purchases or internal
// movements (transfers, credit-card payments) wrongly counted as spending.
//   GET /api/diag/top-spend?days=10&limit=25
app.get('/api/diag/top-spend', async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 10, 120);
    const limit = Math.min(Number(req.query.limit) || 25, 200);
    const txns = await documentsStore.spendTransactions({ days });
    const sorted = [...txns].sort((a, b) => b.amount - a.amount).slice(0, limit);
    // Tally by category so transfer/payment pollution is obvious in aggregate.
    const byCategory = {};
    for (const t of txns) byCategory[t.category] = Math.round(((byCategory[t.category] || 0) + t.amount) * 100) / 100;
    res.json({ days, count: txns.length, topTransactions: sorted, byCategory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic: reproduce the EXACT briefing LLM call (real fetched emails, real
// prompt) and time it, so we can see where the 60s goes vs the trivial probe.
app.get('/api/diag/briefing-llm', async (req, res) => {
  const t0 = Date.now();
  try {
    const emails = await withTimeout(fetchGmailThreads(), 15000, 'gmail').catch(() => []);
    const promptChars = JSON.stringify(emails).length;
    const tg = Date.now();
    const result = await generateBriefing(emails, 'Sample notion wisdom text.', 'A sample quote.', 'Tuesday', { type: 'Rest' }, [], '');
    res.json({
      ok: true,
      totalMs: Date.now() - t0,
      gmailMs: tg - t0,
      llmMs: Date.now() - tg,
      emailCount: emails.length,
      emailPayloadChars: promptChars,
      urgentEmails: result.urgentEmails.length,
    });
  } catch (err) {
    res.json({ ok: false, ms: Date.now() - t0, error: (err.message || '').slice(0, 300) });
  }
});

// Life chat — ask questions across your data + library.
app.post('/api/chat', async (req, res) => {
  try {
    const { question, history } = req.body || {};
    const chatStore = require('./src/store/chat');

    // Persistent memory: if the client doesn't supply history, load the recent
    // conversation tail from the DB so threads survive app restarts. A client
    // that sends its own history (back-compat) overrides this.
    let priorHistory = Array.isArray(history) ? history : [];
    if (!priorHistory.length) {
      try {
        const rows = await chatStore.recentMessages({ limit: 20 });
        priorHistory = rows.map((m) => ({ role: m.role, content: m.content }));
      } catch (e) {
        console.error('[chat memory] load failed:', e.message);
      }
    }

    const result = await ask(question, { history: priorHistory });

    // Append this turn so the next question remembers it. Pre-resolve the active
    // thread once (the two saves run concurrently, so this avoids both racing to
    // create it). Store the question embedding for long-term semantic recall.
    const convId = await chatStore.ensureActiveConversation();
    chatStore.saveMessage({ role: 'user', content: question, embedding: result.questionEmbedding ?? null, conversationId: convId })
      .catch((e) => console.error('[chat memory] save user failed:', e.message));
    chatStore.saveMessage({ role: 'assistant', content: result.answer, sources: result.sources ?? [], conversationId: convId })
      .catch((e) => console.error('[chat memory] save assistant failed:', e.message));

    // Don't leak the raw embedding vector to the client.
    const { questionEmbedding, ...clientResult } = result;
    res.json(clientResult);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read the persisted conversation (for the app to render prior turns on open).
app.get('/api/chat/history', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await require('./src/store/chat').recentMessages({ limit });
    res.json({ messages: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Discard the active thread without saving ("Clear").
app.post('/api/chat/clear', async (req, res) => {
  try {
    const removed = await require('./src/store/chat').clearActiveConversation();
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save (archive) the active thread, then start fresh. Optional { title }.
app.post('/api/chat/save', async (req, res) => {
  try {
    const { title = null } = req.body || {};
    const saved = await require('./src/store/chat').saveActiveConversation({ title });
    res.json({ ok: true, conversation: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Extract a self-experiment from a chat conversation using Claude.
app.post('/api/chat/extract-experiment', async (req, res) => {
  try {
    const { messages = [] } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'messages required' });
    }

    const METRICS = [
      { key: 'health:hrv', label: 'HRV (ms)' },
      { key: 'health:sleep_hours', label: 'Sleep duration (hours)' },
      { key: 'health:sleep_score', label: 'Sleep score (0-100)' },
      { key: 'health:resting_hr', label: 'Resting heart rate (bpm)' },
      { key: 'habits:cold_shower', label: 'Cold shower (yes/no daily)' },
      { key: 'habits:exercise', label: 'Exercise (yes/no daily)' },
      { key: 'habits:eat_healthy', label: 'Eating healthy (1-5 daily score)' },
      { key: 'wellbeing:mood', label: 'Mood (1-10)' },
      { key: 'wellbeing:energy', label: 'Energy (1-10)' },
      { key: 'wellbeing:focus', label: 'Focus (1-10)' },
    ];

    const transcript = messages
      .slice(-20)
      .map((m) => `${m.role === 'user' ? 'User' : 'NormOS'}: ${m.content}`)
      .join('\n\n');

    const metricsList = METRICS.map((m) => `  - ${m.key}: ${m.label}`).join('\n');

    const prompt = `Extract ONE concrete self-experiment from this conversation.

CONVERSATION:
${transcript}

TRACKABLE METRICS (use only these exact keys):
${metricsList}

Return ONLY valid JSON — no markdown, no explanation.

If an experiment is extractable:
{"hypothesis":"...","metric":"health:hrv","lever":"...","expected":"up","protocol":"...","testDays":14}

If the conversation has no clear experimental idea to track:
{"notActionable":true,"reason":"..."}

Rules:
- expected must be "up" or "down"
- testDays must be 14, 21, or 28
- metric must be one of the keys above
- hypothesis should be one clear sentence`;

    const raw = await llm.generateText({
      system: 'You extract self-experiments from conversations. Return only valid JSON.',
      prompt,
      maxTokens: 400,
    });

    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'parse failed', raw: cleaned.slice(0, 300) });
    }

    if (!result.notActionable) {
      const validKeys = METRICS.map((m) => m.key);
      if (!validKeys.includes(result.metric)) result.metric = 'wellbeing:energy';
      if (result.expected !== 'down') result.expected = 'up';
      if (![14, 21, 28].includes(Number(result.testDays))) result.testDays = 14;
      else result.testDays = Number(result.testDays);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List saved conversations for the sidebar.
app.get('/api/chat/conversations', async (req, res) => {
  try {
    res.json({ conversations: await require('./src/store/chat').listConversations() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resume a saved conversation (make it the live thread); returns its messages.
app.post('/api/chat/conversations/:id/open', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const messages = await require('./src/store/chat').openConversation(id);
    res.json({ ok: true, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a saved conversation and its messages.
app.delete('/api/chat/conversations/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const removed = await require('./src/store/chat').deleteConversation(id);
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename a saved conversation.
app.patch('/api/chat/conversations/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const { title } = req.body || {};
    if (typeof title !== 'string') return res.status(400).json({ error: 'title required' });
    const updated = await require('./src/store/chat').updateConversationTitle(id, title);
    res.json({ ok: true, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-time backfill: embed any past user questions saved before long-term recall
// existed, so they become semantically retrievable. Safe to re-run (idempotent).
app.post('/api/chat/reindex', async (req, res) => {
  try {
    const chatStore = require('./src/store/chat');
    const pending = await chatStore.unembeddedQuestions({ limit: 500 });
    let embedded = 0;
    // Embed in small batches to respect provider limits.
    for (let i = 0; i < pending.length; i += 32) {
      const batch = pending.slice(i, i + 32);
      const vecs = await llm.embed(batch.map((m) => m.content)).catch(() => []);
      for (let j = 0; j < batch.length; j++) {
        if (vecs[j]) { await chatStore.setEmbedding(batch[j].id, vecs[j]); embedded++; }
      }
    }
    res.json({ ok: true, pending: pending.length, embedded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Life context (annotations) -----------------------------------------

app.post('/api/annotations', async (req, res) => {
  try {
    const { startTs, endTs, category, label, note } = req.body || {};
    if (!startTs || !category || !label) {
      return res.status(400).json({ error: 'startTs, category, and label are required' });
    }
    const id = await annotationsStore.createAnnotation({ startTs, endTs, category, label, note });
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Convert a naive datetime string (no Z / no offset) from a named timezone to UTC ISO.
// The mobile client sends "2026-06-17T00:00:00" meaning midnight in ITS timezone.
// PostgreSQL would treat that as UTC midnight, which is wrong for ET/PT/etc.
function naiveToUtcIso(naiveStr, tz) {
  if (!naiveStr || naiveStr.includes('Z') || naiveStr.match(/[+-]\d{2}:/)) return naiveStr;
  // Trick: pretend the naive string is UTC, then measure how much local time in `tz`
  // differs from UTC at that moment, and apply the inverse offset.
  const asUtc = new Date(naiveStr + 'Z');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(asUtc);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  const localStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
  const offsetMs = new Date(localStr + 'Z').getTime() - asUtc.getTime();
  return new Date(asUtc.getTime() - offsetMs).toISOString();
}

app.get('/api/annotations', async (req, res) => {
  try {
    let { from, to } = req.query;
    // Use the client's timezone (X-Time-Zone header) so date boundaries are correct
    // when the user is travelling. Falls back to server TZ (America/New_York).
    const tz = req.headers['x-time-zone'] || process.env.TZ || 'America/New_York';
    res.json({ annotations: await annotationsStore.listAnnotations({ from: naiveToUtcIso(from, tz), to: naiveToUtcIso(to, tz) }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Returns annotations that are CURRENTLY ACTIVE — same overlapping() query the
// briefing uses. Needed because multi-day events (travel) have start_ts in the
// past, so they're invisible to the ?from=today list query in the ContextCard.
app.get('/api/annotations/active', async (req, res) => {
  try {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const active = await annotationsStore.overlapping(startOfToday, new Date());
    res.json({ annotations: active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/annotations/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id || typeof id !== 'string' || id.length < 8) return res.status(400).json({ error: 'invalid id' });
    const { query } = require('./src/db');
    await query('DELETE FROM annotations WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/annotations/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id || typeof id !== 'string' || id.length < 8) return res.status(400).json({ error: 'invalid id' });
    const { label } = req.body || {};
    if (!label || !label.trim()) return res.status(400).json({ error: 'label required' });
    const { query } = require('./src/db');
    await query('UPDATE annotations SET label = $1 WHERE id = $2', [label.trim(), id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pre-brief context answers — user responds to a signal question; store as
// annotation so it flows into annotationsContext on the next briefing build.
app.post('/api/briefing/context', async (req, res) => {
  try {
    const { question, answer, signalKey } = req.body || {};
    if (!answer || typeof answer !== 'string' || !answer.trim()) {
      return res.status(400).json({ error: 'answer required' });
    }
    // Tag spending-related answers so they're excluded from health/recovery anomaly
    // context (a "$665 on vacation" answer must never explain a low-HRV deviation).
    // The 'spend' substring is what the anomaly filter in analyze.js keys off.
    // Scan the prompt AND the free-text answer — notes typed into the generic
    // "add context" box carry no signalKey, so "Vacation car rental" must be
    // caught by its own wording.
    const FINANCIAL_RE = /\b(spend|spent|spending|financ|wealth|budget|money|bill|bills|rent|rental|invoice|purchase|bought|payment|paid|expense|refund|salary|paycheck|mortgage|loan|vacation|flight|hotel|dollar|cost)\b|\$/i;
    const isSpending = FINANCIAL_RE.test(`${signalKey || ''} ${question || ''} ${answer}`);
    const id = await annotationsStore.createAnnotation({
      startTs: new Date().toISOString(),
      category: isSpending ? 'spending note' : 'brief_context',
      label: answer.trim().slice(0, 500),
      note: question ? `Q: ${question.slice(0, 300)}` : (signalKey ?? null),
    });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('[briefing/context] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Goals ----------------------------------------------------------------

const goalsStore = require('./src/store/goals');

app.get('/api/goals', async (req, res) => {
  try {
    const status = req.query.status ?? 'active';
    res.json({ goals: await goalsStore.listGoals({ status: status === 'all' ? null : status }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/goals', async (req, res) => {
  try {
    const { title, domain, metric, targetValue, unit, targetDate, baselineValue } = req.body ?? {};
    if (!title?.trim()) return res.status(400).json({ error: 'title required' });
    const goal = await goalsStore.createGoal({ title: title.trim(), domain, metric, targetValue, unit, targetDate, baselineValue });
    res.json({ goal });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/goals/:id', async (req, res) => {
  try {
    const { status, title } = req.body ?? {};
    await goalsStore.updateGoal(req.params.id, { status, title });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/goals/:id', async (req, res) => {
  try {
    await goalsStore.deleteGoal(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Experiments (the hypothesis loop) -----------------------------------

app.get('/api/experiments', async (req, res) => {
  try {
    res.json({ experiments: await experimentsStore.listExperiments({ status: req.query.status }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate experiment proposals from unconfirmed correlations.
app.post('/api/experiments/propose', async (req, res) => {
  try {
    res.json(await experiments.proposeExperiments());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a custom experiment, or start a proposed one.
app.post('/api/experiments', async (req, res) => {
  try {
    const id = await experimentsStore.createExperiment(req.body || {});
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start a proposed experiment (sets running + dates).
app.post('/api/experiments/:id/start', async (req, res) => {
  try {
    const { testDays = 14 } = req.body || {};
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + Number(testDays));
    await experimentsStore.updateExperiment(req.params.id, {
      status: 'running',
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    });
    res.json({ ok: true, startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Evaluate a single experiment now.
app.post('/api/experiments/:id/evaluate', async (req, res) => {
  try {
    const exp = await experimentsStore.getExperiment(req.params.id);
    if (!exp) return res.status(404).json({ error: 'not found' });
    res.json(await experiments.evaluateExperiment(exp));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/experiments/:id', async (req, res) => {
  try {
    await require('./src/db').query('DELETE FROM experiments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/experiments/:id — pause or resume an experiment.
// pause: freezes the clock (status → 'paused', records paused_at)
// resume: extends end_date by days paused so the experiment keeps its full duration
app.patch('/api/experiments/:id', async (req, res) => {
  try {
    const { action } = req.body || {};
    const exp = await experimentsStore.getExperiment(req.params.id);
    if (!exp) return res.status(404).json({ error: 'not found' });

    if (action === 'pause') {
      if (exp.status !== 'running') return res.status(400).json({ error: 'only running experiments can be paused' });
      await experimentsStore.updateExperiment(exp.id, { status: 'paused', pausedAt: new Date() });
      return res.json({ ok: true });
    }

    if (action === 'resume') {
      if (exp.status !== 'paused') return res.status(400).json({ error: 'only paused experiments can be resumed' });
      const daysPaused = exp.paused_at
        ? Math.round((Date.now() - new Date(exp.paused_at).getTime()) / 86400000)
        : 0;
      let newEndDate = exp.end_date ? new Date(exp.end_date) : null;
      if (newEndDate && daysPaused > 0) newEndDate.setDate(newEndDate.getDate() + daysPaused);
      await experimentsStore.updateExperiment(exp.id, {
        status: 'running',
        pausedAt: null,
        ...(newEndDate ? { endDate: newEndDate.toISOString().slice(0, 10) } : {}),
      });
      return res.json({ ok: true, daysPaused, newEndDate: newEndDate?.toISOString().slice(0, 10) ?? null });
    }

    res.status(400).json({ error: 'action must be pause or resume' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The ranked "highest leverage actions" — the core NormOS question.
app.get('/api/actions', async (req, res) => {
  try {
    const open = await findingsStore.listFindings({ status: 'open' });
    const actions = open
      .filter((f) => f.type === 'leverage')
      .sort((a, b) => (a.evidence?.rank ?? 99) - (b.evidence?.rank ?? 99))
      .map((f) => ({ title: f.title, detail: f.detail, score: f.evidence?.score, domains: f.domains }));
    res.json({ actions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Goal achievement-probability forecasts (latest analyze run).
app.get('/api/forecasts', async (req, res) => {
  try {
    const open = await findingsStore.listFindings({ status: 'open' });
    const forecasts = open
      .filter((f) => f.type === 'forecast')
      .map((f) => ({
        title: f.title,
        detail: f.detail,
        probability: f.confidence,
        domains: f.domains,
        ...f.evidence,
      }))
      .sort((a, b) => (a.probability ?? 1) - (b.probability ?? 1)); // most at-risk first
    res.json({ forecasts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Register a phone's Expo push token so NormOS can reach out proactively.
app.post('/api/devices/register', async (req, res) => {
  try {
    const { pushToken, platform, label } = req.body || {};
    if (!pushToken) return res.status(400).json({ error: 'pushToken required' });
    const id = await devicesStore.registerDevice({ pushToken, platform, label });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recent nudges (the proactive-message log).
app.get('/api/nudges', async (req, res) => {
  try {
    res.json({ nudges: await nudgesStore.listNudges({ limit: Math.max(1, Math.min(Number(req.query.limit) || 50, 200)) }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate + (optionally) send today's nudges. Cron hits this each morning;
// pass { force, dryRun } to override quiet hours or preview without sending.
app.post('/api/nudges/run', async (req, res) => {
  try {
    const { force = false, dryRun = false } = req.body || {};
    res.json(await runNudges({ force, send: !dryRun }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss a "What The Data Shows" insight by its stable key — stays gone across
// rebuilds (e.g. a recurring car payment flagged for "review"). POST { key, title }.
app.post('/api/insights/dismiss', async (req, res) => {
  try {
    const { key, title = null } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    await require('./src/store/dismissedInsights').dismiss(key, title);
    res.json({ ok: true, dismissed: key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore a dismissed insight. POST { key }.
app.post('/api/insights/undismiss', async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    await require('./src/store/dismissedInsights').undismiss(key);
    res.json({ ok: true, restored: key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List dismissed insights (for a future "manage dismissed" view).
app.get('/api/insights/dismissed', async (req, res) => {
  try {
    res.json({ dismissed: await require('./src/store/dismissedInsights').listDismissed() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger the anomaly watcher (event-driven "your HRV dropped" ping).
// Pass { force: true } to bypass quiet hours, { dryRun: true } to scan without pushing.
app.post('/api/watch/run', async (req, res) => {
  try {
    const { force = false, dryRun = false } = req.body || {};
    res.json(await require('./src/intelligence/watch').runWatch({ force, send: !dryRun }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger the morning routine (pre-build briefing + "ready" push).
// Lets you test the 8am flow on demand; pass { dryRun: true } to build without
// pushing.
app.post('/api/morning/run', async (req, res) => {
  try {
    const { dryRun = false } = req.body || {};
    res.json(await runMorningBriefing({ send: !dryRun }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// External-cron trigger for the morning routine. Accepts a lightweight
// CRON_SECRET (separate from NORMOS_API_TOKEN) so this URL can be called by
// cron-job.org or similar without exposing the main API token.
// Set CRON_SECRET in Railway env vars, then call:
//   POST /api/cron/morning?secret=<CRON_SECRET>
app.post('/api/cron/morning', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured' });
  const provided = req.query.secret || req.body?.secret;
  if (provided !== secret) return res.status(401).json({ error: 'invalid secret' });
  try {
    const r = await runMorningBriefing({ send: true });
    console.log(`[cron] morning triggered externally: built=${r.built} sent=${r.sent}`);
    res.json(r);
  } catch (err) {
    console.error('[cron] morning failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger the afternoon check-in reminder (the 3pm flow). Only pushes
// if you haven't logged today; { force: true } sends regardless for testing.
app.post('/api/checkin/remind', async (req, res) => {
  try {
    const { force = false, dryRun = false } = req.body || {};
    res.json(await runCheckinReminder({ force, send: !dryRun }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger the evening habits reminder (the 10pm flow). Only pushes if
// habits aren't logged today; { force: true } sends regardless for testing.
app.post('/api/habits/remind', async (req, res) => {
  try {
    const { force = false, dryRun = false } = req.body || {};
    res.json(await runHabitsReminder({ force, send: !dryRun }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger the weekly review generation + "review ready" push (the
// Sunday-morning flow), so you can test it on demand. { dryRun: true } generates
// without pushing.
app.post('/api/weekly/run', async (req, res) => {
  try {
    const { dryRun = false } = req.body || {};
    res.json(await runWeeklyReviewWithPush({ send: !dryRun }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Weekly review — the reflective narrative.
app.get('/api/review', async (req, res) => {
  try {
    const wr = await briefingsStore.latestBriefing(req.query.kind || 'weekly');
    res.json(wr ? { ...wr.content, generatedAt: wr.generated_at } : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/review/run', async (req, res) => {
  try {
    res.json(await runReview());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Evening wind-down brief (Apple-Health daytime HRV/RHR → autonomic tone). Returns
// today's brief if already built, else null so the card hides. ?refresh=1 builds
// it on demand (no push) — used by the card if you open the app before 9:30pm.
app.get('/api/evening-brief', async (req, res) => {
  try {
    const tz = process.env.TZ || 'America/New_York';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    let latest = await briefingsStore.latestBriefing('evening');
    const isToday = latest && latest.content && latest.content.day === today;
    if (!isToday && refresh) {
      const { runEveningHealthBrief } = require('./src/notify/evening-brief');
      const r = await runEveningHealthBrief({ send: false, tz });
      return res.json({ ...r.content, generatedAt: new Date().toISOString(), fresh: true });
    }
    if (!isToday) return res.json(null);
    res.json({ ...latest.content, generatedAt: latest.generated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Build + push the evening brief on demand (mirrors the 9:30pm scheduler job).
app.post('/api/evening-brief/run', async (req, res) => {
  try {
    const { runEveningHealthBrief } = require('./src/notify/evening-brief');
    const send = req.query.send !== '0' && req.query.send !== 'false';
    res.json(await runEveningHealthBrief({ send }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lightweight wealth snapshot for external integrations (e.g. a financial planner).
// Returns the latest stored values for net worth and per-bucket totals.
// 401k is NOT a separate metric — Monarch balance exports aggregate all accounts into
// assets/liabilities/net_worth. To get a standalone 401k value, set MONARCH_401K_ACCOUNT
// to the exact account name from your Monarch export (e.g. "Fidelity 401k") and
// this endpoint will return it under `retirement`.
app.get('/api/wealth/snapshot', async (req, res) => {
  try {
    const [nw, assets, liabilities] = await Promise.all([
      metricsStore.latest({ domain: 'wealth', metric: 'net_worth' }),
      metricsStore.latest({ domain: 'wealth', metric: 'assets' }),
      metricsStore.latest({ domain: 'wealth', metric: 'liabilities' }),
    ]);

    // Optional: per-account 401k lookup if MONARCH_401K_ACCOUNT is set.
    // Requires the balance export to have been imported with per-account rows.
    const retirementMetric = process.env.MONARCH_401K_ACCOUNT
      ? `account_${process.env.MONARCH_401K_ACCOUNT.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
      : null;
    const retirement = retirementMetric
      ? await metricsStore.latest({ domain: 'wealth', metric: retirementMetric }).catch(() => null)
      : null;

    res.json({
      netWorth: nw ? { value: Math.round(Number(nw.value)), updatedAt: nw.ts } : null,
      assets: assets ? { value: Math.round(Number(assets.value)), updatedAt: assets.ts } : null,
      liabilities: liabilities ? { value: Math.round(Number(liabilities.value)), updatedAt: liabilities.ts } : null,
      retirement: retirement ? { value: Math.round(Number(retirement.value)), updatedAt: retirement.ts } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Plan baseline for "net worth vs. plan" comparison in the Wealth tab.
// Returns the key starting-position figures from planner_state so the mobile
// app can show actual NW vs. where the plan said you'd start.
app.get('/api/wealth/plan', async (req, res) => {
  try {
    const { loadPlan } = require('./src/services/financial-plan');
    const plan = await loadPlan(); // DB-first, falls back to financial-plan.json
    if (!plan || !plan.P) return res.json({ available: false });
    const P = plan.P;

    // Compute how far through the plan year we are, then pro-rate the
    // annual liquid growth to get today's expected liquid NW (the "pace").
    // This mirrors the Cohen Financial Planner's "Live Snapshot" calculation.
    const planYear = 2026;
    const yearStart = new Date(`${planYear}-01-01T00:00:00`);
    const yearEnd   = new Date(`${planYear + 1}-01-01T00:00:00`);
    const now       = new Date();
    const pctYear   = Math.min(1, Math.max(0,
      (now - yearStart) / (yearEnd - yearStart)
    ));
    const startingLiquid = P.startingLiquid ?? null;
    const growth2026     = P.planLiquidGrowth2026 ?? null;
    const planLiquidAtPace = startingLiquid != null && growth2026 != null
      ? Math.round(startingLiquid + growth2026 * pctYear)
      : null;

    res.json({
      available: true,
      startingLiquid,
      k401Start: P.k401Start ?? null,
      planLiquidGrowth2026: growth2026,
      planLiquidAtPace,
      pctYearElapsed: Math.round(pctYear * 100),
      planYear,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Asset allocation + single-name concentration for the dedicated Asset Mix card.
app.get('/api/wealth/allocation', async (req, res) => {
  try {
    const monarchWealth = require('./src/services/monarch-wealth');
    const { computeAllocationView } = require('./src/intelligence/allocation');
    const [accountsData, investments] = await Promise.all([
      monarchWealth.getAccounts(),
      monarchWealth.getInvestments().catch(() => null),
    ]);
    const view = computeAllocationView(accountsData, { holdings: investments?.holdings || null });
    if (!view) return res.json({ available: false });
    res.json({ available: true, ...view });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sources', async (req, res) => {
  try {
    res.json({ sources: await sourcesStore.listSources() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quick smoke-test for the work calendar free/busy integration.
// Returns the raw busy blocks for today — useful for verifying GOOGLE_WORK_CALENDAR_ID is correct.
app.get('/api/debug/work-calendar', async (req, res) => {
  try {
    const blocks = await fetchWorkBusyBlocks();
    res.json({ calendarId: process.env.GOOGLE_WORK_CALENDAR_ID || '(not set)', blocks, count: blocks.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic: full curation score breakdown for every finding in the last analyze
// MTD spending breakdown by category — diagnose discrepancies between NormOS
// totals and Monarch's own Cash Flow report.
//   GET /api/debug/mtd-spend
app.get('/api/debug/mtd-spend', async (req, res) => {
  try {
    const { query: dbQuery } = require('./src/db');
    const { isInternalTransfer, isFixedCategory } = require('./src/connectors/monarch');
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    // Pull all monarch transactions for this calendar month from docs table
    // Transaction-level breakdown from documents (same logic as MCP sync)
    const { rows } = await dbQuery(
      `SELECT metadata->>'category' AS category, (metadata->>'amount')::numeric AS amount,
              (metadata->>'date') AS date, metadata->>'merchant' AS merchant
         FROM documents
        WHERE source = 'monarch' AND domain = 'wealth'
          AND (metadata->>'date') >= $1
          AND (metadata->>'date') <= $2
        ORDER BY date DESC, amount ASC`,
      [monthStart.toISOString().slice(0, 10), now.toISOString().slice(0, 10)]
    );
    const byCategory = {};
    let totalIncluded = 0;
    let totalExcluded = 0;
    const excluded = [];
    for (const r of rows) {
      const amount = Number(r.amount);
      if (!Number.isFinite(amount) || amount >= 0) continue; // skip income / refunds
      const cat = r.category || 'Uncategorized';
      const spend = Math.abs(amount);
      if (isInternalTransfer(cat)) {
        totalExcluded += spend;
        excluded.push({ category: cat, amount: spend, date: r.date, merchant: r.merchant });
      } else {
        byCategory[cat] = (byCategory[cat] || 0) + spend;
        totalIncluded += spend;
      }
    }
    const categories = Object.entries(byCategory)
      .map(([category, total]) => ({ category, total: Math.round(total * 100) / 100, fixed: isFixedCategory(category) }))
      .sort((a, b) => b.total - a.total);

    // Also pull the stored metric total so we can compare the two
    const metricsStore = require('./src/store/metrics');
    const spendingRows = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending', from: monthStart, to: now, agg: 'sum', excludeSource: 'seed' });
    const metricTotal = spendingRows.reduce((s, r) => s + Number(r.value || 0), 0);

    res.json({
      monthStart: monthStart.toISOString().slice(0, 10),
      docBasedTotal: Math.round(totalIncluded * 100) / 100,
      metricBasedTotal: Math.round(metricTotal * 100) / 100,
      totalExcluded: Math.round(totalExcluded * 100) / 100,
      categories,
      excludedSample: excluded.slice(0, 20),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// pass — so production issues can be diagnosed from data rather than screenshots.
// Shows each finding's _score, _scoreParts, _signature, and which surface it lands on.
//   GET /api/debug/insights
app.get('/api/debug/insights', async (req, res) => {
  try {
    const { curate } = require('./src/intelligence/curate');
    const COMPOSITE_TYPES = ['recovery', 'sleep_debt', 'sleep_consistency', 'sleep_regularity', 'training_load'];

    const open = await findingsStore.listFindings({ status: 'open' });

    const composites = open.filter((f) => COMPOSITE_TYPES.includes(f.type));
    const crossContext = open.filter((f) => f.type === 'cross_context');
    const insightPool = open.filter(
      (f) => f.type !== 'leverage' && f.type !== 'forecast' && f.type !== 'cross_context' && !COMPOSITE_TYPES.includes(f.type)
    );

    // Full curate — annotates each finding with _score, _scoreParts, _signature.
    const ranked = await curate(insightPool);

    // Mirror the briefing's surface assignments exactly (same filters as /api/briefing).
    const top12 = ranked.slice(0, 12);
    const healthTop5 = ranked
      .filter((f) => Array.isArray(f.domains) && f.domains.includes('health'))
      .slice(0, 5);
    const habitFiltered = ranked.filter((f) => {
      if (f.type === 'habit_consistency') return true;
      const nonHealth = new Set(['habits', 'wellbeing']);
      return Array.isArray(f.domains) && f.domains.every((d) => nonHealth.has(d));
    });

    res.json({
      generatedAt: new Date().toISOString(),
      counts: {
        total: open.length,
        composites: composites.length,
        crossContext: crossContext.length,
        insightPool: insightPool.length,
        ranked: ranked.length,
      },
      // Full ranked pool with score breakdowns — the diagnostic core.
      rankedPool: ranked.map((f) => ({
        type: f.type,
        title: f.title,
        domains: f.domains,
        confidence: f.confidence,
        _signature: f._signature,
        _score: f._score,
        _scoreParts: f._scoreParts,
        evidence: f.evidence,
      })),
      // Which findings land on which surface, mirroring the briefing exactly.
      surfaces: {
        insights: top12.map((f) => ({ type: f.type, title: f.title, domains: f.domains, _score: f._score })),
        healthInsights: healthTop5.map((f) => ({ type: f.type, title: f.title, domains: f.domains, _score: f._score })),
        habitTrends: habitFiltered.map((f) => ({ type: f.type, title: f.title, domains: f.domains, _score: f._score })),
      },
      composites: composites.map((f) => ({ type: f.type, title: f.title, detail: f.detail })),
      crossContext: crossContext.map((f) => ({ title: f.title, confidence: f.confidence, domains: f.domains })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lightweight Monarch MCP health check — confirms the integration is configured
// and the refresh-token → access-token exchange works, WITHOUT dumping any
// financial data.
app.get('/api/debug/monarch-mcp', async (req, res) => {
  try {
    const monarchMcp = require('./src/services/monarch-mcp');
    if (!monarchMcp.isConfigured()) {
      return res.json({ configured: false, hint: 'Set MONARCH_MCP_REFRESH_TOKEN and MONARCH_MCP_CLIENT_ID' });
    }
    await monarchMcp.getAccessToken(); // throws if the refresh token is bad
    res.json({ configured: true, tokenOk: true });
  } catch (err) {
    res.status(500).json({ configured: true, tokenOk: false, error: err.response?.data || err.message });
  }
});

// TEMPORARY raw Monarch MCP JSON-RPC probe (NO LLM) — used to inspect tool output
// shapes while building the wealth features. Remove once the mappers are built.
// Mid-day partial refresh: markets + urgent-email scan + weather/calendar.
// Everything else (wisdom, insights, recovery framing, weekly review) is
// morning-built and day-locked. Merges into the cached briefing and re-saves.
app.get('/api/briefing/live', async (req, res) => {
  try {
    const prior = await briefingsStore.latestBriefing('daily');
    if (!prior?.content) {
      return res.status(409).json({ error: 'no briefing built yet — load the briefing first' });
    }

    const EXT = Number(process.env.BRIEFING_SOURCE_TIMEOUT_MS || 12000);
    const [emailResult, marketsResult, weatherResult, calendarResult, workBusyResult] = await Promise.allSettled([
      withTimeout(fetchGmailThreads(), EXT, 'gmail'),
      withTimeout(fetchMarkets(), EXT * 3, 'markets'), // includes its own small LLM brief
      withTimeout(fetchWeather(), EXT, 'weather'),
      withTimeout(fetchCalendarEvents(), EXT, 'calendar'),
      withTimeout(fetchWorkBusyBlocks(), EXT, 'workCalendar'),
    ]);
    const emails = emailResult.status === 'fulfilled' ? (emailResult.value ?? []) : [];
    const markets = marketsResult.status === 'fulfilled' ? marketsResult.value : null;
    const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : null;
    const calendar = calendarResult.status === 'fulfilled' ? calendarResult.value : null;
    const workBusy = workBusyResult.status === 'fulfilled' ? workBusyResult.value : null;

    let emailBriefs = null;
    if (emails.length) {
      emailBriefs = await withTimeout(
        generateEmailBriefs(emails),
        Number(process.env.BRIEFING_LLM_TIMEOUT_MS || 90000),
        'email-briefs'
      ).catch((err) => {
        console.error('[briefing live] email briefs failed:', err.message);
        return null;
      });
    }

    const content = {
      ...prior.content,
      ...(markets ? { markets } : {}),
      ...(weather ? { weather } : {}),
      ...(calendar ? { calendar } : {}),
      ...(workBusy ? { workBusy } : {}),
      ...(emailBriefs ? { urgentEmails: emailBriefs.urgentEmails } : {}),
      liveRefreshedAt: new Date().toISOString(),
    };

    briefingsStore
      .saveBriefing({ kind: 'daily', content })
      .catch((err) => console.error('[briefing live] save failed:', err.message));

    res.json({ ...content, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Markets-only refresh — fetches fresh RSS stories + LLM brief, merges into the
// cached briefing, and returns just the new markets object. ~15-30s. Use this
// at end of day for an EOD market summary without triggering a full rebuild.
app.post('/api/briefing/markets', async (req, res) => {
  try {
    const prior = await briefingsStore.latestBriefing('daily');
    if (!prior?.content) {
      return res.status(409).json({ error: 'no briefing built yet — load the briefing first' });
    }

    const EXT = Number(process.env.BRIEFING_SOURCE_TIMEOUT_MS || 12000);
    const markets = await withTimeout(fetchMarkets(), EXT * 3, 'markets').catch((err) => {
      console.error('[briefing markets] fetch failed:', err.message);
      return null;
    });

    if (!markets) {
      return res.status(503).json({ error: 'markets fetch failed — check feeds or try again' });
    }

    const content = { ...prior.content, markets };
    briefingsStore
      .saveBriefing({ kind: 'daily', content })
      .catch((err) => console.error('[briefing markets] save failed:', err.message));

    res.json({ markets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Non-blocking briefing rebuild trigger. Railway's proxy terminates HTTP connections
// around 60s, but a full briefing build (LLM + external sources) takes 60–90s, so
// every "Rebuild" button tap that waits inline gets killed mid-flight and the client
// silently stays on stale data.
//
// This endpoint returns immediately (<1s), then fires the rebuild as a loopback
// HTTP request to localhost — bypassing the Railway proxy entirely. The rebuild
// saves its result to the DB when it finishes. The client polls GET /api/briefing
// (cache mode) every 8s until builtAt advances past the trigger time.
let _rebuildInFlight = false;
app.post('/api/briefing/rebuild', (req, res) => {
  const triggeredAt = new Date().toISOString();
  if (_rebuildInFlight) {
    return res.json({ started: false, alreadyRunning: true, triggeredAt });
  }
  _rebuildInFlight = true;
  res.json({ started: true, triggeredAt });

  const http = require('http');
  const token = process.env.NORMOS_API_TOKEN || '';
  const r = http.request(
    {
      hostname: 'localhost',
      port: PORT,
      path: '/api/briefing?refresh=1',
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
    (resp) => {
      resp.resume(); // drain response body to free the socket
      resp.on('end', () => { _rebuildInFlight = false; });
    }
  );
  r.on('error', (err) => {
    console.error('[bg rebuild] loopback failed:', err.message);
    _rebuildInFlight = false;
  });
  r.setTimeout(200000, () => { r.destroy(); _rebuildInFlight = false; });
  r.end();
});

app.get('/api/briefing', async (req, res) => {
  const errors = [];

  // Serve a cached briefing instantly unless ?refresh=1. Building fresh calls
  // the LLM + weather/calendar/Notion/markets/embeddings (~60-90s), so we always
  // serve the last build immediately. The scheduler pre-builds at 8:30am so the
  // cache is warm. Pull-to-refresh serves cache instantly; the explicit per-tab
  // "Rebuild" button sends ?refresh=1 to force a new build.
  //
  // We never auto-rebuild on non-forced requests — doing so caused a silent
  // failure loop: the 60-90s build exceeded the client's 45s timeout, the request
  // was aborted, and the app got stuck on yesterday's data with no visible error.
  const CACHE_TTL_MIN = Number(process.env.BRIEFING_CACHE_MIN || 180); // stale threshold
  const tz = process.env.TZ || 'America/New_York';
  const force = req.query.refresh === '1' || req.query.refresh === 'true';

  // The most recent prior build, and whether it was built earlier *today* (in the
  // user's timezone). Used for the daily-lock: the "wisdom" content (library
  // highlight, daily quote, Notion page + the Gemini insights on them) is chosen
  // on the first build of the day and then carried over on every later build so
  // it stays static until midnight. Dynamic data (weather, markets, calendar,
  // email, findings) still refreshes every build.
  let prior = null;
  let priorIsToday = false;
  try {
    prior = await briefingsStore.latestBriefing('daily');
    if (prior?.generated_at) {
      const localDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
      priorIsToday = localDate(prior.generated_at) === localDate(new Date());
    }
  } catch (err) {
    console.error('[briefing prior] read failed:', err.message);
  }

  if (!force && prior?.content) {
    const ageMin = prior.generated_at
      ? (Date.now() - new Date(prior.generated_at).getTime()) / 60000
      : 0;
    const isStale = ageMin >= CACHE_TTL_MIN;
    // Refresh the cheap, fast-changing weekly-goal state even on a cached serve.
    // The "Goals hit" tile and the goal checkboxes read this; without the live
    // refresh, checking off a goal wouldn't move the count until the next full
    // (60-90s LLM) rebuild — making the checkboxes feel broken.
    let weeklyGoals = prior.content.weeklyGoals ?? null;
    try {
      const [currentInt, priorInt] = await Promise.all([
        intentionsStore.currentIntention(),
        intentionsStore.priorIntention(),
      ]);
      if (currentInt || priorInt) weeklyGoals = { current: currentInt ?? null, prior: priorInt ?? null };
    } catch (err) {
      console.error('[briefing cache] weeklyGoals refresh failed:', err.message);
    }
    // Apply insight dismissals live too, so dismissing a card sticks on the next
    // instant cache reload rather than waiting for a full rebuild.
    const cachedContent = { ...prior.content };
    try {
      const dismissedInsights = require('./src/store/dismissedInsights');
      const dismissed = await dismissedInsights.dismissedKeys();
      for (const k of ['insights', 'wealthInsights', 'healthInsights', 'crossContextInsights']) {
        if (Array.isArray(cachedContent[k])) cachedContent[k] = dismissedInsights.applyDismissals(cachedContent[k], dismissed);
      }
    } catch (err) {
      console.error('[briefing cache] dismissals failed:', err.message);
    }
    // Re-check live recovery on every cache serve. If Eight Sleep data is stale
    // (device away), clear recovery-derived fields so neither the Health tab's
    // RecoveryCard nor the Today tab's TodayForecastCard show stale green data.
    try {
      const freshRecovery = await require('./src/intelligence/recovery').liveRecovery();
      cachedContent.recovery = freshRecovery ?? null;
      if (!freshRecovery) {
        // todayForecast capacity is recovery-driven; without fresh data it should be null.
        // healthComposites may include a stale recovery composite — suppress them too.
        cachedContent.todayForecast = { capacity: null, sleepDebt: cachedContent.todayForecast?.sleepDebt ?? null };
        if (Array.isArray(cachedContent.healthComposites)) {
          cachedContent.healthComposites = cachedContent.healthComposites.filter(
            (c) => c?.type !== 'recovery'
          );
        }
      }
    } catch { /* non-critical — leave cached value on error */ }

    // Re-fetch weekly review on every cache serve so the parsed/recovered version
    // always shows — the stored briefing may have the raw-JSON-as-narrative fallback.
    let weeklyReview = cachedContent.weeklyReview ?? null;
    try {
      const wr = await briefingsStore.latestBriefing('weekly');
      if (wr) {
        const contentObj = wr.content;
        // 'Weekly review' is the exact fallback headline set when extractJson fails
        // at generation time. A real review always has a specific punchy headline.
        // Suppress the broken record so the card hides rather than rendering raw JSON.
        if (contentObj?.headline !== 'Weekly review') {
          weeklyReview = { ...contentObj, generatedAt: wr.generated_at };
        }
      }
    } catch (err) {
      console.error('[briefing cache] weeklyReview refresh failed:', err.message);
    }
    // Always serve the cache — never block the client on a 60-90s rebuild.
    // `stale: true` signals the app to show a "Rebuild briefing" button.
    return res.json({ ...cachedContent, weeklyGoals, weeklyReview, cached: true, stale: isStale, cachedAgeMin: Math.round(ageMin) });
  }

  // Format today's date label
  const now = new Date();
  const dateLabel = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });

  // Refresh the DERIVED intelligence from the CURRENT metrics before building the
  // brief, so every surface reads the same live data. The brief pulls the stored
  // self-model (7-day averages) and stored findings; without this refresh a
  // "Rebuild briefing" just re-ran the LLM over last night's nightly self-model
  // and the last analyze pass — so corrected metrics (e.g. fixed step totals)
  // never reached the brief or Insights until the 9:30pm scheduler ran. analyze()
  // is pure stats and consolidate() is DB queries + string building (no LLM), so
  // this adds ~a few seconds to the already-60-90s build. Best-effort: a failure
  // here must not block the briefing.
  // A forced/manual rebuild ("Rebuild briefing" tap) should reflect whatever Eight
  // Sleep has posted RIGHT NOW — don't depend on the background scheduler having
  // already polled (it only starts at a fixed floor and gates the AUTOMATIC brief
  // on a separate wake buffer; neither should block an explicit user request).
  // Best-effort: a failed/absent connector must not block the briefing.
  try {
    await runIngest({ only: 'eight_sleep_api' });
  } catch (err) {
    console.error('[briefing force] eight-sleep pull failed:', err.message);
  }

  try {
    await analyze();
    // Cross-context insights depend on fresh correlation findings — regenerate
    // immediately so the brief reflects current data, not last night's pass.
    await require('./src/intelligence/crossContext').generateCrossContext();
    await require('./src/intelligence/consolidate').consolidate({ kind: 'briefing' });
  } catch (err) {
    console.error('[briefing build] intelligence refresh failed:', err.message);
  }

  // Workout is synchronous — no failure path
  const workout = getTodayWorkout();

  // Notion wisdom page: avoid repeating one shown in the last 30 days.
  const seenNotion = await surfacedStore.recentRefs('notion_page', 30).catch(() => new Set());

  // Fetch all independent data sources in parallel. Each is bounded by a hard
  // timeout so one slow upstream (Gmail/Notion/etc.) can't hang the whole
  // briefing — allSettled waits for every promise, so without this a single
  // stall blocks the response. A timed-out source just shows as a soft error.
  //
  // Gmail is skipped on same-day rebuilds (priorIsToday) — urgent emails don't
  // change frequently enough to re-scan on every intraday rebuild. The prior
  // build's urgentEmails are carried over. /api/briefing/live handles mid-day email refresh.
  const EXT = Number(process.env.BRIEFING_SOURCE_TIMEOUT_MS || 12000);
  const [weatherResult, calendarResult, workBusyResult, notionResult, quoteResult, emailResult, marketsResult] =
    await Promise.allSettled([
      withTimeout(fetchWeather(), EXT, 'weather'),
      withTimeout(fetchCalendarEvents(), EXT, 'calendar'),
      withTimeout(fetchWorkBusyBlocks(), EXT, 'workCalendar'),
      // Wisdom page is day-locked: skip the Notion API on same-day rebuilds so
      // we don't burn credits for a page that will be discarded by lockedNotion.
      priorIsToday && prior?.content?.notionText
        ? Promise.resolve({ text: prior.content.notionText, pageTitle: prior.content.notionPageTitle ?? 'Notion' })
        : withTimeout(fetchRandomNotionPage({ exclude: [...seenNotion] }), EXT, 'notion'),
      withTimeout(fetchRandomQuote(), EXT, 'googleDoc'),
      Promise.resolve([]), // email context removed — not cost-effective for daily briefing
      withTimeout(fetchMarkets(), EXT, 'markets'),
    ]);

  function unwrap(result, name) {
    if (result.status === 'fulfilled') return result.value;
    console.error(`[${name}] failed:`, result.reason?.message || result.reason);
    errors.push({ service: name, error: result.reason?.message || String(result.reason) });
    return null;
  }

  const weather = unwrap(weatherResult, 'weather');
  const calendar = unwrap(calendarResult, 'calendar') ?? [];
  const workBusy = unwrap(workBusyResult, 'workCalendar') ?? [];
  const notionData = unwrap(notionResult, 'notion') ?? { text: '', pageTitle: 'Notion' };
  // Mark this Notion page as shown so it won't repeat for 30 days — but ONLY when
  // we're actually serving a fresh pick today. If an earlier build already locked
  // today's wisdom, this fresh fetch gets discarded by the day-lock below, so
  // recording it would silently burn the no-repeat pool on every refresh.
  if (!priorIsToday && notionData.pageTitle && notionData.pageTitle !== 'Notion') {
    surfacedStore.record('notion_page', notionData.pageTitle).catch(() => {});
  }
  const quoteData = unwrap(quoteResult, 'googleDoc') ?? { quote: '' };
  const emails = unwrap(emailResult, 'gmail') ?? [];
  const markets = unwrap(marketsResult, 'markets');

  // Quote of the day from the Notion "Quotes" page (each bullet = one quote).
  // No-repeat for 30 days so it cycles through all your quotes.
  // Day-locked: skip the Notion API on same-day rebuilds — the quote is already
  // chosen and will be carried forward by keep(p?.dailyQuote, ...) below.
  let dailyQuote = priorIsToday ? (prior?.content?.dailyQuote ?? null) : null;
  if (!priorIsToday) {
    try {
      const quotes = await withTimeout(fetchNotionQuotes(), EXT, 'notionQuotes');
      if (quotes.length) {
        const seen = await surfacedStore.recentRefs('daily_quote', 30);
        const [pick] = surfacedStore.pickFresh(
          quotes.map((q) => q).sort(() => Math.random() - 0.5),
          seen,
          { max: 1, keyFn: (q) => q }
        );
        if (pick) {
          dailyQuote = pick;
          await surfacedStore.record('daily_quote', pick);
        }
      }
    } catch (err) {
      console.error('[notionQuotes] failed:', err.message);
    }
  }

  // Wellbeing context: recent inner-state signals (mood/energy/focus + lagging
  // habits) so the quote/Notion commentary can tailor to how you're actually
  // doing — without referencing calendar specifics or your profession.
  let wellbeingContext = '';
  let wellbeingTheme = ''; // search phrase for the "From Your Library" highlight
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const avg = async (domain, metric) => {
      const r = await metricsStore.dailyAggregate({ domain, metric, from: since, agg: 'avg' });
      const vals = r.map((x) => Number(x.value)).filter(Number.isFinite);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const [mood, energy, focus] = await Promise.all([
      avg('wellbeing', 'mood'), avg('wellbeing', 'energy'), avg('wellbeing', 'focus'),
    ]);
    // Habits trailing completion (which ones are slipping). The five binary
    // habits are 0/1 (flag <60% adherence); eat_healthy is a 1–5 score, so it
    // needs its own threshold (flag when averaging below ~3/5) — checking it
    // against 0.6 like the binaries meant it could never flag.
    const binaryHabits = ['gratitude', 'morning_tm', 'afternoon_tm', 'cold_shower', 'exercise'];
    const habitLabels = { gratitude: 'gratitude', morning_tm: 'morning meditation', afternoon_tm: 'afternoon meditation', cold_shower: 'cold shower', exercise: 'exercise', eat_healthy: 'eating well' };
    const lagging = [];
    for (const m of binaryHabits) {
      const a = await avg('habits', m);
      if (a != null && a < 0.6) lagging.push(habitLabels[m]); // <60% adherence
    }
    const eatAvg = await avg('habits', 'eat_healthy');
    if (eatAvg != null && eatAvg < 3) lagging.push(habitLabels.eat_healthy); // below ~3/5
    const parts = [];
    const themes = [];
    const lowHL = (v) => (v <= 2.5 ? 'low' : v >= 4 ? 'strong' : 'moderate');
    if (mood != null) { parts.push(`mood ${lowHL(mood)}`); if (mood <= 2.5) themes.push('contentment, perspective, equanimity'); }
    if (energy != null) { parts.push(`energy ${lowHL(energy)}`); if (energy <= 2.5) themes.push('rest, restoration, sustainable effort'); }
    if (focus != null) { parts.push(`focus ${lowHL(focus)}`); if (focus <= 2.5) themes.push('presence, deep work, single-tasking, attention'); }
    // Lagging habits steer the theme toward their virtue.
    const habitThemes = { gratitude: 'gratitude, appreciation', 'morning meditation': 'stillness, mindfulness', 'afternoon meditation': 'stillness, mindfulness', exercise: 'discipline, vitality, the body', 'eating well': 'discipline, nourishment, moderation' };
    for (const l of lagging) if (habitThemes[l]) themes.push(habitThemes[l]);
    if (lagging.length) parts.push(`slipping on ${lagging.slice(0, 3).join(', ')}`);
    wellbeingContext = parts.join('; ');
    // If nothing is low/slipping, theme stays empty -> falls back to quote/evergreen.
    wellbeingTheme = themes.slice(0, 3).join('; ');
  } catch (err) {
    console.error('[wellbeingContext] failed:', err.message);
    errors.push({ service: 'wellbeing_context', error: err.message });
  }

  // Active life-context annotations (travel, illness, deadline, etc.) so the
  // AI can acknowledge them in the briefing. Only today's annotations — stale
  // context from prior days clears at midnight so it can't bleed into a new day.
  let annotationsContext = '';
  try {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const active = await annotationsStore.overlapping(startOfToday, new Date());
    if (active.length) {
      annotationsContext = active
        .map((a) => {
          // Include the submission date so the AI can resolve relative terms like
          // "tomorrow" or "today" in notes entered the night before.
          const submitted = a.start_ts
            ? new Date(a.start_ts).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' })
            : null;
          const dateTag = submitted ? `[${submitted}] ` : '';
          return `${dateTag}${a.label}${a.note ? ` (${a.note})` : ''}`;
        })
        .slice(0, 5)
        .join('; ');
    }
  } catch (err) {
    console.error('[annotations] failed:', err.message);
  }

  // Recovery context for the briefing prompt — computed early so the chief-of-staff
  // morning focus can reference the actual score and HRV. Stored in `recovery` so
  // the later section can skip a redundant liveRecovery() call.
  let recovery = null;
  let recoveryContext = '';
  try {
    recovery = await require('./src/intelligence/recovery').liveRecovery();
    if (recovery?.score != null) {
      recoveryContext = `score ${recovery.score}/100 (${recovery.band ?? 'unknown'} band)`;
      // rawHrv/rawRhr are actual measurements (ms / bpm), not the 0-100 score components.
      if (recovery.rawHrv != null) recoveryContext += `, HRV ${Math.round(recovery.rawHrv)}ms`;
      if (recovery.rawRhr != null) recoveryContext += `, RHR ${Math.round(recovery.rawRhr)}bpm`;
    } else {
      // No fresh Eight Sleep data (device away or not worn). Explicitly flag this
      // so the LLM doesn't cite stale HRV/recovery numbers from trend findings or the self-model.
      recoveryContext = 'UNAVAILABLE — Eight Sleep device not worn recently. Do NOT reference HRV, resting heart rate, or recovery score in today\'s brief.';
    }
  } catch (err) {
    console.error('[recovery context] failed:', err.message);
    errors.push({ service: 'recovery_context', error: err.message });
  }

  // Pre-brief signals: detect anomalies and generate targeted questions for the
  // mobile app to show before the user reads the brief. Answers come back as
  // annotations via POST /api/briefing/context, which flow into annotationsContext
  // automatically on the next build — no extra prompt plumbing needed.
  let signals = [];
  let spendingContext = ''; // a discretionary-spend anomaly the brief can call out
  try {
    const preBriefSignals = require('./src/intelligence/pre-brief-signals');
    let recentSpend = null;
    let spendBaseline = null;
    try {
      const tz = process.env.TZ || 'America/New_York';
      // Use yesterday's completed data — today's Monarch sync only ran this morning
      // and may be incomplete or attribute yesterday's settled transactions to today.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yestDate = yesterday.toLocaleDateString('en-CA', { timeZone: tz });
      const yestFrom = new Date(`${yestDate}T00:00:00Z`);
      const yestTo = new Date(yestFrom.getTime() + 24 * 60 * 60 * 1000);
      const baselineFrom = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      const [yestRows, baselineRows] = await Promise.all([
        metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending_discretionary', from: yestFrom, to: yestTo, agg: 'sum', excludeSource: 'seed' }),
        metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending_discretionary', from: baselineFrom, to: yestFrom, agg: 'sum', excludeSource: 'seed' }),
      ]);
      const yestTotal = yestRows.reduce((s, r) => s + Number(r.value || 0), 0);
      if (yestTotal > 0) recentSpend = yestTotal;
      if (baselineRows.length >= 7) {
        spendBaseline = baselineRows.reduce((s, r) => s + Number(r.value || 0), 0) / baselineRows.length;
      }
    } catch { /* non-critical */ }
    // Anomaly callout for the brief narrative (distinct from the user-facing
    // question): flag yesterday's discretionary spend when it's well above normal.
    if (recentSpend != null && spendBaseline != null && spendBaseline > 10 && recentSpend > spendBaseline * 1.8) {
      const mult = (recentSpend / spendBaseline).toFixed(1);
      spendingContext = `Discretionary spending yesterday was $${Math.round(recentSpend)} vs a $${Math.round(spendBaseline)}/day average (${mult}× normal).`;
    }
    const allSignals = preBriefSignals.buildSignals({
      recovery, calendar, workBusy, spend: recentSpend, spendBaseline,
    });
    signals = preBriefSignals.selectQuestions(allSignals, 2);
  } catch (err) {
    console.error('[pre-brief-signals] failed:', err.message);
  }

  // Experiments feature is paused — hidden from UI until the data quality is
  // high enough to surface meaningful hypotheses. Backend logic is intact.
  const experimentsContext = '';
  const completedExps = [];
  const runningExps = [];

  // Self-model: nightly-consolidated portrait of the user — injected into the
  // briefing prompt so the chief-of-staff voice knows who it's talking to.
  let selfModel = '';
  try {
    selfModel = (await require('./src/store/selfModel').latestModelText()) ?? '';
    // The daily brief shouldn't surface net worth (it's noise day-to-day and the
    // LLM kept forcing nonsensical "net worth tied to your work" ties). Strip the
    // net-worth figure from the WEALTH line for the brief only — keep MTD spending
    // so genuine spending insights still flow. The full model keeps net worth for
    // other surfaces (Ask, wealth tab).
    selfModel = selfModel.replace(/^WEALTH:.*$/m, (line) => {
      const spend = line.match(/MTD spending \$[\d,]+/);
      return spend ? `WEALTH: ${spend[0]}` : '';
    });
  } catch (err) {
    console.error('[selfModel] failed:', err.message);
  }

  // Pipeline health: inject a data-gap warning into annotationsContext when a
  // critical connector hasn't synced recently. The LLM sees this and caveats
  // stale-data claims; avoids confidently citing week-old numbers.
  const STALE_THRESHOLDS_H = {
    eight_sleep_api:  { hours: 26, label: 'recovery/sleep metrics' },
    monarch_mcp_sync: { hours: 26, label: 'wealth/spending data' },
    monarch:          { hours: 48, label: 'wealth data' },
    health:           { hours: 6,  label: 'activity/steps' },
  };
  try {
    const allSources = await sourcesStore.listSources();
    const gaps = [];
    for (const s of allSources) {
      const thresh = STALE_THRESHOLDS_H[s.id];
      if (!thresh || !s.last_sync_at) continue;
      const hoursAgo = (Date.now() - new Date(s.last_sync_at).getTime()) / 3_600_000;
      if (hoursAgo > thresh.hours) {
        gaps.push(`${s.display_name || s.id} (${thresh.label}, last synced ${Math.round(hoursAgo)}h ago)`);
      }
    }
    if (gaps.length) {
      const warning = `DATA GAPS — these sources have not synced recently: ${gaps.join('; ')}. Caveat any claims that rely on this data.`;
      annotationsContext = annotationsContext ? `${annotationsContext}; ${warning}` : warning;
    }
  } catch (err) {
    console.error('[pipeline health] failed:', err.message);
  }

  // Leverage + risk context for the Chief-of-Staff brief. THE ACTION comes from
  // the leverage engine; THE RISK from the most at-risk forecast. Fetched before
  // the LLM call so the brief can name them. (The same findings are re-read later
  // for the card sections — a cheap duplicate read that avoids reordering the
  // larger findings/recovery block below.)
  const openFindingsForBrief = await findingsStore.listFindings({ status: 'open' }).catch(() => []);

  // Continuity context: without this, the chief-of-staff brief has zero memory
  // across days — no awareness of what it already said, what it told the user to
  // do, or whether its own predictions held up. Bundles four "does this feel like
  // it knows me" signals: (1) how long the leading finding has actually been
  // open, so a stretch of days on the same issue reads as "day 4 of this" instead
  // of a fresh explainer every morning; (2) the last suggested action's outcome,
  // for real follow-up instead of only ever proposing something new; (3) whether
  // yesterday's tomorrow-forecast actually held, for honest self-grading; (4) the
  // last few days' raw brief text, so repeated PHRASING is visible even when the
  // underlying topic isn't formally tracked as a finding.
  let continuityContext = '';
  try {
    const NARRATABLE = new Set(['trend', 'anomaly', 'habit_split', 'sleep_impact', 'activity_impact', 'correlation', 'daytime_cardio']);
    const curateLib = require('./src/intelligence/curate');
    const candidates = openFindingsForBrief.filter((f) => NARRATABLE.has(f.type));
    const sigs = candidates.map(curateLib.signature);
    const firstSeenBySig = await curateLib.recordAndLoadFirstSeen(sigs).catch(() => new Map());
    const now = Date.now();
    const streaks = candidates
      .map((f) => {
        const first = firstSeenBySig.get(curateLib.signature(f));
        const days = first ? Math.floor((now - new Date(first).getTime()) / 864e5) : 0;
        return { f, days };
      })
      .filter((x) => x.days >= 3)
      .sort((a, b) => b.days - a.days)
      .slice(0, 4)
      .map((x) => `- ${x.f.title} — open ${x.days} days running (this isn't new; if it's today's lead, name the streak and escalate rather than re-explaining it)`);

    const openers = await briefingsStore.recentDailyBriefOpeners(3).catch(() => []);
    const openerLines = openers.map((o) =>
      `- ${o.day}: "${o.synthesis || ''}" | action: "${o.action || ''}"`
    );

    // Closed-loop accountability: a real chief of staff follows up on what they
    // told you to do, not just picks a fresh action every morning. Reuses the
    // recommendation ledger's own outcome tracking (thumbs, or auto-measured once
    // ~a week of data exists) so the brief can say "yesterday I said X — here's
    // what happened" instead of only ever suggesting something new.
    let lastActionLine = null;
    try {
      const todayLocalDateStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
      const startOfTodayUtc = new Date(naiveToUtcIso(`${todayLocalDateStr}T00:00:00`, tz));
      const lastAction = await recommendationsStore.mostRecentLeverageAction(startOfTodayUtc);
      if (lastAction) {
        const daysAgo = Math.floor((Date.now() - new Date(lastAction.created_at).getTime()) / 864e5);
        if (daysAgo <= 7) {
          const thumbed = lastAction.outcome_measured_at != null && Math.abs(Number(lastAction.outcome_delta)) === 1;
          const dir = lastAction.expected_direction;
          const delta = lastAction.outcome_delta != null ? Number(lastAction.outcome_delta) : null;
          const hit = delta != null && (dir === 'down' ? delta < 0 : delta > 0);
          const status = thumbed
            ? (hit ? 'they gave it 👍 — marked it helped' : 'they gave it 👎 — marked it did not help')
            : lastAction.outcome_measured_at != null
              ? (delta == null ? 'no data to judge it yet' : hit ? "their data shows it worked" : 'their data shows no effect')
              : 'outcome still being measured automatically from their data (takes about a week) — the user owes NOTHING here; never ask for feedback or count days waiting';
          const whenStr = daysAgo === 0 ? 'earlier today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;
          lastActionLine = `LAST ACTION SUGGESTED (${whenStr}): "${lastAction.title}" — ${status}.`;
        }
      }
    } catch (err) {
      console.error('[last action] failed:', err.message);
    }

    // Explicit calibration: compare YESTERDAY's tomorrow-forecast against TODAY's
    // actual recovery. Only surfaced on a genuine miss (or a low-confidence call
    // that happened to land) — a correct routine call isn't news and forcing a
    // "yesterday I predicted X" ritual into every brief would just become another
    // rote pattern. The credibility payoff specifically comes from owning misses.
    let calibrationLine = null;
    try {
      const yesterday = openers[0] ?? null;
      const fc = yesterday?.tomorrowForecast;
      if (fc && recovery?.score != null && recovery?.band) {
        const missed = fc.band !== recovery.band;
        const lowConfHit = !missed && fc.confidence != null && fc.confidence < 60;
        if (missed || lowConfHit) {
          calibrationLine = `CALIBRATION CHECK: yesterday's forecast leaned ${fc.band} (~${fc.projectedScore}/100, ${fc.confidence}% confidence) for today; today actually came in ${recovery.band} at ${recovery.score}/100. ${missed ? 'That is a miss — if recovery is part of today\'s synthesis or risk, briefly own the earlier call rather than ignoring it (admitting a miss builds more trust than always sounding certain).' : 'The low-confidence call happened to hold — a brief, light callback is fine if relevant, not a big deal either way.'}`;
        }
      }
    } catch (err) {
      console.error('[calibration] failed:', err.message);
    }

    // Multi-day training periodization: look at the REST of the week's scheduled
    // sessions (not just today), so back-to-back hard days can be flagged before
    // they stack — a real coach plans the week, not just today. Deliberately rare:
    // only fires when training load is already elevated AND hard days cluster, so
    // it doesn't become a standing weekly notice about a schedule that's fixed.
    let periodizationLine = null;
    try {
      const acwrFinding = openFindingsForBrief.find((f) => f.type === 'training_load');
      const acwrBand = acwrFinding?.evidence?.band ?? null;
      const upcoming = require('./src/services/workout').getUpcomingWorkouts(3);
      periodizationLine = require('./src/intelligence/periodization').computePeriodizationNote({ upcoming, acwrBand });
    } catch (err) {
      console.error('[periodization] failed:', err.message);
    }

    const parts = [];
    if (streaks.length) parts.push(`PERSISTENT ISSUES (from the novelty ledger):\n${streaks.join('\n')}`);
    if (lastActionLine) parts.push(lastActionLine);
    if (calibrationLine) parts.push(calibrationLine);
    if (periodizationLine) parts.push(`WEEK-AHEAD PERIODIZATION: ${periodizationLine}`);
    if (openerLines.length) parts.push(`YOUR LAST ${openerLines.length} MORNING BRIEFS (do not reuse this phrasing or structure — if the same topic is genuinely still the lead, change the angle, escalate, or ask a pointed question instead of restating the setup):\n${openerLines.join('\n')}`);
    continuityContext = parts.join('\n\n');
  } catch (err) {
    console.error('[continuity context] failed:', err.message);
  }

  let leverageContext = '';
  try {
    const open = openFindingsForBrief;
    const levFindings = open
      .filter((f) => f.type === 'leverage')
      .sort((a, b) => (a.evidence?.rank ?? 99) - (b.evidence?.rank ?? 99))
      .slice(0, 3);
    const lev = levFindings.map((f, i) => `${i + 1}. ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
    const risks = open
      .filter((f) => f.type === 'forecast' && (f.evidence?.status === 'off_track' || f.evidence?.status === 'at_risk'))
      .sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1))
      .slice(0, 2)
      .map((f) => `- ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
    const parts = [];
    if (lev.length) parts.push(`HIGHEST-LEVERAGE ACTIONS (leverage engine):\n${lev.join('\n')}`);
    if (risks.length) parts.push(`TRENDING WRONG (at-risk forecasts):\n${risks.join('\n')}`);
    leverageContext = parts.join('\n\n');

    // Log leverage actions to the recommendation ledger (fire-and-forget).
    // Deduplicated over a 7-day window by NUMBER-NORMALIZED title, so minor
    // percentage variations like "→ 13% better HRV" vs "→ 12% better HRV" (the
    // number sits mid-title, where a prefix match missed it) collapse to one
    // recommendation. A per-run guard also blocks two findings that normalize the
    // same from both landing in a single briefing.
    if (levFindings.length) {
      recommendationsStore.recentTitles(7).then((recent) => {
        const recentNorm = new Set([...recent].map(recommendationsStore.normalizeRecTitle));
        const seenThisRun = new Set();
        for (const f of levFindings) {
          const normKey = recommendationsStore.normalizeRecTitle(f.title);
          if (recentNorm.has(normKey) || seenThisRun.has(normKey)) continue;
          seenThisRun.add(normKey);
          const ev = f.evidence || {};
          recommendationsStore.recordRecommendation({
            type: 'leverage',
            findingId: f.id ?? null,
            title: f.title,
            detail: f.detail ?? null,
            lever: ev.basis?.lever ?? null,
            outcomeMetric: ev.basis?.outcome ?? null,
            expectedDirection: ev.basis?.r != null ? (ev.basis.r >= 0 ? 'up' : 'down') : null,
            score: ev.score ?? null,
            surfacedIn: 'briefing',
          }).catch((e) => console.error('[recommendations] log failed:', e.message));
        }
      }).catch((e) => console.error('[recommendations] dedup check failed:', e.message));
    }
  } catch (err) {
    console.error('[leverage context] failed:', err.message);
  }

  // Dedup the Notion wisdom at the QUOTE level (not just the page): list the
  // quotes shown in the last 30 days so the LLM picks a different passage, even
  // when the same page recurs or a page has one standout line.
  const seenNotionQuotes = await surfacedStore.recentRefs('notion_quote', 30).catch(() => new Set());
  const notionTextForBrief = seenNotionQuotes.size
    ? `${notionData.text}\n\n[ALREADY SHOWN in the last 30 days — do NOT select any of these; choose a DIFFERENT passage (return empty string if the page has nothing else worthwhile):\n${[...seenNotionQuotes].slice(0, 60).map((q) => `- ${q}`).join('\n')}]`
    : notionData.text;

  // Strength progression nugget — the biggest recent estimated-1RM gain across
  // logged lifts, so the chief-of-staff can call out training wins.
  let strengthContext = '';
  try {
    strengthContext = (await require('./src/intelligence/strength-progression')
      .topProgressionNote({ days: 45, minSessions: 3 })) || '';
  } catch { /* non-critical */ }

  // Forward-looking cashflow: unlike the spending-anomaly check above (which
  // reports on what already happened), this looks at Monarch's recurring-bill
  // forecast for what's ABOUT to hit, so the brief can warn before the balance
  // drops rather than after. Best-effort and bounded — Monarch's MCP round-trip
  // must never hold up the rest of the briefing.
  let cashflowContext = '';
  try {
    const monarchWealth = require('./src/services/monarch-wealth');
    if (monarchWealth.isConfigured()) {
      const [recurring, accountsData] = await Promise.all([
        withTimeout(monarchWealth.getRecurring(), EXT, 'monarchRecurring').catch(() => null),
        withTimeout(monarchWealth.getAccounts(), EXT, 'monarchAccounts').catch(() => null),
      ]);
      if (recurring) {
        const { computeCashflowLookahead } = require('./src/intelligence/cashflow-lookahead');
        const streams = [...(recurring.expenses || []), ...(recurring.creditCards || [])];
        const { detail } = computeCashflowLookahead({ streams, accounts: accountsData?.accounts || [] });
        if (detail) cashflowContext = detail;
      }
    }
  } catch (err) {
    console.error('[cashflow lookahead] failed:', err.message);
  }

  // "You vs past you" — Monday-only longitudinal zoom-out (trailing 4 weeks vs
  // ~3 months ago). Weekly cadence keeps it a perspective beat, not a daily
  // ritual; the module itself only reports shifts that clear real thresholds.
  let progressContext = '';
  try {
    const weekday = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: process.env.TZ || 'America/New_York' });
    if (weekday === 'Monday') {
      progressContext = await require('./src/intelligence/progress').computeProgressContext();
    }
  } catch (err) {
    console.error('[progress context] failed:', err.message);
  }

  // Life chapters — standing long-arc facts (pregnancy week auto-derived from
  // the due date, countdowns to key dates) so the brief knows the user's life,
  // not just their metrics, without weekly re-typing.
  let chaptersContext = '';
  try {
    const chapters = await lifeChaptersStore.listActive();
    chaptersContext = require('./src/intelligence/chapters').composeChapterContext(chapters);
  } catch (err) {
    console.error('[chapters context] failed:', err.message);
  }

  // This week's stated goals (the Sunday check-in) — fetched BEFORE the LLM
  // call so the chief of staff can surface an important goal that's still
  // unchecked as the week runs out, instead of the goals living only as a
  // silent checklist on the Insights tab. Reused for the response payload.
  let weeklyGoals = null;
  let weeklyGoalsContext = '';
  try {
    const [currentInt, priorInt] = await Promise.all([
      intentionsStore.currentIntention(),
      intentionsStore.priorIntention(),
    ]);
    if (currentInt || priorInt) weeklyGoals = { current: currentInt ?? null, prior: priorInt ?? null };
    const goals = currentInt?.goals ?? [];
    if (goals.length) {
      const done = goals.filter((g) => g.achieved).map((g) => `[done] ${g.text}`);
      const open = goals.filter((g) => !g.achieved).map((g) => `[OPEN] ${g.text}`);
      weeklyGoalsContext =
        `${[...open, ...done].join(' · ')}` +
        (currentInt?.context ? ` (week context: "${String(currentInt.context).slice(0, 300)}")` : '');
    }
  } catch (err) {
    console.error('[weeklyGoals] failed:', err.message);
    errors.push({ service: 'weekly_goals', error: err.message });
  }

  // Call the LLM with whatever data we have
  let geminiResult = null;
  try {
    // The LLM call can be slow; bound it so a stalled model doesn't hang the
    // briefing (it degrades to the data-only sections).
    geminiResult = await withTimeout(
      generateBriefing(emails, notionTextForBrief, quoteData.quote, dayName, workout, calendar, wellbeingContext, annotationsContext, recoveryContext, experimentsContext, selfModel, leverageContext, workBusy, strengthContext, spendingContext, continuityContext, cashflowContext, progressContext, weeklyGoalsContext, chaptersContext),
      Number(process.env.BRIEFING_LLM_TIMEOUT_MS || 90000),
      'gemini'
    );
  } catch (err) {
    console.error('[gemini] failed:', err.message);
    errors.push({ service: 'gemini', error: err.message });
  }

  // LLM fallback: if the AI call failed and there's a prior build today (or
  // yesterday), carry over its email/wisdom sections so the briefing doesn't go blank.
  // Must run BEFORE the dedup check below — otherwise a carried-forward notionQuote
  // (which can be from any earlier day) would bypass the 30-day no-repeat memory
  // entirely: skipped by the check (geminiResult was null at that point) and never
  // recorded, so it could silently resurface weeks later on any LLM hiccup.
  if (!geminiResult && prior?.content) {
    const p = prior.content;
    if (p.urgentEmails?.length || p.quoteInsight || p.notionInsight) {
      geminiResult = {
        urgentEmails: p.urgentEmails ?? [],
        quoteInsight: p.quoteInsight ?? '',
        notionQuote: p.notionQuote ?? '',
        notionInsight: p.notionInsight ?? '',
      };
      errors.push({ service: 'gemini_fallback', error: 'LLM unavailable — showing prior build summaries' });
    }
  }

  // Dedup the wisdom quote DETERMINISTICALLY (the model often ignores the
  // avoid-list in the prompt, and the LLM-failure fallback above can carry an
  // older quote forward verbatim). Runs on whatever notionQuote will actually be
  // shown today — live pick or fallback — so neither path can bypass the 30-day
  // no-repeat memory. On a fresh build: if it's already shown in the last 30 days,
  // suppress it so the card hides today rather than repeating; otherwise record it.
  if (!priorIsToday && geminiResult?.notionQuote) {
    const ref = String(geminiResult.notionQuote).toLowerCase().replace(/\s+/g, ' ').replace(/[“”"']/g, '').trim().slice(0, 300);
    if (ref && seenNotionQuotes.has(ref)) {
      geminiResult.notionQuote = '';
      geminiResult.notionInsight = '';
    } else if (ref) {
      surfacedStore.record('notion_quote', ref).catch(() => {});
    }
  }

  // Surface the intelligence layer's current findings (from the last analysis).
  let insights = [];
  let crossContextInsights = [];
  let wealthInsights = [];
  let healthInsights = [];
  let leverageActions = [];
  let forecasts = [];
  // `recovery` is already declared + computed earlier (for the briefing prompt);
  // the block below reuses it and only recomputes if that early call came back null.
  let healthComposites = [];
  try {
    const open = await findingsStore.listFindings({ status: 'open' });
    leverageActions = open
      .filter((f) => f.type === 'leverage')
      .sort((a, b) => (a.evidence?.rank ?? 99) - (b.evidence?.rank ?? 99))
      .slice(0, 3)
      .map((f) => ({ title: f.title, detail: f.detail }));
    forecasts = open
      .filter((f) => f.type === 'forecast')
      .sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1)) // most at-risk first
      .slice(0, 5)
      .map((f) => ({
        title: f.title,
        detail: f.detail,
        probability: f.confidence,
        status: f.evidence?.status ?? null,
      }));

    // Live health composites (recovery/sleep-debt/etc.) are current status, not
    // rotating insights — pull them out so they're shown fresh every day and
    // surface the recovery score as its own headline field.
    const COMPOSITE_TYPES = ['recovery', 'sleep_debt', 'sleep_consistency', 'sleep_regularity', 'training_load'];

    // Recovery is computed LIVE from the spine at every briefing build, not
    // re-served from the finding analyze() stored at its morning run. The
    // stored finding scores whatever the DB held at ~8:30am — for a daytime
    // watch wearer there's no HRV/RHR row for today yet at that hour, so its
    // "latest" is yesterday's value, and the card would contradict the live
    // HealthKit numbers below it all day. Falls back to the stored finding.
    // (liveRecovery was already called above for the briefing prompt — skip redundant call)
    if (!recovery) {
      try {
        recovery = await require('./src/intelligence/recovery').liveRecovery();
      } catch (err) {
        console.error('[recovery live] failed:', err.message);
      }
    }
    if (!recovery) {
      const recoveryFinding = open.find((f) => f.type === 'recovery');
      if (recoveryFinding) {
        recovery = {
          score: recoveryFinding.evidence?.score ?? null,
          band: recoveryFinding.evidence?.band ?? null,
          parts: recoveryFinding.evidence?.parts ?? {},
          detail: recoveryFinding.detail,
        };
      }
    }
    healthComposites = open
      .filter((f) => COMPOSITE_TYPES.includes(f.type) && f.type !== 'recovery')
      .map((f) => ({ type: f.type, title: f.title, detail: f.detail, evidence: f.evidence }));

    // Cross-context insights get their own prominent surface (the differentiator),
    // so pull them out of the generic rotation and expose them directly.
    crossContextInsights = open
      .filter((f) => f.type === 'cross_context')
      .slice(0, 3)
      .map((f) => ({ title: f.title, detail: f.detail, domains: f.domains, confidence: f.confidence }));

    // Insights rotate: prefer ones not shown in the last 30 days so the card
    // stays fresh, falling back to the rest if you've seen them all. Composites
    // and cross-context (shown separately) are excluded.
    const insightPool = open.filter(
      (f) => f.type !== 'leverage' && f.type !== 'forecast' && f.type !== 'cross_context' && !COMPOSITE_TYPES.includes(f.type)
    );

    // Curation layer: score every finding on ONE comparable scale (importance ×
    // magnitude × confidence × novelty), dedupe redundant single-metric findings,
    // and rank. Replaces the old per-bucket confidence/type sorts so the strongest,
    // newest, most actionable findings float to the top of every tab — and a
    // 45-day-old confirmed correlation recedes instead of re-showing daily.
    let rankedPool = insightPool;
    try {
      rankedPool = await require('./src/intelligence/curate').curate(insightPool);
    } catch (err) {
      console.error('[curate] failed, falling back to confidence sort:', err.message);
      rankedPool = [...insightPool].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    }

    const slim = (f) => ({ type: f.type, title: f.title, detail: f.detail, confidence: f.confidence, domains: f.domains });

    // Today's "What The Data Shows": the top of the curated pool, already ranked
    // by signal strength. The client splits this into health vs. habit cards by
    // domain, so send a generous slice (12) to feed both without starving either.
    insights = rankedPool.slice(0, 12).map(slim);

    // Wealth/spending insights for the Wealth tab — spending patterns (this
    // month vs your usual) and over-budget categories (vs Monarch budgets).
    // Computed live from transaction data; falls back to nothing on failure.
    try {
      wealthInsights = await buildWealthInsights();
    } catch (err) {
      console.error('[wealthInsights] failed:', err.message);
      errors.push({ service: 'wealth_insights', error: err.message });
    }

    // Health (body/physiology) findings for the Health tab — anything that touches
    // the HEALTH domain: sleep/activity impact, habit↔health splits, sleep→focus
    // levers, HRV/sleep trends/anomalies/correlations. Wellbeing-ONLY findings
    // (mood/energy/focus standouts with no body metric) are deliberately excluded
    // here — they live on Today's HabitTrendsCard — so the same mood anomaly never
    // shows on two tabs at once. Already ranked by the curator; just filter + cap.
    healthInsights = rankedPool
      .filter((f) => Array.isArray(f.domains) && f.domains.includes('health'))
      .slice(0, 5)
      .map(slim);

    // Card-level dismissals: drop any insight the user has explicitly dismissed
    // (e.g. a recurring car payment flagged for "review"), and stamp each survivor
    // with its stable dismissKey so the client can dismiss it. Applies uniformly
    // to stored findings AND live-computed wealth insights.
    try {
      const dismissedInsights = require('./src/store/dismissedInsights');
      const dismissed = await dismissedInsights.dismissedKeys();
      insights = dismissedInsights.applyDismissals(insights, dismissed);
      wealthInsights = dismissedInsights.applyDismissals(wealthInsights, dismissed);
      healthInsights = dismissedInsights.applyDismissals(healthInsights, dismissed);
      crossContextInsights = dismissedInsights.applyDismissals(crossContextInsights, dismissed);
    } catch (err) {
      console.error('[insights dismissals] failed:', err.message);
    }
  } catch (err) {
    console.error('[insights] failed:', err.message);
    errors.push({ service: 'insights', error: err.message });
  }

  // Relevant-not-random: surface the library highlight that speaks to where
  // you are *internally* (mood/energy/focus + slipping habits), not your task
  // list — and never repeat one within 30 days. Falls back to the quote, then
  // to evergreen growth themes when there's no recent check-in data.
  let relevantHighlight = null;
  try {
    const rh = require('./src/intelligence/relevant-highlight');
    // Semantic-match against the user's CURRENT situation (goals, life context,
    // any low-wellbeing themes) — not the daily quote — and have the LLM name the
    // connection ("why now") or admit it's only a loose fit (→ honest factual
    // frame on the card). excludeAuthor drops same-author echoes of today's quote.
    relevantHighlight = await withTimeout(
      rh.buildRelevantHighlight({ themes: wellbeingTheme, excludeAuthor: quoteData?.author || null }),
      EXT, 'highlight'
    );
    if (relevantHighlight && relevantHighlight.id && !priorIsToday) {
      await surfacedStore.record('highlight', relevantHighlight.id);
    }
  } catch (err) {
    console.error('[relevantHighlight] failed:', err.message);
    errors.push({ service: 'highlight', error: err.message });
  }

  // Weekly goal achievement (current + prior week with hit/miss) was fetched
  // above, before the LLM call, so the chief brief could see open goals — the
  // same `weeklyGoals` object is reused here for the response payload.

  // Latest weekly review (generated separately on a weekly cadence).
  let weeklyReview = null;
  try {
    const wr = await briefingsStore.latestBriefing('weekly');
    if (wr) {
      const contentObj = wr.content;
      // 'Weekly review' is the exact fallback headline when extractJson fails —
      // a real review always has a specific punchy headline. Suppress the broken record.
      if (contentObj?.headline !== 'Weekly review') {
        weeklyReview = { ...contentObj, generatedAt: wr.generated_at };
      }
    }
  } catch (err) {
    console.error('[weeklyReview] failed:', err.message);
    errors.push({ service: 'weekly_review', error: err.message });
  }

  // Wealth snapshot for the Wealth tab (from the canonical spine — Monarch etc.).
  let wealth = null;
  try {
    const sum = (arr) => arr.reduce((s, r) => s + Number(r.value), 0);
    // Truncate to UTC midnight so the range boundary aligns with how metrics
    // are stored (dayTs → YYYY-MM-DDT00:00:00Z). Without this, a rolling-ms
    // weekAgo of "Jun 18 12:00 UTC" would exclude Jun 18 00:00 UTC metrics.
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    weekAgo.setUTCHours(0, 0, 0, 0);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    monthAgo.setUTCHours(0, 0, 0, 0);
    const nw = await metricsStore.latest({ domain: 'wealth', metric: 'net_worth' });
    const nwPrev = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'net_worth', from: monthAgo, to: weekAgo, agg: 'avg', excludeSource: 'seed' });
    const now = new Date();
    const [spend, discretionary, income, spendMonth, incomeMonth, discretionaryMonth] = await Promise.all([
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending', from: weekAgo, to: now, agg: 'sum', excludeSource: 'seed' }),
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending_discretionary', from: weekAgo, to: now, agg: 'sum', excludeSource: 'seed' }),
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'income', from: weekAgo, to: now, agg: 'sum', excludeSource: 'seed' }),
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending', from: monthAgo, to: now, agg: 'sum', excludeSource: 'seed' }),
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'income', from: monthAgo, to: now, agg: 'sum', excludeSource: 'seed' }),
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending_discretionary', from: monthAgo, to: now, agg: 'sum', excludeSource: 'seed' }),
    ]);
    if (nw || spend.length) {
      const netWorth = nw ? Number(nw.value) : null;
      const priorNw = nwPrev.length ? sum(nwPrev) / nwPrev.length : null;
      wealth = {
        netWorth,
        netWorthChange: netWorth != null && priorNw ? Math.round((netWorth - priorNw)) : null,
        spendingThisWeek: Math.round(sum(spend)),
        discretionaryThisWeek: discretionary.length ? Math.round(sum(discretionary)) : null,
        incomeThisWeek: Math.round(sum(income)),
        cashflowThisWeek: Math.round(sum(income) - sum(spend)),
        // NB: the *ThisMonth fields are ROLLING 30 days (monthAgo = now − 30d),
        // not calendar MTD. Rolling is the right basis for cashflow/income/savings
        // (constant-length window, always spans a full pay cycle, so lumpy income
        // doesn't distort it). Budget adherence stays MTD elsewhere — budgets are
        // calendar-month. The card labels these "(30d)" so the two never blur.
        spendingThisMonth: Math.round(sum(spendMonth)),
        incomeThisMonth: Math.round(sum(incomeMonth)),
        cashflowThisMonth: Math.round(sum(incomeMonth) - sum(spendMonth)),
        discretionaryThisMonth: discretionaryMonth.length ? Math.round(sum(discretionaryMonth)) : null,
        syncedAt: nw?.ts ? new Date(nw.ts).toISOString() : null,
      };
    }
  } catch (err) {
    console.error('[wealth] failed:', err.message);
    errors.push({ service: 'wealth', error: err.message });
  }

  // Source-staleness alerts. The Monarch token expires periodically; when it
  // does the Mac sync fails silently, so surface "needs reconnecting" in the
  // briefing rather than letting net-worth quietly go stale. Threshold is
  // generous (40h) so a missed morning (Mac asleep) doesn't false-alarm.
  const alerts = [];
  try {
    const monarchSrc = await sourcesStore.getSource('monarch');
    if (monarchSrc) {
      const last = monarchSrc.last_sync_at ? new Date(monarchSrc.last_sync_at) : null;
      const ageH = last ? (Date.now() - last.getTime()) / 36e5 : Infinity;
      if (monarchSrc.status === 'error' || ageH > 40) {
        alerts.push({
          source: 'monarch',
          severity: ageH > 96 ? 'high' : 'warn',
          message: last
            ? `Monarch hasn't synced in ${Math.round(ageH)}h — the token may have expired. Reconnect: cd ~/claude/backend && node scripts/monarch-reconnect.js`
            : `Monarch has never synced. Reconnect: cd ~/claude/backend && node scripts/monarch-reconnect.js`,
        });
      }
    }
  } catch (err) {
    console.error('[alerts] failed:', err.message);
  }

  // Daily-lock: if we already built a briefing earlier today, keep the same
  // "wisdom" picks (library highlight, daily quote, Notion page, and the Gemini
  // insights written about the quote/Notion) so they stay static all day and only
  // change at midnight. A non-empty fresh value still wins if the locked one was
  // blank (e.g. the first build failed to fetch it), so we never lock in nothing.
  const p = priorIsToday ? prior.content : null;
  const keep = (locked, fresh) => (locked != null && locked !== '' ? locked : fresh);

  // Quote + its insight (and the Notion quote+insight+text) must be locked as a
  // UNIT — locking them independently let the displayed quote and its commentary
  // come from different builds, so the insight could describe a different quote
  // than the one shown. Carry the whole pair from the prior build when it has a
  // real quote; otherwise take the whole pair fresh from this build.
  const lockedQuotePair = p && p.quote ? { quote: p.quote, quoteInsight: p.quoteInsight } : null;
  const freshQuotePair = { quote: quoteData.quote, quoteInsight: geminiResult?.quoteInsight ?? '' };
  const quotePair = lockedQuotePair || freshQuotePair;

  const lockedNotion = p && p.notionQuote ? { notionQuote: p.notionQuote, notionInsight: p.notionInsight, notionText: p.notionText, notionPageTitle: p.notionPageTitle } : null;
  const freshNotion = { notionQuote: geminiResult?.notionQuote ?? '', notionInsight: geminiResult?.notionInsight ?? '', notionText: notionData.text, notionPageTitle: notionData.pageTitle };
  const notionGroup = lockedNotion || freshNotion;

  // Daily forecast: today's grade (A/B/C day) + sleep-debt trajectory. Forward-
  // looking companion to the recovery card; reuses the already-computed recovery.
  let todayForecast = null;
  try {
    todayForecast = await require('./src/intelligence/predict').computeTodayForecast({ recovery });
  } catch (err) {
    console.error('[todayForecast] failed:', err.message);
  }

  const response = {
    date: dateLabel,
    builtAt: new Date().toISOString(),
    // Carry the prior build's brief when this build's LLM call failed or returned
    // malformed JSON (no chiefBrief). Without this, a single bad rebuild blanks the
    // whole Chief-of-Staff card. Fresh always wins when present.
    morningFocus: geminiResult?.morningFocus || prior?.content?.morningFocus || '',
    // Structured Chief-of-Staff brief (Beta): synthesis + ACTION/RISK/MOVE.
    chiefBrief: geminiResult?.chiefBrief ?? prior?.content?.chiefBrief ?? null,
    weather,
    workout,
    calendar,
    workBusy: workBusy ?? [],
    urgentEmails: priorIsToday && p?.urgentEmails?.length ? p.urgentEmails : (geminiResult?.urgentEmails ?? []),
    // Quote + insight locked together (see quotePair above) so they always match.
    quote: quotePair.quote,
    quoteInsight: quotePair.quoteInsight,
    // Notion quote + insight + source text locked together as a unit too.
    notionQuote: notionGroup.notionQuote,
    notionInsight: notionGroup.notionInsight,
    notionText: notionGroup.notionText,
    notionPageTitle: notionGroup.notionPageTitle,
    leverageActions,
    insights,
    crossContextInsights,
    wealthInsights,
    healthInsights,
    recovery,
    healthComposites,
    todayForecast,
    forecasts,
    weeklyGoals,
    relevantHighlight: keep(p?.relevantHighlight, relevantHighlight),
    weeklyReview,
    wealth,
    markets,
    wellbeingTheme: keep(p?.wellbeingTheme, wellbeingTheme || null),
    dailyQuote: keep(p?.dailyQuote, dailyQuote),
    alerts,
    signals,
  };

  if (errors.length > 0) {
    response.errors = errors;
  }

  res.json(response);

  // Persist the briefing for history, and capture today's data into the spine.
  // Fire-and-forget: never let persistence failures affect the live response.
  briefingsStore.saveBriefing({ kind: 'daily', content: response })
    .catch((err) => console.error('[persist briefing] failed:', err.message));

  runIngest()
    .then((results) => {
      const summary = results
        .map((r) => (r.error ? `${r.id}:err` : `${r.id}:${r.metrics}m/${r.documents}d`))
        .join(' ');
      console.log(`[ingest] ${summary}`);
      // Embed new documents (best-effort), then refresh findings.
      return embedPending({ maxBatches: 4 }).catch((e) => {
        console.error('[embed] failed:', e.message);
      });
    })
    // Rebuild wealth flow metrics from the just-synced transactions, so Monarch
    // recategorizations (e.g. income -> transfer) are reflected automatically —
    // including days whose only contributor was recategorized away, which a
    // plain upsert can't zero out.
    .then(() => require('./src/services/recompute-wealth').recomputeWealthFlows()
      .then((r) => { if (r?.metricsWritten) console.log(`[recompute-wealth] ${r.transactions} txns -> ${r.metricsWritten} flow rows`); })
      .catch((e) => console.error('[recompute-wealth] failed:', e.message)))
    .then(() => analyze())
    .then((s) => {
      if (s) console.log(`[analyze] ${s.trends} trends, ${s.correlations} correlations, ${s.actions} actions`);
      // Propose experiments from unconfirmed correlations; evaluate due ones.
      return Promise.all([
        experiments.proposeExperiments().catch((e) => console.error('[propose]', e.message)),
        experiments.evaluateDue().catch((e) => console.error('[evaluate]', e.message)),
      ]);
    })
    // Synthesize cross-domain relationships into plain-language insights, then run
    // a proactive push so a strong NEW connection reaches the phone unprompted
    // (deduped + quiet-hours aware inside runNudges).
    .then(() => require('./src/intelligence/crossContext').generateCrossContext()
      .catch((e) => console.error('[crossContext]', e.message)))
    .then(() => require('./src/notify/run').runNudges({ suppressCheckin: true })
      .catch((e) => console.error('[proactive nudge]', e.message)))
    .catch((err) => console.error('[ingest/analyze] failed:', err.message));
});

// Pipeline health — per-connector freshness + staleness status. The authoritative
// version of the stale check that also runs silently inside the briefing build.
// Useful for debugging "why is my briefing citing old numbers?"
const PIPELINE_STALE_THRESHOLDS = {
  eight_sleep_api:  { hours: 26, criticalFor: 'recovery/sleep' },
  monarch_mcp_sync: { hours: 26, criticalFor: 'wealth/spending' },
  monarch:          { hours: 48, criticalFor: 'wealth' },
  health:           { hours: 6,  criticalFor: 'activity/steps' },
  checkin:          { hours: 36, criticalFor: 'mood/energy/focus' },
  habits:           { hours: 36, criticalFor: 'habits' },
  readwise:         { hours: 72, criticalFor: 'highlights' },
};
const PIPELINE_DEFAULT_STALE_H = 72;

app.get('/api/pipeline-health', async (req, res) => {
  try {
    const sources = await sourcesStore.listSources();
    const now = Date.now();
    const connectors = sources.map((s) => {
      const thresh = PIPELINE_STALE_THRESHOLDS[s.id] ?? { hours: PIPELINE_DEFAULT_STALE_H, criticalFor: null };
      const hoursAgo = s.last_sync_at
        ? (now - new Date(s.last_sync_at).getTime()) / 3_600_000
        : null;
      const isStale = hoursAgo == null || hoursAgo > thresh.hours;
      return {
        id: s.id,
        displayName: s.display_name,
        domain: s.domain,
        status: s.status ?? 'unknown',
        lastSyncAt: s.last_sync_at ?? null,
        lastError: s.last_error ?? null,
        hoursAgo: hoursAgo != null ? Math.round(hoursAgo * 10) / 10 : null,
        staleThresholdHours: thresh.hours,
        isStale,
        criticalFor: thresh.criticalFor,
      };
    });
    const stale = connectors.filter((c) => c.isStale && PIPELINE_STALE_THRESHOLDS[c.id]);
    res.json({
      connectors,
      anyStale: stale.length > 0,
      staleSummary: stale.length
        ? `${stale.length} source(s) stale: ${stale.map((c) => c.displayName || c.id).join(', ')}`
        : 'All monitored sources are fresh.',
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recommendation ledger — what leverage actions have been surfaced + outcome data.
// GET /api/recommendations?limit=50&since=YYYY-MM-DD&pending=1
app.get('/api/recommendations', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const since = req.query.since ? new Date(req.query.since) : null;
    const rows = await recommendationsStore.listRecommendations({ limit, since });
    // Summary stats for the weekly review "What I Tried" view.
    const measured = rows.filter((r) => r.outcome_measured_at != null);
    const positive = measured.filter((r) => {
      if (r.outcome_delta == null) return false;
      return r.expected_direction === 'down'
        ? Number(r.outcome_delta) < 0
        : Number(r.outcome_delta) > 0;
    });
    res.json({
      recommendations: rows,
      stats: {
        total: rows.length,
        measured: measured.length,
        positive: positive.length,
        hitRate: measured.length ? Math.round((positive.length / measured.length) * 100) : null,
      },
    });
    // Background: auto-measure outcomes for any pending recs with enough elapsed time.
    recommendationsStore.measureOutcomes().catch(() => {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/recommendations/:id/outcome — explicit thumbs-up/down from the user.
app.post('/api/recommendations/:id/outcome', async (req, res) => {
  try {
    const { id } = req.params;
    const { thumbsUp } = req.body;
    if (typeof thumbsUp !== 'boolean') return res.status(400).json({ error: 'thumbsUp required' });
    const { query: dbQuery } = require('./src/db');
    const { rows } = await dbQuery('SELECT expected_direction FROM recommendations WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const { expected_direction } = rows[0];
    // thumbsUp = true means "it worked as expected"; delta sign follows expected direction.
    const delta = thumbsUp
      ? (expected_direction === 'down' ? -1 : 1)
      : (expected_direction === 'down' ? 1 : -1);
    await recommendationsStore.setOutcome(id, { delta, measuredAt: new Date() });
    res.json({ ok: true, delta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/recommendations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { query: dbQuery } = require('./src/db');
    const { rowCount } = await dbQuery('DELETE FROM recommendations WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const { runMigrations } = require('./src/db/migrate');
runMigrations()
  .catch((err) => console.error('[migrate] failed, starting anyway:', err.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`NormOS backend running on http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/api/health`);
      // Cleanup: delete recommendation ledger entries that are Monarch query steps
      // (the LLM was tagging "Pull Jan–Jun..." as <rec> recommendations).
      require('./src/db').query(
        `DELETE FROM recommendations WHERE title ~* '^(pull|export|fetch|get|check|look|query|run|import|download|analyze|review|compare) '`
      ).then(({ rowCount }) => { if (rowCount > 0) console.log(`[boot] removed ${rowCount} bad query-step recommendation(s)`); })
        .catch(() => {});

      // Cleanup: delete any correlation findings where either side is an environment
      // metric. Env correlations now come exclusively from computeDaytimeCardio
      // (Apple Watch daytime HRV/RHR) — not the general Pearson engine. Also remove
      // tautological findings (exercise habit → active energy) and the energy↔HRV
      // pair (energy is an output of HRV, not a lever for improving it).
      require('./src/db').query(
        `DELETE FROM findings
          WHERE evidence->>'kind' = 'correlation'
            AND (
              evidence->>'a' LIKE 'environment:%'
              OR evidence->>'b' LIKE 'environment:%'
              OR (evidence->>'a', evidence->>'b') IN (
                ('habits:exercise','health:active_energy'),('health:active_energy','habits:exercise'),
                ('habits:exercise','health:exercise_minutes'),('health:exercise_minutes','habits:exercise'),
                ('health:exercise_minutes','health:active_energy'),('health:active_energy','health:exercise_minutes'),
                ('health:hrv','wellbeing:energy'),('wellbeing:energy','health:hrv'),
                ('health:resting_hr','wellbeing:energy'),('wellbeing:energy','health:resting_hr')
              )
            )`
      ).then(({ rowCount }) => { if (rowCount > 0) console.log(`[boot] removed ${rowCount} spurious/tautological finding(s)`); })
        .catch(() => {});

      // Cleanup: delete habit_split findings whose lever is a subjective wellbeing
      // state (high-mood / high-energy / high-focus days). These invert causality —
      // mood/energy/focus are OUTPUTS of recovery, not levers that drive HRV/sleep.
      // No longer generated; this removes any already in the DB.
      require('./src/db').query(
        `DELETE FROM findings
          WHERE evidence->>'kind' = 'habit_split'
            AND evidence->>'habit' IN ('High-mood days','High-energy days','High-focus days')`
      ).then(({ rowCount }) => { if (rowCount > 0) console.log(`[boot] removed ${rowCount} backwards wellbeing-lever finding(s)`); })
        .catch(() => {});

      // Cleanup: delete trend findings on Eight Sleep DERIVED intermediates
      // (sleep need/debt) and any correlation involving them or VO₂ max. These
      // leaked into the general trend/correlation engines before being excluded;
      // they're derived or near-flat estimate series, so patterns like
      // "higher VO₂ max → lower sleep need" are noise, not physiology.
      require('./src/db').query(
        `DELETE FROM findings
          WHERE (evidence->>'kind' = 'trend' AND evidence->>'metric' IN ('health:sleep_debt','health:sleep_need'))
             OR (evidence->>'kind' = 'correlation' AND (
                   evidence->>'a' IN ('health:sleep_debt','health:sleep_need','health:vo2_max','health:respiratory_rate')
                OR evidence->>'b' IN ('health:sleep_debt','health:sleep_need','health:vo2_max','health:respiratory_rate')))`
      ).then(({ rowCount }) => { if (rowCount > 0) console.log(`[boot] removed ${rowCount} derived/estimate-metric finding(s)`); })
        .catch(() => {});

      // Cleanup: collapse near-duplicate PENDING recommendations that differ only
      // by the numbers in their title (e.g. "Best sleep nights → 13% better HRV"
      // vs "→ 12%"). Keeps the newest; never touches rows the user has rated.
      recommendationsStore.dedupePending()
        .then((n) => { if (n > 0) console.log(`[boot] collapsed ${n} duplicate recommendation(s)`); })
        .catch(() => {});

      // Cleanup: undo outcomes the old engine auto-measured after only ~3 days
      // (premature "No effect"). Returns them to "Measuring…" for a proper check.
      // User thumbs (exact ±1 delta) are preserved.
      recommendationsStore.clearPrematureAutoOutcomes()
        .then((n) => { if (n > 0) console.log(`[boot] reset ${n} prematurely-measured recommendation(s)`); })
        .catch(() => {});

      // Cleanup: delete stale "High-energy days → HRV" ledger rows — a backwards-
      // causality recommendation from before that finding was removed (energy is an
      // output of HRV, not a lever). Only un-rated rows, so no feedback is lost.
      require('./src/db').query(
        `DELETE FROM recommendations
          WHERE outcome_measured_at IS NULL
            AND title ILIKE '%high-energy days%'`
      ).then(({ rowCount }) => { if (rowCount > 0) console.log(`[boot] removed ${rowCount} backwards energy→HRV recommendation(s)`); })
        .catch(() => {});

      // Optional self-running morning routine (cloud deploys; ENABLE_SCHEDULER=true).
      require('./src/scheduler').start();

      // One-setting demo data: set SEED_DEMO_ON_BOOT=true to populate realistic
      // sample data + findings so the app shows a full dashboard on first open.
      // Idempotent (only touches 'seed' rows); turn the flag off once real data flows.
      if (process.env.SEED_DEMO_ON_BOOT === 'true') {
        (async () => {
          try {
            const { seed } = require('./src/db/seed');
            const { analyze } = require('./src/intelligence/analyze');
            const s = await seed();
            await analyze();
            console.log(`[demo] seeded ${s.metrics} metrics + ${s.goals} goals and analyzed.`);
          } catch (err) {
            console.error('[demo] seed-on-boot failed:', err.message);
          }
        })();
      }
    });
  });
