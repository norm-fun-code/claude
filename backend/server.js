// NormOS backend.
require('dotenv').config();
const crypto = require('crypto');
const { withTimeout } = require('./src/util/async');
const express = require('express');
const cors = require('cors');

const { fetchGmailThreads } = require('./src/services/gmail');
const { fetchCalendarEvents } = require('./src/services/calendar');
const { fetchRandomNotionPage, fetchNotionQuotes } = require('./src/services/notion');
const { fetchRandomQuote } = require('./src/services/googleDoc');
const { fetchWeather } = require('./src/services/weather');
const { fetchMarkets } = require('./src/services/markets');
const { generateBriefing } = require('./src/services/briefing-ai');
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
const surfacedStore = require('./src/store/surfaced');
const briefingsStore = require('./src/store/briefings');
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
  res.json({ status: 'ok', database, timestamp: new Date().toISOString() });
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

// What you've already checked in *today* (your timezone), so the card can
// rehydrate after a tab switch / reopen and reset cleanly at midnight.
app.get('/api/checkin/today', async (req, res) => {
  try {
    const tz = process.env.TZ || 'America/New_York';
    const { rows } = await db.query(
      `SELECT metric, value FROM metrics
        WHERE domain = 'wellbeing' AND source = 'checkin'
          AND (ts AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
        ORDER BY ts ASC`,
      [tz]
    );
    const v = {};
    for (const r of rows) v[r.metric] = Number(r.value); // latest wins
    res.json({
      logged: rows.length > 0,
      mood: Number.isFinite(v.mood) ? v.mood : null,
      energy: Number.isFinite(v.energy) ? v.energy : null,
      focus: Number.isFinite(v.focus) ? v.focus : null,
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
    res.json(await analyze());
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

// Diagnostic: dump the RAW metric rows for a metric over the last N days,
// grouped by day + source. Reveals duplication that a daily SUM would inflate —
// e.g. many step rows for the same day (pre-fix per-refresh writes) all summed.
// GET /api/diag/recovery-baseline — shows the raw series and baseline stats
// (mean, std, z, n) that drive the recovery percentile scores, so we can
// verify the data matches what Apple Health reports.
app.get('/api/diag/recovery-baseline', async (req, res) => {
  try {
    const metricsStore = require('./src/store/metrics');
    const stats = require('./src/intelligence/stats');
    const METRICS = ['health:hrv', 'health:resting_hr', 'health:sleep_score', 'health:sleep_hours'];
    const from = new Date(Date.now() - 60 * 864e5);
    const out = {};
    for (const key of METRICS) {
      const [domain, metric] = key.split(':');
      const rows = await metricsStore.dailyAggregate({ domain, metric, from, agg: 'avg', excludeSource: 'seed' });
      const a = stats.baselineAnomaly(rows.map((r) => ({ value: r.value })), { baselineDays: 30, minN: 8 });
      out[key] = {
        n: rows.length,
        latest: rows.length ? Number(rows[rows.length - 1].value).toFixed(2) : null,
        latestDay: rows.length ? rows[rows.length - 1].day : null,
        baseline: a ? {
          mean: Number(a.baselineMean).toFixed(2),
          std: Number(a.baselineStd).toFixed(2),
          z: Number(a.z).toFixed(3),
          n: a.n,
          percentile: Math.round(stats.normalCdf(a.z) * 100),
        } : null,
        series: rows.slice(-35).map((r) => ({ day: r.day, value: Number(r.value).toFixed(1) })),
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
      newsletters: result.newsletters.length,
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
    res.json(await ask(question, { history }));
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

app.get('/api/annotations', async (req, res) => {
  try {
    res.json({ annotations: await annotationsStore.listAnnotations({ from: req.query.from, to: req.query.to }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

app.get('/api/sources', async (req, res) => {
  try {
    res.json({ sources: await sourcesStore.listSources() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/briefing', async (req, res) => {
  const errors = [];

  // Serve a recent cached briefing instantly unless ?refresh=1. Building fresh
  // calls the LLM + weather/calendar/Notion/markets/embeddings (15-40s), so we
  // reuse the last build for CACHE_TTL_MIN minutes. The app's pull-to-refresh
  // sends refresh=1 to force a rebuild.
  const CACHE_TTL_MIN = Number(process.env.BRIEFING_CACHE_MIN || 180); // 3h default
  const tz = process.env.TZ || 'America/New_York';
  const force = req.query.refresh === '1' || req.query.refresh === 'true';

  // The most recent prior build, and whether it was built earlier *today* (in the
  // user's timezone). Used both for the short TTL cache and for the daily-lock:
  // the "wisdom" content (library highlight, daily quote, Notion page + the
  // Gemini insights on them) is chosen on the first build of the day and then
  // carried over on every later build — including pull-to-refresh — so it stays
  // static until midnight. Dynamic data (weather, markets, calendar, email,
  // findings) still refreshes every build.
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

  if (!force && prior?.content && prior.generated_at) {
    const ageMin = (Date.now() - new Date(prior.generated_at).getTime()) / 60000;
    if (ageMin < CACHE_TTL_MIN) {
      return res.json({ ...prior.content, cached: true, cachedAgeMin: Math.round(ageMin) });
    }
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

  // Workout is synchronous — no failure path
  const workout = getTodayWorkout();

  // Notion wisdom page: avoid repeating one shown in the last 30 days.
  const seenNotion = await surfacedStore.recentRefs('notion_page', 30).catch(() => new Set());

  // Fetch all independent data sources in parallel. Each is bounded by a hard
  // timeout so one slow upstream (Gmail/Notion/etc.) can't hang the whole
  // briefing — allSettled waits for every promise, so without this a single
  // stall blocks the response. A timed-out source just shows as a soft error.
  const EXT = Number(process.env.BRIEFING_SOURCE_TIMEOUT_MS || 12000);
  const [weatherResult, calendarResult, notionResult, quoteResult, emailResult, marketsResult] =
    await Promise.allSettled([
      withTimeout(fetchWeather(), EXT, 'weather'),
      withTimeout(fetchCalendarEvents(), EXT, 'calendar'),
      withTimeout(fetchRandomNotionPage({ exclude: [...seenNotion] }), EXT, 'notion'),
      withTimeout(fetchRandomQuote(), EXT, 'googleDoc'),
      withTimeout(fetchGmailThreads(), EXT, 'gmail'),
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
  let dailyQuote = null;
  try {
    const quotes = await withTimeout(fetchNotionQuotes(), EXT, 'notionQuotes');
    if (quotes.length) {
      const seen = await surfacedStore.recentRefs('daily_quote', 30);
      const [pick] = surfacedStore.pickFresh(
        // shuffle so the fresh pick isn't always the first unseen one
        quotes.map((q) => q).sort(() => Math.random() - 0.5),
        seen,
        { max: 1, keyFn: (q) => q }
      );
      if (pick) {
        dailyQuote = pick;
        // Only record when serving fresh (see note above the notion_page record).
        if (!priorIsToday) await surfacedStore.record('daily_quote', pick);
      }
    }
  } catch (err) {
    console.error('[notionQuotes] failed:', err.message);
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
  }

  // Call Gemini with whatever data we have
  let geminiResult = null;
  try {
    // The LLM call can be slow; bound it so a stalled model doesn't hang the
    // briefing (it degrades to the data-only sections).
    geminiResult = await withTimeout(
      generateBriefing(emails, notionData.text, quoteData.quote, dayName, workout, calendar, wellbeingContext),
      Number(process.env.BRIEFING_LLM_TIMEOUT_MS || 90000),
      'gemini'
    );
  } catch (err) {
    console.error('[gemini] failed:', err.message);
    errors.push({ service: 'gemini', error: err.message });
  }

  // Surface the intelligence layer's current findings (from the last analysis).
  let insights = [];
  let wealthInsights = [];
  let healthInsights = [];
  let leverageActions = [];
  let forecasts = [];
  let recovery = null;
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
    const COMPOSITE_TYPES = ['recovery', 'sleep_debt', 'sleep_consistency', 'training_load'];
    const recoveryFinding = open.find((f) => f.type === 'recovery');
    if (recoveryFinding) {
      recovery = {
        score: recoveryFinding.evidence?.score ?? null,
        band: recoveryFinding.evidence?.band ?? null,
        parts: recoveryFinding.evidence?.parts ?? {},
        detail: recoveryFinding.detail,
      };
    }
    healthComposites = open
      .filter((f) => COMPOSITE_TYPES.includes(f.type) && f.type !== 'recovery')
      .map((f) => ({ type: f.type, title: f.title, detail: f.detail, evidence: f.evidence }));

    // Insights rotate: prefer ones not shown in the last 30 days so the card
    // stays fresh, falling back to the rest if you've seen them all. Composites
    // are excluded (shown live above).
    const insightPool = open.filter(
      (f) => f.type !== 'leverage' && f.type !== 'forecast' && !COMPOSITE_TYPES.includes(f.type)
    );
    const seenInsights = await surfacedStore.recentRefs('insight', 30);
    const chosen = surfacedStore.pickFresh(insightPool, seenInsights, { max: 6, keyFn: (f) => f.title });
    insights = chosen.map((f) => ({ type: f.type, title: f.title, detail: f.detail, confidence: f.confidence, domains: f.domains }));
    if (insights.length) await surfacedStore.record('insight', insights.map((i) => i.title));

    // Wealth/spending insights for the Wealth tab — spending patterns (this
    // month vs your usual) and over-budget categories (vs Monarch budgets).
    // Computed live from transaction data; falls back to nothing on failure.
    try {
      wealthInsights = await buildWealthInsights();
    } catch (err) {
      console.error('[wealthInsights] failed:', err.message);
    }

    // Health/wellbeing/habits findings for the Health tab.
    // Prioritize habit_split (habit-vs-health correlations) at the top since
    // they're the most actionable; fill remaining slots with other types.
    const healthPool = insightPool
      .filter((f) => Array.isArray(f.domains) && f.domains.some((dn) => ['health', 'wellbeing', 'habits'].includes(dn)));
    const habitSplits = healthPool.filter((f) => f.type === 'habit_split');
    const others = healthPool.filter((f) => f.type !== 'habit_split');
    healthInsights = [...habitSplits, ...others]
      .slice(0, 6)
      .map((f) => ({ type: f.type, title: f.title, detail: f.detail, confidence: f.confidence, domains: f.domains }));
  } catch (err) {
    console.error('[insights] failed:', err.message);
  }

  // Relevant-not-random: surface the library highlight that speaks to where
  // you are *internally* (mood/energy/focus + slipping habits), not your task
  // list — and never repeat one within 30 days. Falls back to the quote, then
  // to evergreen growth themes when there's no recent check-in data.
  let relevantHighlight = null;
  try {
    const theme = wellbeingTheme || quoteData.quote || 'presence, growth, resilience, gratitude';
    const [vec] = await withTimeout(llm.embed([theme]), EXT, 'embed');
    if (vec) {
      const hits = await documentsStore.searchSimilar(vec, { k: 25, domain: 'learning' });
      const seen = await surfacedStore.recentRefs('highlight', 30);
      const [pick] = surfacedStore.pickFresh(hits, seen, { max: 1, keyFn: (h) => h.id });
      if (pick) {
        relevantHighlight = { title: pick.title, author: pick.author, content: pick.content, url: pick.url };
        if (!priorIsToday) await surfacedStore.record('highlight', pick.id);
      }
    }
  } catch (err) {
    console.error('[relevantHighlight] failed:', err.message);
  }

  // Weekly goal achievement — current week's goals + prior week's with hit/miss.
  // Surfaced on the Insights tab so the check-in shows up immediately after saving.
  let weeklyGoals = null;
  try {
    const [currentInt, priorInt] = await Promise.all([
      intentionsStore.currentIntention(),
      intentionsStore.priorIntention(),
    ]);
    if (currentInt || priorInt) {
      weeklyGoals = { current: currentInt ?? null, prior: priorInt ?? null };
    }
  } catch (err) {
    console.error('[weeklyGoals] failed:', err.message);
  }

  // Latest weekly review (generated separately on a weekly cadence).
  let weeklyReview = null;
  try {
    const wr = await briefingsStore.latestBriefing('weekly');
    if (wr) weeklyReview = { ...wr.content, generatedAt: wr.generated_at };
  } catch (err) {
    console.error('[weeklyReview] failed:', err.message);
  }

  // Wealth snapshot for the Wealth tab (from the canonical spine — Monarch etc.).
  let wealth = null;
  try {
    const sum = (arr) => arr.reduce((s, r) => s + Number(r.value), 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const nw = await metricsStore.latest({ domain: 'wealth', metric: 'net_worth' });
    const nwPrev = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'net_worth', from: monthAgo, to: weekAgo, agg: 'avg', excludeSource: 'seed' });
    const spend = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending', from: weekAgo, agg: 'sum', excludeSource: 'seed' });
    const discretionary = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending_discretionary', from: weekAgo, agg: 'sum', excludeSource: 'seed' });
    const income = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'income', from: weekAgo, agg: 'sum', excludeSource: 'seed' });
    if (nw || spend.length) {
      const netWorth = nw ? Number(nw.value) : null;
      const priorNw = nwPrev.length ? sum(nwPrev) / nwPrev.length : null;
      wealth = {
        netWorth,
        netWorthChange: netWorth != null && priorNw ? Math.round((netWorth - priorNw)) : null,
        spendingThisWeek: Math.round(sum(spend)),
        // Discretionary = ex rent/mortgage; null when there's no such data yet.
        discretionaryThisWeek: discretionary.length ? Math.round(sum(discretionary)) : null,
        incomeThisWeek: Math.round(sum(income)),
        cashflowThisWeek: Math.round(sum(income) - sum(spend)),
      };
    }
  } catch (err) {
    console.error('[wealth] failed:', err.message);
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

  const response = {
    date: dateLabel,
    weather,
    workout,
    calendar,
    newsletters: geminiResult?.newsletters ?? [],
    urgentEmails: geminiResult?.urgentEmails ?? [],
    financeSummary: geminiResult?.financeSummary ?? [],
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
    wealthInsights,
    healthInsights,
    recovery,
    healthComposites,
    forecasts,
    weeklyGoals,
    relevantHighlight: keep(p?.relevantHighlight, relevantHighlight),
    weeklyReview,
    wealth,
    markets,
    dailyQuote: keep(p?.dailyQuote, dailyQuote),
    alerts,
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
    .then(() => analyze())
    .then((s) => {
      if (s) console.log(`[analyze] ${s.trends} trends, ${s.correlations} correlations, ${s.actions} actions`);
      // Propose experiments from unconfirmed correlations; evaluate due ones.
      return Promise.all([
        experiments.proposeExperiments().catch((e) => console.error('[propose]', e.message)),
        experiments.evaluateDue().catch((e) => console.error('[evaluate]', e.message)),
      ]);
    })
    .catch((err) => console.error('[ingest/analyze] failed:', err.message));
});

app.listen(PORT, () => {
  console.log(`NormOS backend running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
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
