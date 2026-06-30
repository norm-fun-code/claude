-- Manual per-day workout swaps. The weekly split is the default schedule, but
-- the user can choose a different session for any specific day (e.g. do Sunday's
-- Pull on a day that's normally Rest) and log its sets fully. One row per date;
-- absence = follow the scheduled split for that day.
CREATE TABLE IF NOT EXISTS workout_overrides (
  log_date   DATE         PRIMARY KEY,
  workout_id TEXT         NOT NULL,   -- push | pull | zone2 | mobility | intervals | rest
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
