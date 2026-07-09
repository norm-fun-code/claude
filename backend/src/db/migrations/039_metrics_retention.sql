-- Metrics retention/partitioning — see the engineering review's #7.
--
-- 001_init.sql already promotes `metrics` to a TimescaleDB hypertable when
-- the extension is present (docker-compose.yml's local dev image has it;
-- CI and most managed Postgres hosts, including a vanilla Railway Postgres,
-- do not). This migration adds native compression on top of that hypertable
-- for anyone who DOES have Timescale — a real, working retention mechanism
-- for the deployments where it applies, at zero cost to the rest.
--
-- Deliberately NOT deleting or downsampling anything here, on Timescale or
-- otherwise: this is a personal health/wealth diary, and there's no
-- generically "safe" age past which a user's own data stops mattering to
-- them (unlike, say, request logs). Compression preserves every row byte-
-- identical, queryable exactly as before — it just stores old chunks far
-- more efficiently. For vanilla Postgres (the likely production case), see
-- src/db/retention.js — an opt-in, tested, NOT-automatically-scheduled
-- archival tool, run manually if/when actual row count ever warrants it.
--
-- Uses EXECUTE for every Timescale-specific reference (timescaledb_information.*,
-- add_compression_policy, the timescaledb.compress storage params) — without
-- that, Postgres tries to resolve those catalog/function names when the DO
-- block is first parsed, and errors out immediately on a non-Timescale
-- database even though the enclosing IF would have skipped that branch.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_name = 'hypertables' AND table_schema = 'timescaledb_information'
    ) AND (
      SELECT count(*) FROM timescaledb_information.hypertables
       WHERE hypertable_name = 'metrics'
    ) = 1 THEN

      -- Segment by (domain, metric, source) — matches idx_metrics_domain_metric_ts
      -- and the query pattern every read in src/store/metrics.js uses (WHERE
      -- domain = ? AND metric = ? ORDER BY ts), so a compressed chunk can still
      -- be scanned efficiently for a single metric's history instead of
      -- decompressing the whole chunk.
      EXECUTE 'ALTER TABLE metrics SET (' ||
        'timescaledb.compress, ' ||
        'timescaledb.compress_segmentby = ''domain, metric, source'', ' ||
        'timescaledb.compress_orderby = ''ts DESC'')';

      -- Compress chunks older than 90 days — recent data (the hot read path:
      -- trend cards, the briefing, "last 7/30 days" everywhere) stays
      -- uncompressed for full write/update speed (insertMetrics's upsert
      -- touches recent rows constantly; compressed chunks are read-optimized,
      -- not update-friendly). Older chunks are compressed in place, not moved
      -- or deleted — every row stays queryable, just far smaller on disk.
      IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs
         WHERE proc_name = 'policy_compression' AND hypertable_name = 'metrics'
      ) THEN
        PERFORM add_compression_policy('metrics', INTERVAL '90 days');
      END IF;
    END IF;
  END IF;
END $$;
