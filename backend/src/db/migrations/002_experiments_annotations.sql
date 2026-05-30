-- Phase 5: trust layer.
--   annotations — life context (travel, illness, deadlines) so anomalies are
--                 explainable and correlations aren't misread.
--   experiments — the hypothesis loop: propose → run → verdict, closing the
--                 "track whether hypotheses prove true" requirement.

CREATE TABLE IF NOT EXISTS annotations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  start_ts   TIMESTAMPTZ NOT NULL,
  end_ts     TIMESTAMPTZ,                       -- null = point-in-time / ongoing
  category   TEXT NOT NULL,                     -- travel | illness | deadline | relationship | life | other
  label      TEXT NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_annotations_time ON annotations (start_ts DESC);

CREATE TABLE IF NOT EXISTS experiments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hypothesis      TEXT NOT NULL,
  metric          TEXT NOT NULL,                -- outcome measured, 'domain:metric'
  lever           TEXT,                         -- what you change, 'domain:metric' (optional)
  expected        TEXT NOT NULL DEFAULT 'up',   -- expected outcome direction: up | down
  protocol        TEXT,                         -- what to actually do
  start_date      DATE,
  end_date        DATE,
  baseline_days   INT NOT NULL DEFAULT 14,
  status          TEXT NOT NULL DEFAULT 'proposed', -- proposed | running | completed | abandoned
  verdict         TEXT,                         -- confirmed | refuted | inconclusive
  result          JSONB NOT NULL DEFAULT '{}',
  source_finding  UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_experiments_hypothesis ON experiments (hypothesis);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments (status, created_at DESC);
