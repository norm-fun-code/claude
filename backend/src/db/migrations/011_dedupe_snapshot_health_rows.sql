-- Collapse historical duplicate daily rows for snapshot health metrics (HRV,
-- resting HR, sleep, etc.). Same root cause as migration 010 (pre-dayAnchorTs
-- every refresh wrote a new row), but snapshot metrics aggregate by AVG rather
-- than SUM, so the symptom is a noisier/lower daily average rather than
-- inflated totals.
--
-- Example: RHR is recalculated by Apple Health throughout the day, so an
-- early-morning sync might record 60 bpm while an evening sync records 54 bpm.
-- Before the noon-UTC anchor, both rows persist; dailyAggregate AVG returns
-- 57 bpm instead of the final (most accurate) 54 bpm, and the inflated day-to-
-- day noise makes baseline z-scores lower than they should be.
--
-- Keep the most recent row per (UTC-day, source, metric) — the latest reading
-- is the most complete (matches the post-fix upsert behavior).
WITH ranked AS (
  SELECT ctid,
         row_number() OVER (
           PARTITION BY date_trunc('day', ts), source, metric
           ORDER BY ts DESC
         ) AS rn
    FROM metrics
   WHERE domain = 'health'
     AND metric IN ('hrv', 'resting_hr', 'sleep_hours', 'sleep_score',
                    'deep_sleep_hours', 'rem_sleep_hours', 'respiratory_rate',
                    'vo2_max', 'weight', 'body_fat')
     AND source != 'seed'
)
DELETE FROM metrics m
 USING ranked r
 WHERE m.ctid = r.ctid
   AND r.rn > 1;
