// NormOS backend.
require('dotenv').config();
const { validateBootConfig } = require('./src/config/checkEnv');
validateBootConfig();

const { createApp } = require('./src/app');
const { start: startScheduler } = require('./src/scheduler');
const { migrateWithLock } = require('./src/db/migrateWithLock');

// Production Safety Gate (audit recommendation #1), item 4: an uncaught
// exception or unhandled rejection means some part of the process's
// in-memory state may now be inconsistent with reality (a half-applied
// write, a listener that never re-armed, a promise chain that silently
// died) — continuing to serve requests on a process in an unknown state
// risks corrupting data or serving wrong answers far worse than a few
// seconds of restart downtime. Railway's restartPolicyType: ON_FAILURE
// (railway.json) means a nonzero exit here gets a fresh, known-good process
// back quickly; the old "log and keep running indefinitely" behavior traded
// that recovery for an unbounded risk. This deliberately does NOT affect
// normal per-request errors — those are caught by Express's own error
// middleware (src/middleware/errorHandler.js, via asyncHandler-wrapped
// routes) and never reach process-level handlers at all; only a genuinely
// unhandled failure outside any request's control flow lands here.
let shuttingDown = false;
function fatal(label, err) {
  console.error(`[${label}]`, err instanceof Error ? err.stack : err);
  if (shuttingDown) return; // a second fatal error mid-shutdown shouldn't re-enter this
  shuttingDown = true;
  console.error(`[boot] exiting after ${label} — Railway will restart the process.`);
  // Deferred (not a synchronous process.exit() mid-handler) so the error log
  // above actually flushes to stdout/stderr before the process dies —
  // that's the "graceful" half of "graceful shutdown and nonzero exit."
  setTimeout(() => process.exit(1), 100).unref();
}
process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
process.on('uncaughtException', (err) => fatal('uncaughtException', err));

const PORT = process.env.PORT || 3001;
const BOOT_TIME = new Date().toISOString(); // process start — confirms a fresh deploy restarted the server
const app = createApp({ bootTime: BOOT_TIME, port: PORT });

/**
 * Production Safety Gate (audit recommendation #1), item 3: the one
 * explicit boot path. Runs migrations exactly once under an advisory lock
 * (see src/db/migrateWithLock.js) and ONLY THEN starts accepting HTTP
 * traffic. A migration failure exits nonzero WITHOUT ever calling
 * app.listen — Railway's healthcheck then correctly reports the deploy as
 * failed instead of serving traffic against an unmigrated (or
 * half-migrated) schema.
 */
async function boot() {
  await migrateWithLock();

  const server = app.listen(PORT, () => {
    console.log(`NormOS backend running on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);

    // Optional self-running morning routine (cloud deploys; ENABLE_SCHEDULER=true).
    startScheduler();

    // Deliberately NO narration cache backfill/prewarm at boot. A prior
    // version of this warmed brief+Wisdom+evening narration for whatever
    // was already persisted, reasoning that a restart mid-day shouldn't
    // leave the cache cold — but that meant a Railway restart alone could
    // fire real (paid, rate-sensitive) Gemini TTS calls with no user ever
    // having asked for narration, and could race against this SAME boot's
    // other prewarm triggers with nothing coordinating between them (the
    // live bug: simultaneous Chief+Wisdom TTS calls, each timing out).
    // Narration now only ever generates from Chief's own post-build prewarm
    // (routes/briefing.js) or an explicit user Listen tap (routes/audio.js)
    // — both go through brief-audio.js's process-wide serialization gate,
    // so a cold cache after a restart just means the FIRST Listen tap of
    // the day pays a normal cold-synthesis cost once, same as any other
    // cache miss, not a background job racing to beat it there.

    // One-setting demo data: set SEED_DEMO_ON_BOOT=true to populate realistic
    // sample data + findings so the app shows a full dashboard on first open.
    // Idempotent (only touches 'seed' rows); turn the flag off once real data flows.
    // Opt-in and explicit (an operator must set the flag), unlike the
    // unconditional cleanup queries Production Safety Gate #5 removed.
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

  // Global socket-inactivity cap: the longest legitimate request is a full
  // briefing rebuild (source fetch + up to BRIEFING_LLM_TIMEOUT_MS ~130s of
  // LLM calls), so this sits well above that — a request past this either
  // has a stuck DB query (statement_timeout should catch that first) or a
  // hung upstream call with no timeout of its own; either way, the socket
  // gets torn down instead of holding a connection (and its DB pool slot)
  // open indefinitely.
  server.setTimeout(Number(process.env.SERVER_REQUEST_TIMEOUT_MS) || 180_000);
}

boot().catch((err) => {
  console.error('[boot] FATAL: migration failed — refusing to start the HTTP server.');
  console.error(err.stack || err.message);
  process.exit(1);
});
