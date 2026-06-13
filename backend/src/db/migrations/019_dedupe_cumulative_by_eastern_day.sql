-- Bulletproof ET-day dedupe of cumulative health rows.
--
-- 018 partitioned by date_trunc('day', ts), which resolves the day in the DB
-- session's timezone. If two rows for the same Eastern calendar day straddle a
-- UTC midnight (e.g. an 8pm EST reading is 00:00 UTC the next day), they fall in
-- different UTC-day buckets and the dedupe misses them — leaving the duplicate
-- rows that inflate the daily SUM (observed: Jun 2 = 12,771 + 14,448 = 27,219).
--
-- Partition explicitly by the EASTERN calendar day so same-day rows always
-- collapse regardless of session timezone, keeping the MAX (the day's true
-- cumulative total). Idempotent — a no-op once there's one row per Eastern day.
WITH ranked AS (
  SELECT ctid,
         row_number() OVER (
           PARTITION BY (ts AT TIME ZONE 'America/New_York')::date, source, metric
           ORDER BY value DESC, ts DESC
         ) AS rn
    FROM metrics
   WHERE domain = 'health'
     AND metric IN ('steps', 'active_energy', 'exercise_minutes', 'mindful_minutes')
)
DELETE FROM metrics m
 USING ranked r
 WHERE m.ctid = r.ctid
   AND r.rn > 1;
