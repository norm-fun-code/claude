-- Weekly intentions: the Sunday check-in where you write the week's life context
-- (free text) and 1-3 focus goals. This is the missing input the intelligence
-- layer kept referencing ("no goals tracked / no life context logged"). The
-- advisor, weekly review, and insights read recent entries (rolling 30 days) as
-- narrative + goal context. One row per week (week_start, the Sunday date).
CREATE TABLE IF NOT EXISTS weekly_intentions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start  DATE NOT NULL UNIQUE,          -- the Sunday this entry covers
  context     TEXT,                          -- free-text "what's going on this week"
  goals       JSONB NOT NULL DEFAULT '[]',   -- ["ship v2", "run 3x", ...]
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_weekly_intentions_week ON weekly_intentions (week_start DESC);
