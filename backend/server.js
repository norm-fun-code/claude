require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { fetchGmailThreads } = require('./src/services/gmail');
const { fetchCalendarEvents } = require('./src/services/calendar');
const { fetchRandomNotionPage } = require('./src/services/notion');
const { fetchRandomQuote } = require('./src/services/googleDoc');
const { fetchWeather } = require('./src/services/weather');
const { generateBriefing } = require('./src/services/gemini');
const { getTodayWorkout } = require('./src/services/workout');

const db = require('./src/db');
const metricsStore = require('./src/store/metrics');
const findingsStore = require('./src/store/findings');
const sourcesStore = require('./src/store/sources');
const { mapHealthPayload, SOURCE: HEALTH_SOURCE } = require('./src/ingest/health');
const { runIngest } = require('./src/ingest/run');
const { analyze } = require('./src/intelligence/analyze');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

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

// Generic canonical metric ingestion for any future source.
app.post('/api/ingest/metrics', async (req, res) => {
  try {
    const written = await metricsStore.insertMetrics(req.body);
    res.json({ written });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger all server-side connectors on demand.
app.post('/api/ingest/run', async (req, res) => {
  try {
    res.json({ results: await runIngest() });
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

// Run the intelligence layer (trends + correlations) on demand.
app.post('/api/analyze', async (req, res) => {
  try {
    res.json(await analyze());
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

  // Fetch all independent data sources in parallel
  const [weatherResult, calendarResult, notionResult, quoteResult, emailResult] =
    await Promise.allSettled([
      fetchWeather(),
      fetchCalendarEvents(),
      fetchRandomNotionPage(),
      fetchRandomQuote(),
      fetchGmailThreads(),
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
  const quoteData = unwrap(quoteResult, 'googleDoc') ?? { quote: '' };
  const emails = unwrap(emailResult, 'gmail') ?? [];

  // Call Gemini with whatever data we have
  let geminiResult = null;
  try {
    geminiResult = await generateBriefing(
      emails,
      notionData.text,
      quoteData.quote,
      dayName,
      workout,
      calendar
    );
  } catch (err) {
    console.error('[gemini] failed:', err.message);
    errors.push({ service: 'gemini', error: err.message });
  }

  // Surface the intelligence layer's current findings (from the last analysis).
  let insights = [];
  try {
    const open = await findingsStore.listFindings({ status: 'open' });
    insights = open
      .slice(0, 6)
      .map((f) => ({ type: f.type, title: f.title, detail: f.detail, confidence: f.confidence }));
  } catch (err) {
    console.error('[insights] failed:', err.message);
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
    insights,
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
      // Refresh findings once new data has landed.
      return analyze();
    })
    .then((s) => s && console.log(`[analyze] ${s.trends} trends, ${s.correlations} correlations`))
    .catch((err) => console.error('[ingest/analyze] failed:', err.message));
});

app.listen(PORT, () => {
  console.log(`NormOS backend running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
