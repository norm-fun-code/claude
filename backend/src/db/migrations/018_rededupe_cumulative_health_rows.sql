-- Re-run the cumulative-health dedupe (see 010). Migration 010 collapsed the
-- duplicate daily rows that existed on Jun 8, but the Jun 13 Apple Health
-- backfill then inserted a fresh noon-UTC "complete daily total" row alongside
-- the older partial row that 010 had kept — at a DIFFERENT timestamp (the old
-- pre-anchor-fix request-time ts), so it landed as a second row in the same day
-- rather than upserting. Since these metrics aggregate by SUM, the two rows get
-- added together (observed: Jun 2 = 2,885 + 12,771 = 15,656 instead of 12,771).
--
-- Collapse to exactly one row per (day, source, metric) again — keep the MAX,
-- which is the day's final cumulative total. Idempotent: a no-op once there's a
-- single row per day. Recent days that have only a partial row are unaffected
-- here; those are corrected by the client re-pushing complete daily totals.
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
