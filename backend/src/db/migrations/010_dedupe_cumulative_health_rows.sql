-- Collapse historical duplicate daily rows for cumulative health metrics.
--
-- Before health.js anchored each reading to one stable per-day timestamp
-- (noon UTC of the local date), every app refresh wrote a NEW row: HealthKit's
-- getStepCount/getActiveEnergyBurned return the running daily total, so a single
-- day accrued many rows (e.g. 0, 4177, 8003, ..., 12771) as the day progressed
-- and got re-synced. These metrics aggregate by SUM, so the daily total — and
-- every weekly/Insights number built on it — was inflated several-fold
-- (observed: 14 rows summing to 64k steps for one day whose real total was 12.7k).
--
-- New data no longer duplicates (the noon-UTC anchor upserts on
-- (ts,domain,metric,source)), but the historical rows persist and keep
-- inflating the sums. Keep exactly one row per (UTC-day, source, metric): the
-- MAX, which is the final cumulative total for that day. Matches the UTC-day
-- bucketing that dailyAggregate's SUM uses, so the kept value is exactly what a
-- correct daily total should be.
WITH ranked AS (
  SELECT ctid,
         row_number() OVER (
           PARTITION BY date_trunc('day', ts), source, metric
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
