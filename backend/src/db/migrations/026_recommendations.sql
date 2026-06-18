-- Recommendation ledger: tracks every leverage action surfaced to the user
-- (in the morning briefing or elsewhere), what metric they were meant to move,
-- and whether the metric actually moved after acting on the advice.
-- Closes the feedback loop so the weekly review can answer "did what NormOS
-- suggested actually work?"

CREATE TABLE IF NOT EXISTS recommendations (
  id                   SERIAL PRIMARY KEY,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  type                 TEXT NOT NULL DEFAULT 'leverage',
  -- findings.id where this originated (nullable — goals/trends have no UUID finding)
  finding_id           UUID,
  title                TEXT NOT NULL,
  detail               TEXT,
  -- metric key for the thing being acted on (e.g. 'habits:morning_tm', 'health:sleep_hours')
  lever                TEXT,
  -- metric key for the outcome being tracked (e.g. 'health:hrv', 'wellbeing:mood')
  outcome_metric       TEXT,
  expected_direction   TEXT CHECK (expected_direction IN ('up', 'down', NULL)),
  -- leverage score at time of surfacing (impact * confidence * ease)
  score                NUMERIC(6, 4),
  -- where it was surfaced ('briefing', 'chat', 'nudge', etc.)
  surfaced_in          TEXT NOT NULL DEFAULT 'briefing',
  -- outcome measurement: did the metric move?
  outcome_delta        NUMERIC(10, 4),
  outcome_measured_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS recommendations_created_at_idx ON recommendations (created_at DESC);
CREATE INDEX IF NOT EXISTS recommendations_finding_id_idx ON recommendations (finding_id) WHERE finding_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS recommendations_outcome_metric_idx ON recommendations (outcome_metric) WHERE outcome_metric IS NOT NULL;
