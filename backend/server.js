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

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
  };

  if (errors.length > 0) {
    response.errors = errors;
  }

  res.json(response);
});

app.listen(PORT, () => {
  console.log(`Morning Dashboard backend running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
