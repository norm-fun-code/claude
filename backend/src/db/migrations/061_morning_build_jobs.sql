-- Durable morning-brief build-job contract (morning lifecycle fix).
--
-- Root cause this exists to fix: the mobile client used to infer "the
-- rebuild finished" purely from `builtAt` advancing past the trigger
-- timestamp (see mobile/src/hooks/useBriefing.ts) — a build that failed or
-- returned a degraded/blank Chief Brief still advances `builtAt` on every
-- attempt, so the client silently treated failure as success. This table
-- gives every full-build attempt (automatic, manual rebuild, forced
-- refresh, startup catch-up) a durable, pollable identity that survives a
-- process restart or a different Railway instance answering the status
-- poll than the one that started the build.
--
-- One row per build ATTEMPT (not one row updated forever) — a retry is a
-- new row with attempt_number incremented, referencing the same local_day,
-- so the full attempt history for a day is inspectable. "The current job
-- for today" is simply the newest row for that local_day.
CREATE TABLE IF NOT EXISTS morning_build_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_day date NOT NULL,
  trigger text NOT NULL, -- 'scheduled' | 'watcher' | 'manual' | 'catchup' | 'sleep_checkin' | ...
  -- waiting_for_sleep | queued | building | retry_wait | ready | failed
  state text NOT NULL DEFAULT 'queued',
  attempt_number int NOT NULL DEFAULT 1,
  snapshot_id text,
  quality_status text, -- 'fresh' | 'degraded' | 'failed' | null (not yet known)
  reason_codes jsonb NOT NULL DEFAULT '[]',
  -- The `briefings` row this job actually published, once ready. Null
  -- until (and unless) publication succeeds — never set for a discarded
  -- degraded/failed draft.
  published_briefing_id uuid,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_morning_build_jobs_day ON morning_build_jobs (local_day, created_at DESC);
