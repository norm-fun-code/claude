-- Self-model: NormOS's consolidated, nightly-updated understanding of the user.
-- One row per run. The latest row is the active model; history is kept for
-- debugging and to see how the portrait evolves over time.
CREATE TABLE IF NOT EXISTS self_model (
  id           SERIAL PRIMARY KEY,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind         TEXT NOT NULL DEFAULT 'nightly',   -- 'nightly' | 'manual'
  content      TEXT NOT NULL,                      -- the full narrative self-model text
  snapshot     JSONB NOT NULL DEFAULT '{}'         -- structured data used to generate it
);

CREATE INDEX IF NOT EXISTS idx_self_model_generated ON self_model (generated_at DESC);
