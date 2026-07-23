-- Explicit workout-level completion — distinct from the generic Exercise
-- habit (metrics domain='habits' metric='exercise'), which only proves SOME
-- exercise occurred that day, never WHICH workout or whether it was hard.
-- Root-cause fix: logging an unrelated activity (e.g. a walk) used to be
-- read as completing whatever hard workout was scheduled, because the only
-- signal available was the generic habit boolean. This table is the
-- authoritative record of "the effective workout for this date was
-- EXPLICITLY completed" — never inferred or backfilled from the habit.
--
-- One row per local date; absence = the day's effective workout has not
-- been explicitly completed. `workout_id` records WHICH workout
-- (push | pull | zone2 | mobility | intervals | rest) this completion
-- applies to, so a later change to the effective workout for that date (a
-- recovery downgrade landing after the fact, a manual override) can be told
-- apart from what the user actually completed. `source` is provenance:
-- 'manual' (the Health tab's "Mark as complete" button) or 'activity_match'
-- (an explicitly logged activity whose type equals workout_id).
CREATE TABLE IF NOT EXISTS workout_completions (
  log_date     DATE         PRIMARY KEY,
  workout_id   TEXT         NOT NULL,   -- push | pull | zone2 | mobility | intervals | rest
  source       TEXT         NOT NULL DEFAULT 'manual',
  completed_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
