-- Surfaced-items ledger: tracks which knowledge highlights and insight cards
-- have already been shown, so the daily briefing never repeats the same one
-- within a rolling window (no-repeat freshness).

CREATE TABLE IF NOT EXISTS surfaced (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL,                 -- 'highlight' | 'insight'
  ref         TEXT NOT NULL,                 -- document id, or a stable insight key
  surfaced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_surfaced_kind_time ON surfaced (kind, surfaced_at DESC);
