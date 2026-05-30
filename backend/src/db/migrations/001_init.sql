-- NormOS canonical schema.
--
-- Design principle: every numeric observation across every life domain becomes a
-- row in ONE table (`metrics`). Cross-domain correlation ("sleep vs productivity",
-- "spending vs happiness") is then a query, not a new integration. Text-bearing
-- content (books, highlights, notes, newsletters) lands in `documents` with vector
-- embeddings for the knowledge graph / semantic search.

-- TimescaleDB is an optional optimization (a hypertable for the metrics
-- time-series). Every query uses standard SQL (date_trunc), so NormOS runs
-- correctly on vanilla Postgres too — skip it gracefully if unavailable.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TimescaleDB unavailable; continuing on vanilla Postgres (metrics stays a plain table).';
END $$;

-- pgvector is required (knowledge-corpus embeddings).
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Sources: every registered connector / data provider.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,                 -- 'apple_health', 'google_calendar', ...
  domain       TEXT NOT NULL,                    -- health | wealth | productivity | learning | environment | system
  display_name TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',   -- active | paused | error
  config       JSONB NOT NULL DEFAULT '{}',
  last_sync_at TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Metrics: the canonical time-series spine for all numeric observations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metrics (
  ts       TIMESTAMPTZ NOT NULL,
  domain   TEXT NOT NULL,                        -- health | wealth | productivity | learning | environment
  metric   TEXT NOT NULL,                        -- 'hrv', 'resting_hr', 'net_worth', 'deep_work_minutes', ...
  value    DOUBLE PRECISION NOT NULL,
  unit     TEXT,                                 -- 'ms', 'bpm', 'usd', 'minutes', ...
  source   TEXT NOT NULL REFERENCES sources(id),
  metadata JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (ts, domain, metric, source)
);

-- Promote metrics to a TimescaleDB hypertable when the extension is present;
-- otherwise it stays a normal table (correct, just not as fast at large scale).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('metrics', 'ts', if_not_exists => TRUE);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_metrics_domain_metric_ts ON metrics (domain, metric, ts DESC);

-- ---------------------------------------------------------------------------
-- Documents: the knowledge corpus. embedding dim 768 = Gemini text-embedding-004.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source      TEXT NOT NULL REFERENCES sources(id),
  domain      TEXT NOT NULL,
  external_id TEXT,                              -- stable id from the source, for dedupe
  title       TEXT,
  author      TEXT,
  url         TEXT,
  content     TEXT NOT NULL,
  occurred_at TIMESTAMPTZ,                       -- when the content is "about"
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata    JSONB NOT NULL DEFAULT '{}',
  embedding   vector(768),
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_documents_domain ON documents (domain, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_embedding ON documents
  USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Findings: outputs of the intelligence layer (correlations, trends, risks...).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS findings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  type         TEXT NOT NULL,                    -- correlation | trend | risk | bottleneck | leverage | hypothesis
  domains      TEXT[] NOT NULL DEFAULT '{}',
  title        TEXT NOT NULL,
  detail       TEXT,
  confidence   DOUBLE PRECISION,                 -- 0..1
  status       TEXT NOT NULL DEFAULT 'open',     -- open | confirmed | refuted | dismissed
  window_start TIMESTAMPTZ,
  window_end   TIMESTAMPTZ,
  evidence     JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_findings_status ON findings (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Goals: tracked objectives, optionally bound to a metric for forecasting.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS goals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain         TEXT NOT NULL,
  title          TEXT NOT NULL,
  metric         TEXT,                           -- which `metrics.metric` tracks progress
  target_value   DOUBLE PRECISION,
  baseline_value DOUBLE PRECISION,
  unit           TEXT,
  target_date    DATE,
  status         TEXT NOT NULL DEFAULT 'active', -- active | achieved | missed | abandoned
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata       JSONB NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------------------
-- Briefings: persisted daily / weekly / quarterly narratives for history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS briefings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL DEFAULT 'daily',    -- daily | weekly | quarterly
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  period_start TIMESTAMPTZ,
  period_end   TIMESTAMPTZ,
  content      JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_briefings_kind_time ON briefings (kind, generated_at DESC);
