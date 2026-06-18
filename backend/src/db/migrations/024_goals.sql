CREATE TABLE IF NOT EXISTS goals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title          TEXT NOT NULL,
  domain         TEXT,
  metric         TEXT,
  target_value   NUMERIC,
  unit           TEXT,
  target_date    DATE,
  baseline_value NUMERIC,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals (status, created_at DESC);
