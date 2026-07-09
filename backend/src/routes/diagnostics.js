// Diagnostics router: every /api/diag/* and /api/debug/* read-only
// troubleshooting endpoint, gathered from three separate locations in
// server.js's monolith into one cohesive file. Fifteenth router extraction
// (see the engineering review's #1+#6 recommendation) — a straight move,
// verified line-by-line against the original before removing it from
// server.js.
const express = require('express');
const db = require('../db');
const documentsStore = require('../store/documents');
const findingsStore = require('../store/findings');
const llm = require('../llm');
const { fetchWorkBusyBlocks } = require('../services/calendar');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAdminToken } = require('../middleware/adminAuth');

function createDiagnosticsRouter() {
  const router = express.Router();

  // Every route in this file is a troubleshooting probe or exposes internal
  // system state — gate the whole router behind a separate admin token so
  // holding the general app token doesn't also grant this. Scoped to
  // /diag and /debug (this router's only prefixes) rather than a bare
  // router.use(), which would run unconditionally for ANY /api/* request
  // that reaches this router — including ones meant for a sibling router
  // mounted at the same '/api' prefix. See src/middleware/adminAuth.js.
  router.use(['/diag', '/debug'], requireAdminToken);

  // Diagnostic: show EXACTLY how 30-day income/spending are computed from Monarch
  // transactions, so a mismatch with Monarch's report can be debugged from the data
  // (not screenshots). Mirrors the sync's classification. ?days=30 by default.
  router.get('/debug/wealth-income', asyncHandler(async (req, res) => {
    const sync = require('../connectors/monarch-mcp-sync');
    const monarchMcp = require('../services/monarch-mcp');
    const { isInternalTransfer, isExcludedIncome, isNonIncomePositive, isFixedCategory } = require('../connectors/monarch');
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
  }));

  // Diagnostic: time a raw Gemini call to see if the model/endpoint itself is slow
  // or erroring (separate from the full briefing pipeline). ?big=1 sends a large
  // prompt to mimic the briefing's load.
  // Voice transcription (src/services/voice.js) calls Gemini DIRECTLY, hardcoded,
  // regardless of LLM_PROVIDER — so /api/diag/gemini below (which goes through the
  // shared llm module and tests whatever the MAIN chat provider is, likely
  // Anthropic if ANTHROPIC_API_KEY is set) doesn't actually verify voice will
  // work. This checks the exact thing the open-question voice-answer flow needs.
  router.get('/diag/voice-transcribe', async (req, res) => {
    const t0 = Date.now();
    if (!process.env.GEMINI_API_KEY) {
      return res.json({ ok: false, error: 'GEMINI_API_KEY not set — voice transcription (and TTS narration) are hard-dependent on Gemini regardless of your main LLM_PROVIDER.' });
    }
    try {
      // A tiny valid (silent) WAV so this only tests reachability/auth, not audio quality.
      const silentWavBase64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      const voiceService = require('../services/voice');
      const text = await voiceService.transcribe(silentWavBase64, 'audio/wav');
      res.json({ ok: true, ms: Date.now() - t0, transcript: text, note: 'empty transcript is expected for a silent test clip — the point is that the call succeeded' });
    } catch (err) {
      res.json({ ok: false, ms: Date.now() - t0, status: err.response?.status, error: (err.response?.data?.error?.message || err.message || '').slice(0, 300) });
    }
  });

  router.get('/diag/gemini', async (req, res) => {
    const t0 = Date.now();
    // Reports whichever provider llm.generateText() actually dispatches to —
    // NOT necessarily Gemini (this app's chat default is Anthropic; see the
    // comment above /diag/voice-transcribe). The response used to hardcode
    // `model: GEMINI_CHAT_MODEL` regardless of which provider ran, which
    // silently mislabeled every result once Anthropic became the default.
    const provider = llm.chatProviderName();
    const model = provider === 'anthropic'
      ? (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5')
      : (process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash');
    try {
      const big = req.query.big === '1';
      const prompt = big
        ? 'Here is a long document:\n' + 'The market rose 2%. '.repeat(2000) + '\nReturn JSON {"summary":"<2 sentences>"}'
        : 'Reply with JSON {"ok":true,"msg":"hello"}';
      const out = await llm.generateText({ system: 'Return only JSON.', prompt, temperature: 0.2, maxTokens: 1024 });
      res.json({ ok: true, ms: Date.now() - t0, provider, model, replyLen: out.length, sample: out.slice(0, 200) });
    } catch (err) {
      res.json({ ok: false, ms: Date.now() - t0, provider, model, status: err.response?.status, error: (err.response?.data?.error?.message || err.message || '').slice(0, 300) });
    }
  });

  // Scheduler health check — shows whether the scheduler is enabled and when
  // the morning routine will next fire (helps diagnose missing 8:30am briefings).
  router.get('/diag/scheduler', (req, res) => {
    const { msUntil } = require('../scheduler');
    const enabled = process.env.ENABLE_SCHEDULER === 'true';
    const tz = process.env.TZ || '(not set — server uses system/UTC)';
    const hour = Number(process.env.SCHEDULE_HOUR) || 8;
    const minute = Number(process.env.SCHEDULE_MINUTE) || 30;
    const checkinH = Number(process.env.CHECKIN_REMINDER_HOUR) || 15;
    const eveningReminderH = Number(process.env.EVENING_REMINDER_HOUR) || 21;

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
        eveningReminder: { configured: `${String(eveningReminderH).padStart(2,'0')}:00`, nextFireAt: toWallClock(nextMs(eveningReminderH, 0)) },
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
  router.get('/diag/recovery-baseline', asyncHandler(async (req, res) => {
    const metricsStore = require('../store/metrics');
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
  }));

  //   GET /api/diag/metric-rows?domain=health&metric=steps&days=7
  router.get('/diag/metric-rows', asyncHandler(async (req, res) => {
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
  }));

  // Diagnostic: the largest "spending" transactions and their categories over the
  // last N days. Reveals whether big spend days are real purchases or internal
  // movements (transfers, credit-card payments) wrongly counted as spending.
  //   GET /api/diag/top-spend?days=10&limit=25
  router.get('/diag/top-spend', asyncHandler(async (req, res) => {
    const days = Math.min(Number(req.query.days) || 10, 120);
    const limit = Math.min(Number(req.query.limit) || 25, 200);
    const txns = await documentsStore.spendTransactions({ days });
    const sorted = [...txns].sort((a, b) => b.amount - a.amount).slice(0, limit);
    // Tally by category so transfer/payment pollution is obvious in aggregate.
    const byCategory = {};
    for (const t of txns) byCategory[t.category] = Math.round(((byCategory[t.category] || 0) + t.amount) * 100) / 100;
    res.json({ days, count: txns.length, topTransactions: sorted, byCategory });
  }));

  // Quick smoke-test for the work calendar free/busy integration.
  // Returns the raw busy blocks for today — useful for verifying GOOGLE_WORK_CALENDAR_ID is correct.
  router.get('/debug/work-calendar', asyncHandler(async (req, res) => {
    const blocks = await fetchWorkBusyBlocks();
    res.json({ calendarId: process.env.GOOGLE_WORK_CALENDAR_ID || '(not set)', blocks, count: blocks.length });
  }));

  // MTD spending breakdown by category — diagnose discrepancies between NormOS
  // totals and Monarch's own Cash Flow report.
  //   GET /api/debug/mtd-spend
  router.get('/debug/mtd-spend', asyncHandler(async (req, res) => {
    const { query: dbQuery } = require('../db');
    const { isInternalTransfer, isFixedCategory } = require('../connectors/monarch');
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
    const metricsStore = require('../store/metrics');
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
  }));

  // Diagnostic: full curation score breakdown for every finding in the last
  // analyze pass — so production issues can be diagnosed from data rather than
  // screenshots. Shows each finding's _score, _scoreParts, _signature, and
  // which surface it lands on.
  //   GET /api/debug/insights
  router.get('/debug/insights', asyncHandler(async (req, res) => {
    const { curate } = require('../intelligence/curate');
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
  }));

  // Lightweight Monarch MCP health check — confirms the integration is configured
  // and the refresh-token → access-token exchange works, WITHOUT dumping any
  // financial data.
  router.get('/debug/monarch-mcp', async (req, res) => {
    try {
      const monarchMcp = require('../services/monarch-mcp');
      if (!monarchMcp.isConfigured()) {
        return res.json({ configured: false, hint: 'Set MONARCH_MCP_REFRESH_TOKEN and MONARCH_MCP_CLIENT_ID' });
      }
      await monarchMcp.getAccessToken(); // throws if the refresh token is bad
      res.json({ configured: true, tokenOk: true });
    } catch (err) {
      res.status(500).json({ configured: true, tokenOk: false, error: err.response?.data || err.message });
    }
  });

  // Diagnostic: raw Monarch budget pacing side-by-side with the category-spend
  // strings the "trending X% above usual" cards actually key off of, so a
  // category-name mismatch between the two (same bug class as the income
  // detection issue) is visible directly instead of guessed at.
  router.get('/debug/wealth-budget', asyncHandler(async (req, res) => {
    const monarchWealth = require('../services/monarch-wealth');
    const documents = require('../store/documents');
    if (!monarchWealth.isConfigured()) {
      return res.json({ configured: false, hint: 'Monarch MCP not configured' });
    }
    const [pacing, categorySpend] = await Promise.all([
      monarchWealth.getBudgetPacing(),
      documents.monthlyCategorySpend({ months: 1 }),
    ]);
    const payload = {
      configured: true,
      budgetLines: (pacing?.lines || []).map((l) => ({ category: l.category, budget: l.budget, actual: l.actual })),
      spendCategoriesThisMonth: [...new Set(categorySpend.map((r) => r.category))],
      hint: pacing?.lines?.length
        ? 'Compare budgetLines[].category strings against spendCategoriesThisMonth — a mismatch (different casing/wording) means budget cards silently never match.'
        : 'No budget lines returned from Monarch — pass ?raw=1 to see the UNFILTERED GetBudget response and tell whether Monarch returned nothing at all vs. a shape the filter logic silently rejected.',
    };
    // ?raw=1: bypass getBudgetPacing's category_type==='expense' / budget>0
    // filtering entirely and call GetBudget directly, so a shape mismatch (e.g.
    // a different field name or category_type value than the code expects) is
    // visible instead of silently filtered down to an empty array.
    if (req.query.raw === '1') {
      const rpc = require('../services/monarch-mcp-rpc');
      const now = new Date();
      const y = now.getUTCFullYear(), mo = now.getUTCMonth();
      const monthStart = `${y}-${String(mo + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      const monthEnd = `${y}-${String(mo + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      payload.rawGetBudget = await rpc.callToolJson('GetBudget', { start_date: monthStart, end_date: monthEnd, include_actuals: true });
    }
    res.json(payload);
  }));

  return router;
}

module.exports = { createDiagnosticsRouter };
