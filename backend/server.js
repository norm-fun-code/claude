// NormOS backend.
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { errorHandler } = require('./src/middleware/errorHandler');

const { createHealthRouter } = require('./src/routes/health');
const { createAnnotationsRouter } = require('./src/routes/annotations');
const { createGoalsRouter } = require('./src/routes/goals');
const { createExperimentsRouter } = require('./src/routes/experiments');
const { createWorkoutRouter } = require('./src/routes/workout');
const { createActivityRouter } = require('./src/routes/activity');
const { createCheckinRouter } = require('./src/routes/checkin');
const { createHabitsRouter } = require('./src/routes/habits');
const { createContextRouter } = require('./src/routes/context');
const { createIntentionsRouter } = require('./src/routes/intentions');
const { createChaptersRouter } = require('./src/routes/chapters');
const { createIngestAdminRouter } = require('./src/routes/ingest-admin');
const { createSpineRouter } = require('./src/routes/spine');
const { createDiagnosticsRouter } = require('./src/routes/diagnostics');
const { createRecoveryRouter } = require('./src/routes/recovery');
const { createChatRouter } = require('./src/routes/chat');
const { createVoiceRouter } = require('./src/routes/voice');
const { createAudioRouter } = require('./src/routes/audio');
const { createEngagementRouter } = require('./src/routes/engagement');
const { createSchedulingRouter } = require('./src/routes/scheduling');
const { createEveningBriefRouter } = require('./src/routes/evening-brief');
const { createWealthRouter } = require('./src/routes/wealth');
const { createRecommendationsRouter } = require('./src/routes/recommendations');
const { createCommitmentsRouter } = require('./src/routes/commitments');
const { createBriefingRouter } = require('./src/routes/briefing');
const recommendationsStore = require('./src/store/recommendations');

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

// Health-domain routes (server health check, Apple Health + Eight Sleep
// ingest/readback) live in src/routes/health.js — the first router
// extraction out of this file (see the engineering review's #1+#6
// recommendation). Mounted at /api so its internal paths ('/health',
// '/ingest/health', etc.) resolve to the exact same /api/... URLs as before.
app.use('/api', createHealthRouter({ bootTime: BOOT_TIME }));

// Check-in routes (log, history, today, weekly review history) live in
// src/routes/checkin.js — the eighth router extraction out of this file.
app.use('/api', createCheckinRouter());

// Habits routes (log, today, eat-healthy, gratitude, streaks, history) live
// in src/routes/habits.js — the ninth router extraction out of this file.
// recomputeHabitScore moved to src/intelligence/habit-score.js since the
// voice-command habit-logging paths below also call it.
app.use('/api', createHabitsRouter());

// Nightly context tags routes live in src/routes/context.js — the tenth
// router extraction out of this file.
app.use('/api', createContextRouter());

// Workout routes (checks, overrides, progression, per-set logs) live in
// src/routes/workout.js — the sixth router extraction out of this file.
app.use('/api', createWorkoutRouter());

// Activity-log routes live in src/routes/activity.js — the seventh router
// extraction out of this file. syncActivityMinutes moved to
// src/intelligence/activity-sync.js since the voice-command activity path
// below also calls it.
app.use('/api', createActivityRouter());

// Weekly intentions routes live in src/routes/intentions.js — the eleventh
// router extraction out of this file.
app.use('/api', createIntentionsRouter());

// Chapters routes (GET/POST/DELETE) live in src/routes/chapters.js — the
// twelfth router extraction out of this file.
app.use('/api', createChaptersRouter());

// Weather, generic metric ingest, connector-trigger, admin (reset-demo /
// recompute-wealth), and Monarch CSV upload routes live in
// src/routes/ingest-admin.js — the sixteenth router extraction out of this
// file.
app.use('/api', createIngestAdminRouter());

// Diagnostics routes (/api/diag/*, /api/debug/*) live in
// src/routes/diagnostics.js — the fifteenth router extraction out of this
// file, gathering routes from three separate locations in the original into
// one cohesive file.
app.use('/api', createDiagnosticsRouter());

// "Querying the spine" routes (metrics, sources/freshness, findings,
// highlights, analyze/consolidate/embed) live in src/routes/spine.js —
// the thirteenth router extraction out of this file.
app.use('/api', createSpineRouter());

// Recovery routes (live score, history, self-report) live in
// src/routes/recovery.js — the fourteenth router extraction out of this file.
app.use('/api', createRecoveryRouter());

// Chat routes (typed Ask thread + saved conversations) live in
// src/routes/chat.js — the seventeenth router extraction out of this file.
// executeAction (shared by chat and voice) moved to src/chat/executeAction.js.
app.use('/api', createChatRouter());

// Voice routes (push-to-talk ask, standalone transcribe) live in
// src/routes/voice.js — the eighteenth router extraction out of this file.
app.use('/api', createVoiceRouter());

// Spoken brief-narration routes live in src/routes/audio.js — the
// nineteenth router extraction out of this file.
app.use('/api', createAudioRouter());

// Life-context annotation routes (create/list/active/delete/edit +
// pre-brief context answers) live in src/routes/annotations.js — the
// second router extraction out of this file. Mounted at /api so its
// internal paths resolve to the exact same /api/... URLs as before.
app.use('/api', createAnnotationsRouter());

// Goals routes live in src/routes/goals.js — the third router extraction
// out of this file.
app.use('/api', createGoalsRouter());

// Experiment routes live in src/routes/experiments.js — the fourth router
// extraction out of this file.
app.use('/api', createExperimentsRouter());

// Ranked leverage actions, forecasts, device registration, nudges, and
// dismissed-insight management live in src/routes/engagement.js — the
// twentieth router extraction out of this file.
app.use('/api', createEngagementRouter());

// Scheduling-trigger routes (watch/morning/checkin/habits/weekly runs +
// external cron entry points + weekly review read) live in
// src/routes/scheduling.js — the twenty-first router extraction out of
// this file.
app.use('/api', createSchedulingRouter());

// Evening-brief routes live in src/routes/evening-brief.js — the
// twenty-second router extraction out of this file.
app.use('/api', createEveningBriefRouter());

// Wealth snapshot/plan/allocation routes live in src/routes/wealth.js —
// the twenty-third router extraction out of this file.
app.use('/api', createWealthRouter());

// /api/sources moved into src/routes/spine.js alongside
// /api/sources/freshness.

// The main briefing builder (/api/briefing, /api/briefing/live,
// /api/briefing/markets, /api/briefing/rebuild) lives in
// src/routes/briefing.js — the twenty-sixth and final router extraction
// out of this file, moved verbatim (see the file's own header comment).
app.use('/api', createBriefingRouter({ port: PORT }));

// Pipeline-health and recommendation-ledger routes live in
// src/routes/recommendations.js — the twenty-fourth router extraction out
// of this file.
app.use('/api', createRecommendationsRouter());

// Commitments (follow-through loop) and daily-context journal routes live
// in src/routes/commitments.js — the twenty-fifth router extraction out of
// this file.
app.use('/api', createCommitmentsRouter());

// Central error handler — MUST be registered after every route/router above
// (Express error middleware only catches errors from handlers registered
// before it). Purely additive at this point: no existing route calls
// next(err) yet (they all still handle their own errors via try/catch), so
// this sits idle until routes are incrementally converted to asyncHandler as
// part of the server.js decomposition. See src/middleware/errorHandler.js.
app.use(errorHandler);

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

      // Cleanup: collapse near-duplicate PENDING recommendations — same dedup_key
      // (same finding basis) or, for older rows with no dedup_key, titles that
      // differ only by the numbers (e.g. "Best sleep nights → 13% better HRV" vs
      // "→ 12%"). Keeps the newest; never touches rows the user has rated.
      recommendationsStore.dedupePending()
        .then((n) => { if (n > 0) console.log(`[boot] collapsed ${n} duplicate recommendation(s)`); })
        .catch(() => {});

      // Cleanup: the sleep_impact finding's title was reworded from
      // "Best sleep nights → NN% better X" to "Best sleep nights lift your
      // next-day X" — same insight, different words, so dedup_key/title-based
      // dedupePending above can't tell they're duplicates. Drop the old-worded
      // row when a new-worded one for the same run already exists; never
      // touches rated rows.
      require('./src/db').query(
        `DELETE FROM recommendations r
          WHERE r.outcome_measured_at IS NULL
            AND r.title ~* '^Best sleep nights? →'
            AND EXISTS (
              SELECT 1 FROM recommendations r2
               WHERE r2.id <> r.id
                 AND r2.title ILIKE 'Best sleep nights lift%'
            )`
      ).then(({ rowCount }) => { if (rowCount > 0) console.log(`[boot] collapsed ${rowCount} reworded sleep_impact duplicate(s)`); })
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
