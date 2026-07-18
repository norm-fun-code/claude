-- Production Safety Gate (audit recommendation #1): moved off server.js's
-- boot path (see 052's header comment). One-time cleanup: the sleep_impact
-- finding's title was reworded from "Best sleep nights -> NN% better X" to
-- "Best sleep nights lift your next-day X" — same insight, different words,
-- so dedup-by-title/dedup_key can't tell an old-worded row and a
-- new-worded row for the same underlying finding are duplicates. Drops the
-- old-worded row only when a new-worded one already exists for the same
-- run; never touches a rated row (outcome_measured_at IS NULL guards that).
DELETE FROM recommendations r
 WHERE r.outcome_measured_at IS NULL
   AND r.title ~* '^Best sleep nights? →'
   AND EXISTS (
     SELECT 1 FROM recommendations r2
      WHERE r2.id <> r.id
        AND r2.title ILIKE 'Best sleep nights lift%'
   );
