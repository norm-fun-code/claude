require('dotenv').config();
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
const { runNudges } = require('./src/notify/run');
const surfacedStore = require('./src/store/surfaced');
const briefingsStore = require('./src/store/briefings');
const { runReview } = require('./src/intelligence/review');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Optional bearer-token auth. Off by default (fine for localhost); set
// NORMOS_API_TOKEN to require `Authorization: Bearer <token>` on every /api
// route except the health check — important if you ever host this on a VPS.
app.use('/api', (req, res, next) => {
  const token = process.env.NORMOS_API_TOKEN;
  if (!token || req.path === '/health') return next();
  const auth = req.get('authorization') || '';
  if (auth === `Bearer ${token}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

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
    const rows = mapHealthPayload(req.body, { ts: req.query.ts });
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
    const { metrics, document } = mapCheckin(req.body, { ts: req.query.ts });
    const written = await metricsStore.insertMetrics(metrics);
    if (document) await documentsStore.upsertDocument(document);
    await sourcesStore.markSync(CHECKIN_SOURCE);
    res.json({ written, journaled: Boolean(document) });
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
    const { metrics } = mapHabits(req.body, { ts: req.query.ts });
    const written = await metricsStore.insertMetrics(metrics);
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
// last 30 days (tracked in `surfaced`), so it cycles through your library.
app.get('/api/highlights', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);
    const favoritesOnly = req.query.favoritesOnly === '1' || req.query.favoritesOnly === 'true';
    const seen = await surfacedStore.recentRefs('highlight', 30);
    const rows = await documentsStore.randomHighlights({
      limit,
      favoritesOnly,
      exclude: [...seen],
    });
    // Record what we're showing so the next 30 days won't repeat them.
    if (rows.length) await surfacedStore.record('highlight', rows.map((r) => r.id));
    res.json({
      highlights: rows.map((r) => ({
        id: r.id,
        text: r.content,
        title: r.title,
        author: r.author,
        url: r.url,
        favorite: !!(r.metadata && r.metadata.favorite),
      })),
    });
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
    res.json({ nudges: await nudgesStore.listNudges({ limit: Number(req.query.limit) || 50 }) });
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
  const force = req.query.refresh === '1' || req.query.refresh === 'true';
  if (!force) {
    try {
      const cached = await briefingsStore.latestBriefing('daily');
      if (cached?.content && cached.generated_at) {
        const ageMin = (Date.now() - new Date(cached.generated_at).getTime()) / 60000;
        if (ageMin < CACHE_TTL_MIN) {
          return res.json({ ...cached.content, cached: true, cachedAgeMin: Math.round(ageMin) });
        }
      }
    } catch (err) {
      console.error('[briefing cache] read failed:', err.message);
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

  // Fetch all independent data sources in parallel
  const [weatherResult, calendarResult, notionResult, quoteResult, emailResult, marketsResult] =
    await Promise.allSettled([
      fetchWeather(),
      fetchCalendarEvents(),
      fetchRandomNotionPage({ exclude: [...seenNotion] }),
      fetchRandomQuote(),
      fetchGmailThreads(),
      fetchMarkets(),
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
  // Mark this Notion page as shown so it won't repeat for 30 days.
  if (notionData.pageTitle && notionData.pageTitle !== 'Notion') {
    surfacedStore.record('notion_page', notionData.pageTitle).catch(() => {});
  }
  const quoteData = unwrap(quoteResult, 'googleDoc') ?? { quote: '' };
  const emails = unwrap(emailResult, 'gmail') ?? [];
  const markets = unwrap(marketsResult, 'markets');

  // Quote of the day from the Notion "Quotes" page (each bullet = one quote).
  // No-repeat for 30 days so it cycles through all your quotes.
  let dailyQuote = null;
  try {
    const quotes = await fetchNotionQuotes();
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
        await surfacedStore.record('daily_quote', pick);
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
    // Habits trailing completion (which ones are slipping).
    const habitMetrics = ['gratitude', 'morning_tm', 'afternoon_tm', 'cold_shower', 'exercise', 'eat_healthy'];
    const habitLabels = { gratitude: 'gratitude', morning_tm: 'morning meditation', afternoon_tm: 'afternoon meditation', cold_shower: 'cold shower', exercise: 'exercise', eat_healthy: 'eating well' };
    const lagging = [];
    for (const m of habitMetrics) {
      const a = await avg('habits', m);
      if (a != null && a < 0.6) lagging.push(habitLabels[m] || m); // <60% adherence
    }
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
    geminiResult = await generateBriefing(
      emails,
      notionData.text,
      quoteData.quote,
      dayName,
      workout,
      calendar,
      wellbeingContext
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

    // Insights rotate: prefer ones not shown in the last 30 days so the card
    // stays fresh, falling back to the rest if you've seen them all.
    const insightPool = open.filter((f) => f.type !== 'leverage' && f.type !== 'forecast');
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
    healthInsights = insightPool
      .filter((f) => Array.isArray(f.domains) && f.domains.some((dn) => ['health', 'wellbeing', 'habits'].includes(dn)))
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
    const [vec] = await llm.embed([theme]);
    if (vec) {
      const hits = await documentsStore.searchSimilar(vec, { k: 25, domain: 'learning' });
      const seen = await surfacedStore.recentRefs('highlight', 30);
      const [pick] = surfacedStore.pickFresh(hits, seen, { max: 1, keyFn: (h) => h.id });
      if (pick) {
        relevantHighlight = { title: pick.title, author: pick.author, content: pick.content, url: pick.url };
        await surfacedStore.record('highlight', pick.id);
      }
    }
  } catch (err) {
    console.error('[relevantHighlight] failed:', err.message);
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
    const nwPrev = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'net_worth', from: monthAgo, to: weekAgo, agg: 'avg' });
    const spend = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending', from: weekAgo, agg: 'sum' });
    const income = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'income', from: weekAgo, agg: 'sum' });
    if (nw || spend.length) {
      const netWorth = nw ? Number(nw.value) : null;
      const priorNw = nwPrev.length ? sum(nwPrev) / nwPrev.length : null;
      wealth = {
        netWorth,
        netWorthChange: netWorth != null && priorNw ? Math.round((netWorth - priorNw)) : null,
        spendingThisWeek: Math.round(sum(spend)),
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

  const response = {
    date: dateLabel,
    weather,
    workout,
    calendar,
    newsletters: geminiResult?.newsletters ?? [],
    urgentEmails: geminiResult?.urgentEmails ?? [],
    financeSummary: geminiResult?.financeSummary ?? [],
    quoteInsight: geminiResult?.quoteInsight ?? '',
    notionInsight: geminiResult?.notionInsight ?? '',
    quote: quoteData.quote,
    notionText: notionData.text,
    notionPageTitle: notionData.pageTitle,
    leverageActions,
    insights,
    wealthInsights,
    healthInsights,
    forecasts,
    relevantHighlight,
    weeklyReview,
    wealth,
    markets,
    dailyQuote,
    alerts,
  };

  if (errors.length > 0) {
    response.errors = errors;
  }

  res.json(response);

  // Persist the briefing for history, and capture today's data into the spine.
  // Fire-and-forget: never let persistence failures affect the live response.
  db.query(
    `INSERT INTO briefings (kind, content) VALUES ('daily', $1)`,
    [response]
  ).catch((err) => console.error('[persist briefing] failed:', err.message));

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
