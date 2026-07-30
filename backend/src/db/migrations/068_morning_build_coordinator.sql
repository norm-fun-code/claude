-- Durable morning-build coordinator (July 30 2026 incident hardening).
--
-- Adds what 061_morning_build_jobs.sql was missing for deployment-safe,
-- single-flight, three-tier-quality-aware morning builds:
--
--   * A real lease/heartbeat (lease_owner/lease_expires_at) instead of only
--     `updated_at` + a 15-minute poll-triggered staleness check — a killed
--     process's job can now be recognized as abandoned within one missed
--     heartbeat interval, not 15 minutes.
--   * `phase` — fine-grained progress within the coarse `state`
--     ('building_snapshot'|'generating'|'validating'|'repairing'|
--     'publishing'), so the client can show what's actually happening
--     instead of one generic spinner.
--   * `phase_history` — a durable timeline of every phase transition, for
--     diagnostics.
--   * `publish_tier` — 'premium_fresh' | 'grounded_usable', set once a job
--     reaches 'ready'. Replaces the binary "quality_status==='fresh' or
--     discard" gate with the three-tier publishability contract (see
--     brain/publishTier.js): a merely-thin-but-safe draft now publishes as
--     'grounded_usable' instead of vanishing entirely.
--   * `correlation_id` — threads one build's logs together end to end.
--   * `push_result` — records what happened when this job's publication was
--     offered to the push pipeline, decoupled from build success (a push
--     failure must never look like an unpublished brief, and vice versa).
--   * `tz` — the timezone this job's local_day was resolved in, so a
--     TZ misconfiguration is visible in the row itself, not just inferred.
--   * `'interrupted'` added to the valid state vocabulary — the explicit
--     terminal state a startup recovery scan stamps on a job whose lease
--     expired before it reached ready/failed (see morningBuildCoordinator.js
--     `recoverInterruptedJobs`), instead of leaving it silently orphaned in
--     'building' until the old 15-minute poll-driven check found it.
--   * A partial unique index enforcing "never two active jobs for the same
--     local_day" at the DATABASE level (previously only an advisory lock,
--     racy across the read-then-insert window) — a concurrent second
--     INSERT now fails with a unique violation the coordinator catches and
--     turns into "adopt the existing job" rather than a duplicate build.

ALTER TABLE morning_build_jobs
  ADD COLUMN IF NOT EXISTS tz text,
  ADD COLUMN IF NOT EXISTS phase text,
  ADD COLUMN IF NOT EXISTS phase_history jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS publish_tier text,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS correlation_id text,
  ADD COLUMN IF NOT EXISTS push_result jsonb NOT NULL DEFAULT '{}';

-- One active (non-terminal) job per local_day, enforced by Postgres itself —
-- a concurrent second INSERT racing the read-then-write advisory-lock check
-- now fails fast with a unique violation instead of silently succeeding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_morning_build_jobs_one_active_per_day
  ON morning_build_jobs (local_day)
  WHERE state IN ('waiting_for_sleep', 'queued', 'building', 'retry_wait');

CREATE INDEX IF NOT EXISTS idx_morning_build_jobs_lease
  ON morning_build_jobs (lease_expires_at)
  WHERE state IN ('waiting_for_sleep', 'queued', 'building', 'retry_wait');
