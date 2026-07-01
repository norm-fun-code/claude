-- Free-text "what am I grateful for today" reflection backing the gratitude
-- habit. The gratitude habit itself stays a 0/1 metric (habits:gratitude);
-- this table turns the checkbox into an actual reflective practice by keeping
-- the one line the user wrote, so the chief of staff can reflect it back in the
-- evening wind-down brief. One row per day; re-saving the same day upserts.
CREATE TABLE IF NOT EXISTS gratitude_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_date   DATE NOT NULL UNIQUE,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gratitude_logs_date ON gratitude_logs (log_date DESC);
