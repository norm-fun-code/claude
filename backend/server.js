// NormOS backend.
require('dotenv').config();
const { createApp } = require('./src/app');
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

const PORT = process.env.PORT || 3001;
const BOOT_TIME = new Date().toISOString(); // process start — confirms a fresh deploy restarted the server
const app = createApp({ bootTime: BOOT_TIME, port: PORT });

const { runMigrations } = require('./src/db/migrate');
runMigrations()
  .catch((err) => console.error('[migrate] failed, starting anyway:', err.message))
  .finally(() => {
    const server = app.listen(PORT, () => {
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

    // Global socket-inactivity cap: the longest legitimate request is a full
    // briefing rebuild (source fetch + up to BRIEFING_LLM_TIMEOUT_MS ~90s of
    // LLM calls), so this sits well above that — a request past this either
    // has a stuck DB query (statement_timeout should catch that first) or a
    // hung upstream call with no timeout of its own; either way, the socket
    // gets torn down instead of holding a connection (and its DB pool slot)
    // open indefinitely.
    server.setTimeout(Number(process.env.SERVER_REQUEST_TIMEOUT_MS) || 150_000);
  });
