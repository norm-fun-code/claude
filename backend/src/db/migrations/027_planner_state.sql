-- Shared with the Cohen Financial Planner service (same Railway PostgreSQL).
-- The planner writes live slider values here; NormOS reads them for chat context.
CREATE TABLE IF NOT EXISTS planner_state (
  id INT PRIMARY KEY DEFAULT 1,
  state JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);
