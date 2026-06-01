-- Per-exercise / per-non-negotiable checkmarks inside a day's workout. Unlike
-- the workout-level "Mark complete" (which logs the Exercise habit metric), this
-- is the granular checklist state — which specific exercises you ticked off on a
-- given day — persisted so it survives tab switches and reopens, and so workout
-- adherence can feed insights over time. One row per (date, item); upserted.
CREATE TABLE IF NOT EXISTS workout_checks (
  check_date  DATE NOT NULL,          -- local calendar date (client-owned, ET)
  item_key    TEXT NOT NULL,          -- exercise name, or non-negotiable key
  item_type   TEXT NOT NULL,          -- 'exercise' | 'non_negotiable'
  done        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (check_date, item_key)
);

CREATE INDEX IF NOT EXISTS idx_workout_checks_date ON workout_checks (check_date);
