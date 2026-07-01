-- Free-text "what did I eat/drink today" log, scored by the LLM into a
-- suggested 1-5 Eating Healthy rating (habits:eat_healthy is the actual logged
-- habit value — this table just backs the AI-suggestion helper and keeps the
-- raw log for reference). One row per day; re-scoring the same day upserts.
CREATE TABLE IF NOT EXISTS meal_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_date   DATE NOT NULL UNIQUE,
  text       TEXT NOT NULL,
  score      SMALLINT,
  rationale  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meal_logs_date ON meal_logs (log_date DESC);
