-- Per-set workout logs: actual reps and weight performed, persisted so
-- progressive overload can be tracked and last session auto-populates.
CREATE TABLE IF NOT EXISTS workout_logs (
  id          SERIAL PRIMARY KEY,
  log_date    DATE          NOT NULL,
  exercise    TEXT          NOT NULL,
  set_number  INTEGER       NOT NULL,
  reps        INTEGER,
  weight_lbs  NUMERIC(6,2),
  note        TEXT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (log_date, exercise, set_number)
);
CREATE INDEX IF NOT EXISTS idx_workout_logs_date ON workout_logs (log_date DESC);
CREATE INDEX IF NOT EXISTS idx_workout_logs_exercise ON workout_logs (exercise, log_date DESC);
