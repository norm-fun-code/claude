// Briefing router: the main /api/briefing builder (the core "chief of staff"
// synthesis over health/wealth/wisdom/calendar/email/markets data — the
// single largest and most complex route in the app), its mid-day live
// partial-refresh, the markets-only refresh, and the non-blocking rebuild
// trigger. Twenty-sixth (and final) router extraction out of server.js's
// monolith (see the engineering review's #1+#6 recommendation).
//
// This is moved VERBATIM — no internal restructuring. Only the outer
// route-registration boilerplate changed (app.METHOD -> router.METHOD,
// '/api/x' -> '/x', try/catch -> asyncHandler where the original had a
// single outer try/catch; the two CRON_SECRET-style helpers below keep
// their original shape since they had none). Every require('./src/...')
// became require('../...'). Verified via diff-multiset comparison against
// the original block before removing it from server.js.
const express = require('express');
const { withTimeout } = require('../util/async');
const { localDayBoundsUtc } = require('../util/date');
const { fetchCalendarEvents, fetchWorkBusyBlocks } = require('../services/calendar');
const { fetchRandomNotionPage, fetchNotionQuotes } = require('../services/notion');
const { fetchRandomQuote } = require('../services/googleDoc');
const { fetchWeather } = require('../services/weather');
const { fetchMarkets } = require('../services/markets');
const { generateChiefBrief, generateWisdomInsights } = require('../services/briefing-ai');
const { getTodayWorkout } = require('../services/workout');
const { buildWealthInsights } = require('../services/wealth-insights');
const metricsStore = require('../store/metrics');
const findingsStore = require('../store/findings');
const sourcesStore = require('../store/sources');
const { runIngest } = require('../ingest/run');
const { analyze, TREND_STALE_DAYS } = require('../intelligence/analyze');
const { embedPending } = require('../intelligence/embeddings');
const annotationsStore = require('../store/annotations');
const experimentsStore = require('../store/experiments');
const experiments = require('../intelligence/experiments');
const devicesStore = require('../store/devices');
const nudgesStore = require('../store/nudges');
const surfacedStore = require('../store/surfaced');
const briefingsStore = require('../store/briefings');
const recommendationsStore = require('../store/recommendations');
const intentionsStore = require('../store/intentions');
const lifeChaptersStore = require('../store/lifeChapters');
const { asyncHandler } = require('../middleware/asyncHandler');

// Fast, scoped context for POST /briefing/chief-brief/rebuild — recomputes
// only the cheap, side-effect-free, DB-only inputs generateChiefBrief reads,
// so a "just retry the brief text" tap takes seconds, not the full builder's
// 60-90s. Deliberately narrower than the main /briefing builder's context
// (see buildFullBriefingContext-equivalent block further down, which stays
// untouched/verbatim):
//  - calendar/workBusy/emails are reused from the last full build rather than
//    refetched (no external API calls here at all) — they rarely change
//    tap-to-tap, and a full "Rebuild briefing" still refreshes them.
//  - leverageContext is DERIVED from the already-persisted
//    prior.content.leverageActions/forecasts rather than re-querying findings
//    and re-running the main builder's recommendation-ledger dedup/logging —
//    that logging is a write with its own 7-day dedup semantics and must only
//    run from a real full build, not every quick-retry tap.
//  - continuityContext (has a similar write side effect, in curate.js's
//    first-seen tracking) and cashflowContext/progressContext (both
//    Monday-only anyway, and cashflow needs a live Monarch MCP round-trip)
//    are skipped — empty string, same as any other day they don't apply.
// Net effect: a slightly less rich prompt than the full builder's, in
// exchange for being fast and free of write side effects. If this proves
// valuable, the shared pieces are candidates to extract into one function
// both routes call — noted here rather than done blind under time pressure.
async function buildQuickChiefBriefContext(prior) {
  const tz = process.env.TZ || 'America/New_York';
  const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const workout = getTodayWorkout();
  const calendar = prior.content?.calendar ?? [];
  const workBusy = prior.content?.workBusy ?? [];

  const [
    wellbeingContext,
    annotationsAndGapsContext,
    recoveryContext,
    experimentsContext,
    selfModel,
    strengthContext,
    spendingContext,
    weeklyGoalsContext,
    chaptersContext,
  ] = await Promise.all([
    (async () => {
      try {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const avg = async (domain, metric) => {
          const r = await metricsStore.dailyAggregate({ domain, metric, from: since, agg: 'avg' });
          const vals = r.map((x) => Number(x.value)).filter(Number.isFinite);
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        };
        const binaryHabits = ['gratitude', 'morning_tm', 'afternoon_tm', 'cold_shower', 'exercise'];
        const habitLabels = { gratitude: 'gratitude', morning_tm: 'morning meditation', afternoon_tm: 'afternoon meditation', cold_shower: 'cold shower', exercise: 'exercise', eat_healthy: 'eating well' };
        const [mood, energy, focus, ...habitAvgs] = await Promise.all([
          avg('wellbeing', 'mood'), avg('wellbeing', 'energy'), avg('wellbeing', 'focus'),
          ...binaryHabits.map((m) => avg('habits', m)),
          avg('habits', 'eat_healthy'),
        ]);
        const lagging = [];
        binaryHabits.forEach((m, i) => { if (habitAvgs[i] != null && habitAvgs[i] < 0.6) lagging.push(habitLabels[m]); });
        const eatAvg = habitAvgs[binaryHabits.length];
        if (eatAvg != null && eatAvg < 3) lagging.push(habitLabels.eat_healthy);
        const { wellbeingLevel } = require('../intelligence/catalog');
        const parts = [];
        if (mood != null) parts.push(`mood ${wellbeingLevel(mood)}`);
        if (energy != null) parts.push(`energy ${wellbeingLevel(energy)}`);
        if (focus != null) parts.push(`focus ${wellbeingLevel(focus)}`);
        if (lagging.length) parts.push(`slipping on ${lagging.slice(0, 3).join(', ')}`);
        return parts.join('; ');
      } catch (err) {
        console.error('[quick chief-brief] wellbeing context failed:', err.message);
        return '';
      }
    })(),
    (async () => {
      let ctx = '';
      try {
        const { start: startOfToday } = localDayBoundsUtc(process.env.TZ || 'America/New_York');
        const active = await annotationsStore.overlapping(startOfToday, new Date());
        if (active.length) {
          ctx = active
            .map((a) => `${a.label}${a.note ? ` (${a.note})` : ''}`)
            .slice(0, 5)
            .join('; ');
        }
      } catch (err) {
        console.error('[quick chief-brief] annotations context failed:', err.message);
      }
      try {
        const { describeDataGaps } = require('../intelligence/source-health');
        const allSources = await sourcesStore.listSources();
        const gaps = describeDataGaps(allSources);
        if (gaps.length) {
          const warning = `DATA GAPS — these sources have not synced recently: ${gaps.join('; ')}. Caveat any claims that rely on this data.`;
          ctx = ctx ? `${ctx}; ${warning}` : warning;
        }
      } catch (err) {
        console.error('[quick chief-brief] pipeline health failed:', err.message);
      }
      return ctx;
    })(),
    (async () => {
      try {
        const recovery = await require('../intelligence/recovery').liveRecovery();
        if (recovery?.score == null) {
          return 'UNAVAILABLE — Eight Sleep device not worn recently. Do NOT reference HRV, resting heart rate, or recovery score in today\'s brief.';
        }
        let ctx = `score ${recovery.score}/100 (${recovery.band ?? 'unknown'} band)`;
        if (recovery.rawHrv != null) ctx += `, HRV ${Math.round(recovery.rawHrv)}ms`;
        if (recovery.rawRhr != null) ctx += `, RHR ${Math.round(recovery.rawRhr)}bpm`;
        if (recovery.proxy) ctx += ' — SELF-REPORTED (no Eight Sleep reading last night; this is a subjective estimate, not a real HRV/RHR measurement).';
        return ctx;
      } catch (err) {
        console.error('[quick chief-brief] recovery context failed:', err.message);
        return '';
      }
    })(),
    (async () => {
      try {
        const allExps = await experimentsStore.listExperiments();
        const lines = [];
        for (const e of allExps.filter((e) => e.status === 'running').slice(0, 4)) lines.push(`⟳ Running: ${e.hypothesis}`);
        for (const e of allExps.filter((e) => e.status === 'paused').slice(0, 3)) lines.push(`⏸ Paused by the user: ${e.hypothesis} — do not reference as active, running, or logging`);
        return lines.join('\n');
      } catch (err) {
        console.error('[quick chief-brief] experiments context failed:', err.message);
        return '';
      }
    })(),
    (async () => {
      try {
        let text = (await require('../store/selfModel').latestModelText()) ?? '';
        text = text.replace(/^WEALTH:.*$/m, (line) => {
          const spend = line.match(/MTD[^$]*spending \$[\d,]+(?: \(excludes[^)]*\))?/);
          return spend ? `WEALTH: ${spend[0]}` : '';
        });
        return text;
      } catch (err) {
        console.error('[quick chief-brief] selfModel failed:', err.message);
        return '';
      }
    })(),
    require('../intelligence/strength-progression').topProgressionNote({ days: 45, minSessions: 3 }).catch(() => ''),
    (async () => {
      try {
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
        const recentSpend = yestTotal > 0 ? yestTotal : null;
        const spendBaseline = baselineRows.length >= 7
          ? baselineRows.reduce((s, r) => s + Number(r.value || 0), 0) / baselineRows.length
          : null;
        if (recentSpend != null && spendBaseline != null && spendBaseline > 10 && recentSpend > spendBaseline * 1.8) {
          const mult = (recentSpend / spendBaseline).toFixed(1);
          return `Discretionary spending yesterday was $${Math.round(recentSpend)} vs a $${Math.round(spendBaseline)}/day average (${mult}× normal).`;
        }
        return '';
      } catch (err) {
        console.error('[quick chief-brief] spending context failed:', err.message);
        return '';
      }
    })(),
    (async () => {
      try {
        const [currentInt] = await Promise.all([intentionsStore.currentIntention()]);
        const goals = currentInt?.goals ?? [];
        if (!goals.length) return '';
        const done = goals.filter((g) => g.achieved).map((g) => `[done] ${g.text}`);
        const open = goals.filter((g) => !g.achieved).map((g) => `[OPEN] ${g.text}`);
        return `${[...open, ...done].join(' · ')}` + (currentInt?.context ? ` (week context: "${String(currentInt.context).slice(0, 300)}")` : '');
      } catch (err) {
        console.error('[quick chief-brief] weeklyGoals context failed:', err.message);
        return '';
      }
    })(),
    (async () => {
      try {
        const chapters = await lifeChaptersStore.listActive();
        return require('../intelligence/chapters').composeChapterContext(chapters);
      } catch (err) {
        console.error('[quick chief-brief] chapters context failed:', err.message);
        return '';
      }
    })(),
  ]);

  // Derived from persisted output, not a fresh findings query — see the
  // function header comment for why (avoids re-running the leverage
  // engine's recommendation-ledger side effects on every quick-retry tap).
  const lev = (prior.content?.leverageActions ?? []).map((f, i) => `${i + 1}. ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
  const risks = (prior.content?.forecasts ?? [])
    .filter((f) => f.status === 'off_track' || f.status === 'at_risk')
    .slice(0, 2)
    .map((f) => `- ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
  const leverageParts = [];
  if (lev.length) leverageParts.push(`HIGHEST-LEVERAGE ACTIONS (leverage engine):\n${lev.join('\n')}`);
  if (risks.length) leverageParts.push(`TRENDING WRONG (at-risk forecasts):\n${risks.join('\n')}`);

  let dayOffContext = '';
  try {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    dayOffContext = require('../util/dayContext').describeDayOff(todayStr);
  } catch { /* non-critical */ }

  return {
    emails: [], // raw email list isn't persisted; urgentEmails is carried over as-is by the caller instead
    dayName,
    workout,
    calendar,
    workBusy,
    wellbeingContext,
    annotationsContext: annotationsAndGapsContext,
    recoveryContext,
    experimentsContext,
    selfModel,
    leverageContext: leverageParts.join('\n\n'),
    strengthContext,
    spendingContext,
    continuityContext: '', // has write side effects in the full builder — skipped here, see header comment
    cashflowContext: '', // Monday-only + a live Monarch round-trip — skipped for speed
    progressContext: '', // Monday-only — skipped for speed
    weeklyGoalsContext,
    chaptersContext,
    dayOffContext,
  };
}

function createBriefingRouter({ port }) {
  const router = express.Router();

router.get('/briefing/live', asyncHandler(async (req, res) => {
    const prior = await briefingsStore.latestBriefing('daily');
    if (!prior?.content) {
      return res.status(409).json({ error: 'no briefing built yet — load the briefing first' });
    }

    const EXT = Number(process.env.BRIEFING_SOURCE_TIMEOUT_MS || 12000);
    const [marketsResult, weatherResult, calendarResult, workBusyResult] = await Promise.allSettled([
      withTimeout(fetchMarkets(), EXT * 3, 'markets'), // includes its own small LLM brief
      withTimeout(fetchWeather(), EXT, 'weather'),
      withTimeout(fetchCalendarEvents(), EXT, 'calendar'),
      withTimeout(fetchWorkBusyBlocks(), EXT, 'workCalendar'),
    ]);
    const markets = marketsResult.status === 'fulfilled' ? marketsResult.value : null;
    const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : null;
    const calendar = calendarResult.status === 'fulfilled' ? calendarResult.value : null;
    const workBusy = workBusyResult.status === 'fulfilled' ? workBusyResult.value : null;

    const content = {
      ...prior.content,
      ...(markets ? { markets } : {}),
      ...(weather ? { weather } : {}),
      ...(calendar ? { calendar } : {}),
      ...(workBusy ? { workBusy } : {}),
      liveRefreshedAt: new Date().toISOString(),
    };

    briefingsStore
      .saveBriefing({ kind: 'daily', content })
      .catch((err) => console.error('[briefing live] save failed:', err.message));

    res.json({ ...content, cached: false });
}));

router.post('/briefing/markets', asyncHandler(async (req, res) => {
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
}));

// Fast, scoped retry for JUST the Chief-of-Staff card — added after a live
// silent-fallback bug (see briefing-ai.js's shape-validation logging and the
// chiefBriefStale flag below) kept showing yesterday's brief with no way to
// force a quick re-try short of the full 60-90s rebuild. Recomputes only the
// context generateChiefBrief needs (see buildQuickChiefBriefContext above)
// and touches ONLY chiefBrief/morningFocus/chiefBriefStale in the saved
// content — every other field (weather, wealth, insights, etc.) is untouched.
router.post('/briefing/chief-brief/rebuild', asyncHandler(async (req, res) => {
  const prior = await briefingsStore.latestBriefing('daily');
  if (!prior?.content) {
    return res.status(409).json({ error: 'no briefing built yet — load the briefing first' });
  }

  const ctx = await buildQuickChiefBriefContext(prior);
  const chiefResult = await generateChiefBrief(
    ctx.emails, ctx.dayName, ctx.workout, ctx.calendar, ctx.wellbeingContext, ctx.annotationsContext,
    ctx.recoveryContext, ctx.experimentsContext, ctx.selfModel, ctx.leverageContext, ctx.workBusy,
    ctx.strengthContext, ctx.spendingContext, ctx.continuityContext, ctx.cashflowContext,
    ctx.progressContext, ctx.weeklyGoalsContext, ctx.chaptersContext, ctx.dayOffContext
  );

  const chiefBriefStale = chiefResult.chiefBrief == null;
  const errors = Array.isArray(prior.content.errors) ? prior.content.errors.filter((e) => e.service !== 'chiefBrief') : [];
  if (chiefBriefStale) {
    console.error('[chief-brief rebuild] still invalid after the scoped retry — keeping the existing card.');
    errors.push({ service: 'chiefBrief', error: 'invalid or missing shape from the LLM (after a retry); showing the previous build\'s brief' });
  }

  const content = {
    ...prior.content,
    chiefBrief: chiefResult.chiefBrief ?? prior.content.chiefBrief ?? null,
    morningFocus: chiefResult.morningFocus || prior.content.morningFocus || '',
    chiefBriefStale,
    errors,
    // Match the full builder: builtAt always advances to "now" whether or not
    // chiefBrief itself refreshed — it means "when was this response
    // produced," not "when did the content last change." Without this the
    // card's "Built X ago" label kept showing the ORIGINAL build's timestamp
    // after a failed retry, on top of an already-confusing silent failure —
    // looking like the tap did nothing at all instead of a retry that ran and
    // came back invalid again.
    builtAt: new Date().toISOString(),
  };
  briefingsStore
    .saveBriefing({ kind: 'daily', content })
    .catch((err) => console.error('[chief-brief rebuild] save failed:', err.message));

  res.json({ ...content, cached: false });
}));

// Postgres advisory lock (not an in-memory boolean) so "is a rebuild already
// running" is answered correctly across replicas, not just within this one
// process — an in-memory flag is invisible to a sibling instance, so two
// replicas could each start their own 60-90s rebuild concurrently. Arbitrary
// lock id; just needs to not collide with another feature's (see
// scheduler.js's LEADER_LOCK_ID = 727001).
const REBUILD_LOCK_ID = 727002;
router.post('/briefing/rebuild', asyncHandler(async (req, res) => {
  const triggeredAt = new Date().toISOString();
  const client = await require('../db').pool.connect();
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [REBUILD_LOCK_ID]);
  if (!rows[0].acquired) {
    client.release();
    return res.json({ started: false, alreadyRunning: true, triggeredAt });
  }
  res.json({ started: true, triggeredAt });

  const release = async () => {
    try { await client.query('SELECT pg_advisory_unlock($1)', [REBUILD_LOCK_ID]); } catch { /* connection may already be gone */ }
    try { client.release(); } catch { /* already released */ }
  };

  const http = require('http');
  const token = process.env.NORMOS_API_TOKEN || '';
  const r = http.request(
    {
      hostname: 'localhost',
      port,
      path: '/api/briefing?refresh=1',
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
    (resp) => {
      resp.resume(); // drain response body to free the socket
      resp.on('end', release);
    }
  );
  r.on('error', (err) => {
    console.error('[bg rebuild] loopback failed:', err.message);
    release();
  });
  r.setTimeout(200000, () => { r.destroy(); release(); });
  r.end();
}));

router.get('/briefing', asyncHandler(async (req, res) => {
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
      const dismissedInsights = require('../store/dismissedInsights');
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
      const freshRecovery = await require('../intelligence/recovery').liveRecovery();
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
  // Weekend / US-holiday awareness so a day off (e.g. Friday of the July 4th
  // weekend) isn't framed as a packed workday with "meeting load" risk.
  const dayOffContext = (() => {
    try {
      const tz = process.env.TZ || 'America/New_York';
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
      return require('../util/dayContext').describeDayOff(todayStr);
    } catch { return ''; }
  })();

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

  let analyzeOk = false;
  try {
    await analyze();
    analyzeOk = true;
  } catch (err) {
    console.error('[briefing build] intelligence refresh failed:', err.message);
  }

  // Cross-context insights need the fresh correlation findings analyze() just
  // wrote, but touch nothing else in the source fetch below (weather/calendar/
  // notion/email/markets) — kick it off here and run it CONCURRENTLY with that
  // fetch instead of serially before it, so its LLM call's latency is hidden
  // behind the ~12s bounded fetch rather than adding to the critical path.
  // consolidate() still runs after it resolves (below), preserving the original
  // analyze -> crossContext -> consolidate ordering; only crossContext's LLM call
  // itself moves off the critical path.
  // Tracks success separately from the promise itself (rather than swallowing
  // the error into a `null` return) so consolidate() below can replicate the
  // ORIGINAL single-try/catch behavior exactly: skip consolidate() if EITHER
  // analyze() or crossContext generation failed, not just analyze().
  let crossContextOk = false;
  const crossContextPromise = analyzeOk
    ? require('../intelligence/crossContext').generateCrossContext()
        .then((v) => { crossContextOk = true; return v; })
        .catch((err) => { console.error('[briefing build] crossContext regen failed:', err.message); return null; })
    : Promise.resolve(null);

  // Workout is synchronous — no failure path
  const workout = getTodayWorkout();

  // Notion wisdom page: avoid repeating one shown in the last 30 days.
  const seenNotion = await surfacedStore.recentRefs('notion_page', 30).catch(() => new Set());

  // Fetch all independent data sources in parallel. Each is bounded by a hard
  // timeout so one slow upstream (Notion/etc.) can't hang the whole
  // briefing — allSettled waits for every promise, so without this a single
  // stall blocks the response. A timed-out source just shows as a soft error.
  const EXT = Number(process.env.BRIEFING_SOURCE_TIMEOUT_MS || 12000);
  const [weatherResult, calendarResult, workBusyResult, notionResult, quoteResult, marketsResult] =
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
  // Gmail is no longer fetched (removed with the newsletter-summary feature);
  // generateChiefBrief still accepts an emailData param and its urgentEmails
  // schema field, so this always resolves to an empty array rather than
  // threading a removed feature's absence through every call site.
  const emails = [];
  const markets = unwrap(marketsResult, 'markets');

  // Now that the source fetch above is done, make sure crossContext (kicked off
  // concurrently with it) has actually finished before consolidate() reads its
  // findings — preserves the original analyze -> crossContext -> consolidate order.
  await crossContextPromise;
  if (analyzeOk && crossContextOk) {
    try {
      await require('../intelligence/consolidate').consolidate({ kind: 'briefing' });
    } catch (err) {
      console.error('[briefing build] consolidate failed:', err.message);
    }
  }

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
    // Habits trailing completion (which ones are slipping). The five binary
    // habits are 0/1 (flag <60% adherence); eat_healthy is a 1–5 score, so it
    // needs its own threshold (flag when averaging below ~3/5) — checking it
    // against 0.6 like the binaries meant it could never flag.
    const binaryHabits = ['gratitude', 'morning_tm', 'afternoon_tm', 'cold_shower', 'exercise'];
    const habitLabels = { gratitude: 'gratitude', morning_tm: 'morning meditation', afternoon_tm: 'afternoon meditation', cold_shower: 'cold shower', exercise: 'exercise', eat_healthy: 'eating well' };
    // All 9 lookups (mood/energy/focus + 5 binary habits + eat_healthy) are
    // independent DB round-trips — batch them into one Promise.all instead of
    // 3 parallel + 6 serial awaits.
    const [mood, energy, focus, ...habitAvgs] = await Promise.all([
      avg('wellbeing', 'mood'), avg('wellbeing', 'energy'), avg('wellbeing', 'focus'),
      ...binaryHabits.map((m) => avg('habits', m)),
      avg('habits', 'eat_healthy'),
    ]);
    const lagging = [];
    binaryHabits.forEach((m, i) => {
      const a = habitAvgs[i];
      if (a != null && a < 0.6) lagging.push(habitLabels[m]); // <60% adherence
    });
    const eatAvg = habitAvgs[binaryHabits.length];
    if (eatAvg != null && eatAvg < 3) lagging.push(habitLabels.eat_healthy); // below ~3/5
    const parts = [];
    const themes = [];
    // Shared wording (low/ok/high) with the self-model and every other surface
    // that narrates these — never the raw "2.6/5" figure.
    const { wellbeingLevel } = require('../intelligence/catalog');
    if (mood != null) { parts.push(`mood ${wellbeingLevel(mood)}`); if (wellbeingLevel(mood) === 'low') themes.push('contentment, perspective, equanimity'); }
    if (energy != null) { parts.push(`energy ${wellbeingLevel(energy)}`); if (wellbeingLevel(energy) === 'low') themes.push('rest, restoration, sustainable effort'); }
    if (focus != null) { parts.push(`focus ${wellbeingLevel(focus)}`); if (wellbeingLevel(focus) === 'low') themes.push('presence, deep work, single-tasking, attention'); }
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
    const { start: startOfToday } = localDayBoundsUtc(process.env.TZ || 'America/New_York');
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
    recovery = await require('../intelligence/recovery').liveRecovery();
    if (recovery?.score != null) {
      recoveryContext = `score ${recovery.score}/100 (${recovery.band ?? 'unknown'} band)`;
      // rawHrv/rawRhr are actual measurements (ms / bpm), not the 0-100 score components.
      if (recovery.rawHrv != null) recoveryContext += `, HRV ${Math.round(recovery.rawHrv)}ms`;
      if (recovery.rawRhr != null) recoveryContext += `, RHR ${Math.round(recovery.rawRhr)}bpm`;
      // A proxy score is self-reported (no Eight Sleep reading last night) — the
      // UNAVAILABLE branch below only catches the no-data-at-all case, so a
      // proxy score was slipping through with no caveat, narrated as
      // confidently as a real overnight HRV reading. Flag it explicitly so the
      // brief doesn't build a causal "pattern confirmed" story off a subjective
      // 1-5 self-report.
      if (recovery.proxy) {
        recoveryContext += ' — SELF-REPORTED (no Eight Sleep reading last night; this is a subjective estimate, not a real HRV/RHR measurement). Do NOT narrate this with the same confidence as a real overnight reading, and do NOT claim it "confirms" or is the "cleanest proof yet" of any sleep/HRV pattern — at most note it\'s a rough read.';
      }
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
    const preBriefSignals = require('../intelligence/pre-brief-signals');
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
    // Tomorrow's work calendar — so a long / all-day block the next day (an OOO,
    // a travel day, a wall of meetings) can prompt "what's going on there?" the
    // day PRIOR, giving the user a chance to add context before that brief.
    let tomorrowWorkBusy = [];
    try {
      const tmr = new Date(Date.now() + 24 * 60 * 60 * 1000);
      tomorrowWorkBusy = await require('../services/calendar').fetchWorkBusyBlocks({ date: tmr });
    } catch { /* non-critical */ }
    const allSignals = preBriefSignals.buildSignals({
      recovery, calendar, workBusy, spend: recentSpend, spendBaseline, tomorrowWorkBusy,
    });
    signals = preBriefSignals.selectQuestions(allSignals, 2);
  } catch (err) {
    console.error('[pre-brief-signals] failed:', err.message);
  }

  // Ongoing experiments — running/paused hypotheses, so the brief can casually
  // reference "still gathering data on X" instead of the topic going silent
  // between proposal and verdict (fresh completed verdicts are already handled
  // loudly by continuityContext above). Re-enabled after being paused for data-
  // quality reasons: a RUNNING experiment is only described as actively
  // tracking when its underlying metric genuinely has recent data — otherwise
  // it's flagged as stalled so the brief never narrates a disconnected device
  // (e.g. Eight Sleep) as "still logging."
  let experimentsContext = '';
  // Same staleness bar as analyze.js's trend suppression (computeTrends) — one
  // shared constant so the Health tab and the brief's own narration can't
  // disagree about whether the same metric's data still counts as current.
  const EXPERIMENT_STALE_DAYS = TREND_STALE_DAYS;
  try {
    const allExps = await experimentsStore.listExperiments();
    const runningExps = allExps.filter((e) => e.status === 'running').slice(0, 4);
    const pausedExps = allExps.filter((e) => e.status === 'paused').slice(0, 3);

    // Each experiment's freshness check is an independent DB read — batch them
    // instead of awaiting one at a time inside the loop.
    const lasts = await Promise.all(runningExps.map((e) => {
      const [domain, metric] = String(e.metric || '').split(':');
      return domain && metric ? metricsStore.latest({ domain, metric }).catch(() => null) : null;
    }));

    const lines = [];
    runningExps.forEach((e, i) => {
      const [domain, metric] = String(e.metric || '').split(':');
      let note = '';
      if (domain && metric) {
        const last = lasts[i];
        const ageDays = last ? Math.floor((Date.now() - new Date(last.ts).getTime()) / 864e5) : null;
        if (ageDays == null || ageDays > EXPERIMENT_STALE_DAYS) {
          note = ` — NO FRESH DATA (${ageDays == null ? 'none ever' : `${ageDays}d old`}); do NOT say this is actively tracking or "still logging," at most note it's stalled`;
        }
      }
      const daysLeft = e.end_date
        ? Math.max(0, Math.ceil((new Date(e.end_date) - Date.now()) / 86400000))
        : null;
      lines.push(`⟳ Running: ${e.hypothesis}${daysLeft != null ? ` (${daysLeft}d left)` : ''}${note}`);
    });
    for (const e of pausedExps) {
      lines.push(`⏸ Paused by the user: ${e.hypothesis} — do not reference as active, running, or logging`);
    }
    if (lines.length) experimentsContext = lines.join('\n');
  } catch (err) {
    console.error('[experiments context] failed:', err.message);
  }

  // Self-model: nightly-consolidated portrait of the user — injected into the
  // briefing prompt so the chief-of-staff voice knows who it's talking to.
  let selfModel = '';
  try {
    selfModel = (await require('../store/selfModel').latestModelText()) ?? '';
    // The daily brief shouldn't surface net worth (it's noise day-to-day and the
    // LLM kept forcing nonsensical "net worth tied to your work" ties). Strip the
    // net-worth figure from the WEALTH line for the brief only — keep MTD spending
    // so genuine spending insights still flow. The full model keeps net worth for
    // other surfaces (Ask, wealth tab).
    selfModel = selfModel.replace(/^WEALTH:.*$/m, (line) => {
      const spend = line.match(/MTD[^$]*spending \$[\d,]+(?: \(excludes[^)]*\))?/);
      return spend ? `WEALTH: ${spend[0]}` : '';
    });
  } catch (err) {
    console.error('[selfModel] failed:', err.message);
  }

  // Pipeline health: inject a data-gap warning into annotationsContext when a
  // critical connector hasn't synced recently. The LLM sees this and caveats
  // stale-data claims; avoids confidently citing week-old numbers.
  try {
    const { describeDataGaps } = require('../intelligence/source-health');
    const allSources = await sourcesStore.listSources();
    const gaps = describeDataGaps(allSources);
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
    const curateLib = require('../intelligence/curate');
    const candidates = openFindingsForBrief.filter((f) => NARRATABLE.has(f.type));
    const sigs = candidates.map(curateLib.signature);
    const firstSeenBySig = await curateLib.recordAndLoadFirstSeen(sigs).catch(() => new Map());
    const now = Date.now();
    const topStreaks = candidates
      .map((f) => {
        const first = firstSeenBySig.get(curateLib.signature(f));
        const days = first ? Math.floor((now - new Date(first).getTime()) / 864e5) : 0;
        return { f, days };
      })
      .filter((x) => x.days >= 3)
      .sort((a, b) => b.days - a.days)
      .slice(0, 4);
    // A correlation/trend finding stays legitimately "open" for as long as the
    // relationship keeps holding — but if its underlying metric is night-sourced
    // (Eight Sleep) and hasn't posted in days, "open N days running" reads as
    // "still actively measuring" when nothing has actually been measured lately.
    // Flag it so the brief says "stalled," not "quietly measuring in the background."
    const { NIGHT_METRICS, staleDays, TREND_STALE_DAYS } = require('../intelligence/analyze');
    const todayKeyForStreaks = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const streaks = await Promise.all(topStreaks.map(async (x) => {
      const keys = x.f.evidence?.metric
        ? [x.f.evidence.metric]
        : [x.f.evidence?.a, x.f.evidence?.b].filter(Boolean);
      const nightKeys = keys.filter((k) => NIGHT_METRICS.has(k));
      let staleNote = '';
      if (nightKeys.length) {
        const ages = await Promise.all(nightKeys.map(async (k) => {
          const [domain, metric] = k.split(':');
          const series = await metricsStore.dailyAggregate({ domain, metric, from: new Date(Date.now() - 30 * 864e5) }).catch(() => []);
          return staleDays(series, todayKeyForStreaks);
        }));
        const maxAge = ages.filter((a) => a != null).sort((a, b) => b - a)[0] ?? null;
        if (maxAge != null && maxAge > TREND_STALE_DAYS) {
          staleNote = ` — STALLED: no fresh reading in ${maxAge}d; describe this as stalled/paused, NOT as actively measuring or "still logging"`;
        }
      }
      return `- ${x.f.title} — open ${x.days} days running${staleNote} (this isn't new; if it's today's lead, name the streak and escalate rather than re-explaining it)`;
    }));

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
      const startOfTodayUtc = new Date(require('../util/date').naiveToUtcIso(`${todayLocalDateStr}T00:00:00`, tz));
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
      const upcoming = require('../services/workout').getUpcomingWorkouts(3);
      periodizationLine = require('../intelligence/periodization').computePeriodizationNote({ upcoming, acwrBand });
    } catch (err) {
      console.error('[periodization] failed:', err.message);
    }

    const parts = [];
    if (streaks.length) parts.push(`PERSISTENT ISSUES (from the novelty ledger):\n${streaks.join('\n')}`);
    if (lastActionLine) parts.push(lastActionLine);
    if (calibrationLine) parts.push(calibrationLine);
    // Fresh experiment verdicts — the payoff of a multi-week self-test lands
    // LOUDLY in the next brief instead of sitting silently in the experiments
    // list. Fresh = concluded within the last 2 days (verdicts land on end_date).
    try {
      const allExps = await require('../store/experiments').listExperiments({ status: 'completed' });
      const fresh = (allExps || []).filter((e) => {
        if (!e.verdict || !e.end_date) return false;
        const end = new Date(typeof e.end_date === 'string' ? `${e.end_date}T12:00:00Z` : e.end_date);
        return Date.now() - end.getTime() < 2 * 864e5;
      }).slice(0, 2);
      for (const e of fresh) {
        const icon = e.verdict === 'confirmed' ? 'CONFIRMED ✓' : e.verdict === 'refuted' ? 'REFUTED ✗' : 'INCONCLUSIVE ~';
        const pct = e.result?.pctChange != null ? ` — ${e.result.pctChange > 0 ? '+' : ''}${Math.round(e.result.pctChange * 100)}% on ${e.metric}` : '';
        parts.push(
          `EXPERIMENT VERDICT (fresh — this is the payoff of a multi-week self-test; announce it prominently today, in plain words): ${icon}: "${e.hypothesis}"${pct}. ` +
            (e.verdict === 'confirmed'
              ? 'This is now PROVEN on their own data — going forward it is a fact about them, not a suggestion.'
              : e.verdict === 'refuted'
                ? 'Their own data says this one does not work for them — respect the result and do not re-pitch it.'
                : 'The data could not decide — say so honestly; a longer or cleaner test is a fair next step.')
        );
      }
    } catch { /* verdict announcement is best-effort */ }
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
    // Deduplicated over a 7-day window two ways: dedup_key (the finding's stable
    // basis identity — kind + lever/outcome — survives the TITLE COPY being
    // reworded later, e.g. "Best sleep nights → 13% better HRV" becoming
    // "Best sleep nights lift your next-day HRV" should still count as the same
    // insight) and NUMBER-NORMALIZED title (catches percentage-only variations
    // and chat-surfaced recs that have no basis to key off of). A per-run guard
    // also blocks two findings that collapse the same from both landing in one
    // briefing.
    if (levFindings.length) {
      Promise.all([recommendationsStore.recentTitles(7), recommendationsStore.recentDedupKeys(7)])
        .then(([recent, recentKeys]) => {
        const recentNorm = new Set([...recent].map(recommendationsStore.normalizeRecTitle));
        const seenThisRun = new Set();
        const seenKeysThisRun = new Set();
        for (const f of levFindings) {
          const ev = f.evidence || {};
          const dedupKey = ev.dedupKey ?? null;
          const normKey = recommendationsStore.normalizeRecTitle(f.title);
          if (dedupKey && (recentKeys.has(dedupKey) || seenKeysThisRun.has(dedupKey))) continue;
          if (recentNorm.has(normKey) || seenThisRun.has(normKey)) continue;
          seenThisRun.add(normKey);
          if (dedupKey) seenKeysThisRun.add(dedupKey);
          // recordRecommendation auto-links a follow-up commitment itself when
          // there's no outcomeMetric to auto-measure against.
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
            dedupKey,
            commitmentSource: 'brief',
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
    strengthContext = (await require('../intelligence/strength-progression')
      .topProgressionNote({ days: 45, minSessions: 3 })) || '';
  } catch { /* non-critical */ }

  // Forward-looking cashflow: unlike the spending-anomaly check above (which
  // reports on what already happened), this looks at Monarch's recurring-bill
  // forecast for what's ABOUT to hit, so the brief can warn before the balance
  // drops rather than after. Best-effort and bounded — Monarch's MCP round-trip
  // must never hold up the rest of the briefing.
  let cashflowContext = '';
  try {
    const monarchWealth = require('../services/monarch-wealth');
    if (monarchWealth.isConfigured()) {
      const [recurring, accountsData] = await Promise.all([
        withTimeout(monarchWealth.getRecurring(), EXT, 'monarchRecurring').catch(() => null),
        withTimeout(monarchWealth.getAccounts(), EXT, 'monarchAccounts').catch(() => null),
      ]);
      if (recurring) {
        const { computeCashflowLookahead } = require('../intelligence/cashflow-lookahead');
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
      progressContext = await require('../intelligence/progress').computeProgressContext();
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
    chaptersContext = require('../intelligence/chapters').composeChapterContext(chapters);
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

  // Call the two independent LLM sections in PARALLEL (chief-brief and the
  // quote/Notion "wisdom" reflection used to be one combined call — splitting
  // them means wall-clock is whichever is slower, not the sum of both).
  //
  // Wisdom is SKIPPED ENTIRELY once today's quote/Notion pair is already
  // day-locked (see lockedQuotePair/lockedNotion further below, which discard
  // ANY freshly-generated quoteInsight/notionQuote/notionInsight in favor of
  // the first build's once priorIsToday && prior.quote/notionQuote exist) —
  // regenerating it on a same-day "Rebuild" tap would be immediately thrown
  // away, so skipping the call saves its full latency+cost every time.
  const wisdomAlreadyLocked = Boolean(priorIsToday && prior?.content?.quote && prior?.content?.notionQuote);
  const LLM_TIMEOUT = Number(process.env.BRIEFING_LLM_TIMEOUT_MS || 90000);

  let geminiResult = null;
  {
    const [chiefSettled, wisdomSettled] = await Promise.allSettled([
      withTimeout(
        generateChiefBrief(emails, dayName, workout, calendar, wellbeingContext, annotationsContext, recoveryContext, experimentsContext, selfModel, leverageContext, workBusy, strengthContext, spendingContext, continuityContext, cashflowContext, progressContext, weeklyGoalsContext, chaptersContext, dayOffContext),
        LLM_TIMEOUT,
        'gemini_chief'
      ),
      wisdomAlreadyLocked
        ? Promise.resolve(null)
        : withTimeout(generateWisdomInsights(notionTextForBrief, quoteData.quote, wellbeingContext), LLM_TIMEOUT, 'gemini_wisdom'),
    ]);

    let chiefResult = null;
    if (chiefSettled.status === 'fulfilled') {
      chiefResult = chiefSettled.value;
    } else {
      console.error('[gemini_chief] failed:', chiefSettled.reason?.message);
      errors.push({ service: 'gemini_chief', error: chiefSettled.reason?.message });
      // Carry over urgentEmails from ANY prior build (not just today's) so a
      // failed/timed-out call doesn't blank the inbox card — mirrors the
      // chiefBrief/morningFocus carryover already built into the response
      // object below (which reads prior?.content directly), for the one field
      // that isn't covered there.
      if (prior?.content?.urgentEmails?.length) chiefResult = { urgentEmails: prior.content.urgentEmails };
    }

    let wisdomResult = null;
    if (wisdomAlreadyLocked) {
      // Nothing to do — lockedQuotePair/lockedNotion below source quoteInsight/
      // notionQuote/notionInsight straight from prior.content regardless.
    } else if (wisdomSettled.status === 'fulfilled') {
      wisdomResult = wisdomSettled.value;
    } else {
      console.error('[gemini_wisdom] failed:', wisdomSettled.reason?.message);
      errors.push({ service: 'gemini_wisdom', error: wisdomSettled.reason?.message });
      // Same carryover as the old combined fallback: quoteInsight/notionQuote/
      // notionInsight aren't covered by a prior?.content fallback anywhere else
      // (only the day-locked path reads prior.content for these).
      if (prior?.content?.quoteInsight || prior?.content?.notionInsight) {
        wisdomResult = {
          quoteInsight: prior.content.quoteInsight ?? '',
          notionQuote: prior.content.notionQuote ?? '',
          notionInsight: prior.content.notionInsight ?? '',
        };
      }
    }

    geminiResult = (chiefResult || wisdomResult) ? { ...(chiefResult || {}), ...(wisdomResult || {}) } : null;
  }

  // (LLM-failure carryover for urgentEmails/quoteInsight/notionQuote/notionInsight
  // now happens per-leg, right after each Promise.allSettled result above — this
  // runs BEFORE the dedup check below either way, same as before the split.)

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

  // Deterministic suppression for the "one question" — the prompt already says
  // "never ask a question whose answer you already have," but a rebuild re-runs
  // the LLM from scratch with no memory of what was just answered a minute ago,
  // so the same (or near-identical) question can resurface verbatim right after
  // being answered. Answering it writes a 'brief_context' annotation whose note
  // is "Q: <question>" (see POST /api/briefing/context) — treat a fresh
  // openQuestion that shares most of its significant words with one of those
  // (within the last day, so a genuinely new occurrence tomorrow still surfaces)
  // as already resolved and blank it out rather than trust the model to notice.
  if (geminiResult?.chiefBrief?.openQuestion) {
    try {
      const norm = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 3));
      const qWords = norm(geminiResult.chiefBrief.openQuestion);
      if (qWords.size) {
        // Query 'brief_context' directly rather than the top-30 across every
        // category — a day with several other notes/gratitude/context entries
        // could otherwise crowd the actual answer out of a shared top-30 window.
        const recentAnswers = await annotationsStore.listAnnotations({
          from: new Date(Date.now() - 24 * 60 * 60 * 1000), limit: 30, category: 'brief_context',
        });
        const alreadyAnswered = recentAnswers.some((a) => {
          if (!a.note?.startsWith('Q: ')) return false;
          const priorWords = norm(a.note.slice(3));
          if (!priorWords.size) return false;
          const shared = [...qWords].filter((w) => priorWords.has(w)).length;
          return shared / Math.min(qWords.size, priorWords.size) >= 0.6;
        });
        if (alreadyAnswered) geminiResult.chiefBrief.openQuestion = '';
      }
    } catch (err) {
      console.error('[openQuestion dedup] failed:', err.message);
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
        recovery = await require('../intelligence/recovery').liveRecovery();
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
      rankedPool = await require('../intelligence/curate').curate(insightPool);
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
      const dismissedInsights = require('../store/dismissedInsights');
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
    const rh = require('../intelligence/relevant-highlight');
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
  //
  // TWO separate sources are checked, not just 'monarch': the Mac-side CSV
  // importer (id 'monarch', hit by POST /api/import/monarch) and the MCP
  // auto-sync (id 'monarch_mcp_sync') are independent connectors with
  // independent last_sync_at/status. Checking only 'monarch' meant that once
  // the daily Mac sync started working again, its fresh last_sync_at made
  // this alert go permanently quiet — even while monarch_mcp_sync sat broken,
  // silently losing budget-pacing data (GetBudget has no Mac/CSV fallback the
  // way transactions/income do, so an MCP-only outage is otherwise invisible).
  const alerts = [];
  try {
    const [monarchSrc, monarchMcpSrc] = await Promise.all([
      sourcesStore.getSource('monarch'),
      sourcesStore.getSource('monarch_mcp_sync'),
    ]);
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
    if (monarchMcpSrc?.status === 'error') {
      alerts.push({
        source: 'monarch_mcp_sync',
        severity: 'warn',
        // Surface the ACTUAL captured error (e.g. Monarch's own "MCP is
        // temporarily paused" outage notice) when we have one, instead of a
        // generic guess — this is a different failure mode from a stale/
        // expired token and a different fix (nothing to reconnect; wait for
        // Monarch), so don't tell the user to reconnect when that's not it.
        message: monarchMcpSrc.last_error
          ? `Monarch MCP sync is failing: ${String(monarchMcpSrc.last_error).slice(0, 200)} — budget-vs-spending comparisons are unavailable until this clears (transactions/income keep flowing via the backup sync).`
          : 'Monarch MCP sync is failing — budget-vs-spending comparisons are unavailable until this clears (transactions/income keep flowing via the backup sync).',
      });
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
    todayForecast = await require('../intelligence/predict').computeTodayForecast({ recovery });
  } catch (err) {
    console.error('[todayForecast] failed:', err.message);
  }

  // Carry the prior build's brief when this build's LLM call failed or returned
  // an invalid shape (no chiefBrief). Without this, a single bad rebuild blanks
  // the whole Chief-of-Staff card. Fresh always wins when present — but the
  // fallback used to be invisible: same-looking payload, no error anywhere, no
  // sign the "fresh" rebuild the user just triggered didn't actually update
  // this card. Track it so it shows up in `errors` and the response can flag it.
  const chiefBriefStale = geminiResult?.chiefBrief == null && prior?.content?.chiefBrief != null;
  if (chiefBriefStale) {
    console.error('[briefing build] chiefBrief generation failed/invalid — carrying forward the prior build\'s brief.');
    errors.push({ service: 'chiefBrief', error: 'invalid or missing shape from the LLM; showing the previous build\'s brief' });
  }

  const response = {
    date: dateLabel,
    builtAt: new Date().toISOString(),
    morningFocus: geminiResult?.morningFocus || prior?.content?.morningFocus || '',
    // Structured Chief-of-Staff brief (Beta): synthesis + ACTION/RISK/MOVE.
    chiefBrief: geminiResult?.chiefBrief ?? prior?.content?.chiefBrief ?? null,
    // True when the card above is carried over from a prior build (this
    // build's generation failed/invalid) rather than freshly generated.
    chiefBriefStale,
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

  // Pre-warm the spoken narration so the first tap of "Listen" plays instantly
  // instead of waiting on synthesis. Fire-and-forget.
  require('../services/brief-audio').prewarmDaily(response).catch((err) => console.error('[brief audio prewarm] failed:', err.message));

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
    .then(() => require('../services/recompute-wealth').recomputeWealthFlows()
      .then((r) => { if (r?.metricsWritten) console.log(`[recompute-wealth] ${r.transactions} txns -> ${r.metricsWritten} flow rows`); })
      .catch((e) => console.error('[recompute-wealth] failed:', e.message)))
    .then(() => analyze())
    .then((s) => {
      if (s) console.log(`[analyze] ${s.trends} trends, ${s.correlations} correlations, ${s.actions} actions`);
      // Propose experiments from unconfirmed correlations; evaluate due ones.
      return Promise.all([
        experiments.proposeExperiments().catch((e) => console.error('[propose]', e.message)),
        experiments.evaluateDue()
          .then(async (evaluated) => {
            // A verdict is the payoff of a multi-week self-test — push it to the
            // phone the moment it lands instead of letting it sit silently.
            for (const exp of evaluated || []) {
              if (!exp?.verdict) continue;
              const icon = exp.verdict === 'confirmed' ? '✓ Confirmed' : exp.verdict === 'refuted' ? '✗ Refuted' : '~ Inconclusive';
              const pct = exp.result?.pctChange != null ? ` (${exp.result.pctChange > 0 ? '+' : ''}${Math.round(exp.result.pctChange * 100)}%)` : '';
              try {
                const nudgesStore = require('../store/nudges');
                const devicesStore = require('../store/devices');
                const { sendPush } = require('../notify/expo');
                const dedupKey = `experiment_verdict:${exp.id}`;
                const recent = await nudgesStore.recentlySentKeys(7);
                if (recent.has(dedupKey)) continue;
                const id = await nudgesStore.recordNudge({
                  dedupKey,
                  title: `🧪 Experiment verdict: ${icon}`,
                  body: `${exp.hypothesis}${pct}`,
                  priority: 0.8,
                  basis: { type: 'experiment_verdict', id: exp.id, verdict: exp.verdict },
                  status: 'pending',
                });
                const tokens = await devicesStore.listActiveTokens();
                if (tokens.length) {
                  const r = await sendPush(tokens, { title: `🧪 Experiment verdict: ${icon}`, body: `${exp.hypothesis}${pct}`, data: { type: 'experiment_verdict' } });
                  for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
                  await nudgesStore.markStatus(id, 'sent');
                }
              } catch (e) {
                console.error('[verdict push] failed:', e.message);
              }
            }
            return evaluated;
          })
          .catch((e) => console.error('[evaluate]', e.message)),
      ]);
    })
    // Synthesize cross-domain relationships into plain-language insights, then run
    // a proactive push so a strong NEW connection reaches the phone unprompted
    // (deduped + quiet-hours aware inside runNudges).
    .then(() => require('../intelligence/crossContext').generateCrossContext()
      .catch((e) => console.error('[crossContext]', e.message)))
    .then(() => require('../notify/run').runNudges({ suppressCheckin: true })
      .catch((e) => console.error('[proactive nudge]', e.message)))
    .catch((err) => console.error('[ingest/analyze] failed:', err.message));
}));

  return router;
}

module.exports = { createBriefingRouter };
