-- Methodology fix (see intelligence/analyze.js's computeHabitHealthSplits):
-- lag>=2 habit_split findings (a behavior's effect claimed to show up TWO OR
-- MORE mornings later) are scientifically weak to draw from daily
-- observational data — a two-night-delayed physiological claim has no
-- holdout-stability check behind it and is easy to manufacture from noise
-- across enough habit x outcome x lag combinations. analyze.js no longer
-- computes lag>=2 at all (only same-day and next-day/lag=1, the latter now
-- gated on a raised minimum group size AND chronological holdout stability).
--
-- One-time cleanup: any already-persisted open habit_split finding with
-- evidence.lag >= 2 is superseded here so it stops reaching the Health tab,
-- the self-model, cross-context synthesis, and leverage actions immediately
-- on deploy, without waiting for the next scheduled analyze() run. History is
-- preserved (status flips to 'superseded', row kept) — matches
-- supersedeAuto's convention (see store/findings.js).
UPDATE findings
   SET status = 'superseded'
 WHERE status = 'open'
   AND type = 'habit_split'
   AND (evidence->>'lag')::numeric >= 2;

-- Also supersede the current cross_context set — any existing insight may
-- have been synthesized partly from a lag>=2 habit_split finding just
-- removed above. crossContext.generateCrossContext() regenerates this type
-- from scratch (from whatever relationships are still open) on its next
-- scheduled run, so this is a one-time invalidation, not a permanent hole.
UPDATE findings
   SET status = 'superseded'
 WHERE status = 'open'
   AND type = 'cross_context';
