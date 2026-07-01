-- NOTE (audit, added after the fact — do not edit the DDL below, it has already
-- applied): this CREATE TABLE is a permanent no-op. 001_init.sql already creates
-- `goals` with a different, authoritative schema (domain NOT NULL, DOUBLE
-- PRECISION columns, plus a `metadata JSONB` column that seed.js/server.js
-- depend on for cleanup queries) and always runs first, so IF NOT EXISTS here
-- never fires. 025_goals_domain_nullable.sql is the real fix for the
-- domain-nullability this migration seems to have been trying to make — this
-- file was left behind rather than removed. Harmless as long as migrations keep
-- running in filename order (001 before 024), which the runner guarantees.
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
