-- What you ACTUALLY did on a given day, when it differs from the planned
-- workout (e.g. scheduled Pull but you walked / did Zone 2 instead). Separate
-- from workout_logs (per-set strength data) and workout_checks (per-exercise
-- completion) because an alternate activity has no sets/exercises — it's a
-- free-form "I did X for Y minutes" record. Multiple rows per day are allowed
-- (two-a-days: strength + an evening walk).
CREATE TABLE IF NOT EXISTS activity_logs (
  id            SERIAL PRIMARY KEY,
  log_date      DATE          NOT NULL,
  activity_type TEXT          NOT NULL,   -- zone2 | walk | run | strength | intervals | mobility | yoga | rest | other
  label         TEXT,                     -- optional free text, e.g. "45 min incline walk"
  duration_min  INTEGER,
  note          TEXT,
  planned_type  TEXT,                     -- what was scheduled that day (adherence / swap tracking)
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_logs_date ON activity_logs (log_date DESC);
