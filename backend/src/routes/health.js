// Health-domain router: the server health check + every Eight Sleep / Apple
// Health ingest and readback route. Moved out of server.js's monolith as the
// first router extraction (see the engineering review's #1+#6 recommendation)
// — a straight move, not a rewrite: every route below is byte-identical in
// behavior to its former server.js home, just converted from a per-route
// try/catch to asyncHandler + the central error middleware (see
// src/middleware/errorHandler.js — the two produce an identical response
// shape, verified before this extraction).
const express = require('express');
const db = require('../db');
const metricsStore = require('../store/metrics');
const sourcesStore = require('../store/sources');
const { mapHealthPayload, SOURCE: HEALTH_SOURCE } = require('../ingest/health');
const { analyze } = require('../intelligence/analyze');
const {
  login: eightSleepLogin,
  resolveUserId: eightSleepResolveUserId,
  getTrends: eightSleepGetTrends,
} = require('../services/eight-sleep-api');
const { asyncHandler } = require('../middleware/asyncHandler');

/**
 * @param {{ bootTime: string }} deps — BOOT_TIME is process start-up state
 *   owned by server.js's bootstrap, passed in rather than duplicated here.
 */
function createHealthRouter({ bootTime }) {
  const router = express.Router();

  router.get('/health', asyncHandler(async (req, res) => {
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
    // Scheduler state is surfaced here (publicly, but it's just booleans) so a
    // "nothing fired" report can be diagnosed from outside the process — a
    // leaderless scheduler (jobsStarted:false, awaitingLeadership:true) is
    // otherwise invisible without server-log access.
    let scheduler = null;
    try { scheduler = require('../scheduler').schedulerState(); } catch { /* older build */ }
    res.json({
      status: 'ok',
      database,
      commit: commit === 'unknown' ? 'unknown' : commit.slice(0, 7),
      bootedAt: bootTime,
      timestamp: new Date().toISOString(),
      scheduler,
    });
  }));

  // Mobile app posts on-device HealthKit data here so it persists to the spine.
  router.post('/ingest/health', asyncHandler(async (req, res) => {
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
    require('../intelligence/watch').runWatch({ metrics: rows }).catch((e) => console.error('[watch] health ingest:', e.message));
  }));

  // Seed Eight Sleep baseline averages — runs the pre-computed 180-day seed in-process.
  // curl -X POST .../api/ingest/sleep-baseline -H "Authorization: Bearer TOKEN"
  // Safe to re-run (upserts). Useful after first setup or when baselines change.
  router.post('/ingest/sleep-baseline', asyncHandler(async (req, res) => {
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
  }));

  // Eight Sleep full history import — accepts the sleep_nights.json export directly.
  // curl -X POST .../api/ingest/eight-sleep -H "Content-Type: application/json"
  //      -H "Authorization: Bearer TOKEN" -d @sleep_nights.json
  router.post('/ingest/eight-sleep', express.json({ limit: '50mb' }), asyncHandler(async (req, res) => {
    const { sessions } = req.body;
    if (!Array.isArray(sessions)) return res.status(400).json({ error: 'Expected { sessions: [...] }' });

    await sourcesStore.registerSource({ id: 'eight_sleep', domain: 'health', displayName: 'Eight Sleep' });
    const tz = process.env.TZ || 'America/New_York';
    const { dayAnchorTs } = require('../util/date');
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
    // A fresh Eight Sleep sync invalidates the liveRecovery() cache — same
    // staleness class as the self-report endpoint (see recovery.js): without
    // this, a request from moments before this sync (which cached "no
    // reading yet") would keep serving that stale result for up to
    // RECOVERY_CACHE_MS after real data landed.
    if (written > 0) require('../intelligence/recovery').invalidateRecoveryCache();
    // Fire-and-forget: ping if these overnight metrics deviate sharply from baseline.
    if (written > 0) require('../intelligence/watch').runWatch().catch((e) => console.error('[watch] eight-sleep ingest:', e.message));
  }));

  // Pull Eight Sleep history for the last N days (default 60) and upsert into the
  // metrics table. Safe to re-run — idempotent. Used for initial baseline backfill
  // so the recovery score has enough history to self-calibrate.
  router.post('/ingest/eight-sleep/backfill', asyncHandler(async (req, res) => {
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
    // Same staleness class as the self-report endpoint (see recovery.js) —
    // a backfill can include today's reading.
    if (written > 0) require('../intelligence/recovery').invalidateRecoveryCache();
    // Re-run analysis so the new history flows into findings and self-model.
    analyze().catch((e) => console.error('[eight-sleep backfill] analyze:', e.message));
  }));

  // Eight Sleep (or manual) overnight metrics: HRV, RHR, sleep score, sleep hours.
  // Stored separately from Apple Health (source: 'eight_sleep') so they can coexist
  // and the analyze engine can prefer watch data when both are present.
  router.post('/ingest/sleep', asyncHandler(async (req, res) => {
    await sourcesStore.registerSource({ id: 'eight_sleep', domain: 'health', displayName: 'Eight Sleep' });
    const tz = process.env.TZ || 'America/New_York';
    const { dayAnchorTs } = require('../util/date');
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
    // Same staleness class as the self-report endpoint (see recovery.js).
    require('../intelligence/recovery').invalidateRecoveryCache();
    // Fire-and-forget: ping if last night's overnight metrics deviate from baseline.
    require('../intelligence/watch').runWatch({ metrics: rows }).catch((e) => console.error('[watch] sleep ingest:', e.message));
  }));

  // Today's Eight Sleep metrics — lets the app show what's already been logged.
  router.get('/sleep/today', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    const METRICS = ['hrv', 'resting_hr', 'sleep_score', 'sleep_hours', 'respiratory_rate', 'sleep_debt', 'sleep_need'];
    const result = {};
    await Promise.all(METRICS.map(async (m) => {
      // Eight Sleep first; fall back to the manual sleep check-in (self_report)
      // so a night off the pod still shows the sleep the user logged instead
      // of a blank row.
      const { rows } = await require('../db').query(
        `SELECT value FROM metrics
          WHERE domain = 'health' AND metric = $1 AND source IN ('eight_sleep', 'self_report')
            AND date_trunc('day', ts AT TIME ZONE $2) = $3::date
          ORDER BY CASE source WHEN 'eight_sleep' THEN 1 ELSE 2 END, ts DESC LIMIT 1`,
        [m, tz, today]
      );
      if (rows[0]) result[m] = Number(rows[0].value);
    }));
    res.json({ date: today, logged: Object.keys(result).length > 0, metrics: result });
  }));

  return router;
}

module.exports = { createHealthRouter };
