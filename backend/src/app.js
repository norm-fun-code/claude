// Express app construction: CORS, auth, every domain router mount, and the
// central error handler. Pulled out of server.js so tests can build a real,
// fully-wired app (supertest against it) without triggering server.js's boot
// side effects (migrations, app.listen, the scheduler, boot-time cleanup
// queries) — those stay in server.js, which is now just this + the boot
// sequence. No behavior change: same middleware, same routers, same order.
const express = require('express');
const cors = require('cors');
const { errorHandler } = require('./middleware/errorHandler');
const { createTokenGate } = require('./middleware/auth');
const { isAdminPath } = require('./middleware/adminAuth');

const { createHealthRouter } = require('./routes/health');
const { createAnnotationsRouter } = require('./routes/annotations');
const { createGoalsRouter } = require('./routes/goals');
const { createExperimentsRouter } = require('./routes/experiments');
const { createWorkoutRouter } = require('./routes/workout');
const { createActivityRouter } = require('./routes/activity');
const { createCheckinRouter } = require('./routes/checkin');
const { createHabitsRouter } = require('./routes/habits');
const { createContextRouter } = require('./routes/context');
const { createIntentionsRouter } = require('./routes/intentions');
const { createIngestAdminRouter } = require('./routes/ingest-admin');
const { createSpineRouter } = require('./routes/spine');
const { createDiagnosticsRouter } = require('./routes/diagnostics');
const { createRecoveryRouter } = require('./routes/recovery');
const { createChatRouter } = require('./routes/chat');
const { createVoiceRouter } = require('./routes/voice');
const { createAudioRouter } = require('./routes/audio');
const { createEngagementRouter } = require('./routes/engagement');
const { createSchedulingRouter } = require('./routes/scheduling');
const { createEveningBriefRouter } = require('./routes/evening-brief');
const { createWealthRouter } = require('./routes/wealth');
const { createRecommendationsRouter } = require('./routes/recommendations');
const { createCommitmentsRouter } = require('./routes/commitments');
const { createBriefingRouter } = require('./routes/briefing');

/**
 * @param {object} [opts]
 * @param {string} [opts.bootTime] - defaults to now; overridable so tests get
 *   a deterministic value.
 * @param {number} [opts.port] - loopback port /api/briefing/rebuild targets.
 * @param {boolean} [opts.quiet] - suppress the startup auth warning (tests).
 */
function createApp({ bootTime, port, quiet } = {}) {
  const app = express();
  const BOOT_TIME = bootTime || new Date().toISOString();
  const PORT = port || process.env.PORT || 3001;

  // CORS. The mobile app (React Native) isn't subject to CORS, so we only need to
  // allow browser origins we actually use. Lock to an allowlist in production
  // (set CORS_ORIGINS as a comma-separated list); default-open only in dev.
  const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors(corsOrigins.length ? { origin: corsOrigins } : {}));
  app.use(express.json({ limit: '2mb' }));

  // Bearer-token auth on every /api route except the health check. Set
  // NORMOS_API_TOKEN to require `Authorization: Bearer <token>`. In production we
  // warn loudly if it's missing, since the same code is deployed to a public host.
  // The diagnostic (/api/diag/*, /api/debug/*) and destructive-admin
  // (/api/admin/reset-demo, /api/admin/recompute-wealth, /api/ingest/run) routes
  // are exempted here and instead require a SEPARATE NORMOS_ADMIN_TOKEN, checked
  // inside their own router files (src/middleware/adminAuth.js) — both checks
  // read the same Authorization header, so gating a path on two different
  // expected secrets at once would make it permanently unreachable.
  if (!quiet && !process.env.NORMOS_API_TOKEN) {
    const msg = '[auth] NORMOS_API_TOKEN is not set — the /api surface (including admin/reset and ingest) is UNAUTHENTICATED.';
    if (process.env.NODE_ENV === 'production') console.error(`\n⚠️  ${msg} Set it now.\n`);
    else console.warn(msg);
  }
  app.use('/api', createTokenGate('NORMOS_API_TOKEN', { skip: (req) => req.path === '/health' || isAdminPath(req.path) }));

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
  // before it).
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
