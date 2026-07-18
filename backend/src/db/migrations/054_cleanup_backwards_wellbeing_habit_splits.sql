-- Production Safety Gate (audit recommendation #1): moved off server.js's
-- boot path (see 052's header comment). One-time cleanup: habit_split
-- findings whose lever is a subjective wellbeing state (high-mood/
-- high-energy/high-focus days) invert causality — mood/energy/focus are
-- OUTPUTS of recovery, not levers that drive HRV/sleep. No longer
-- generated; this only ever matches legacy rows already in the DB.
DELETE FROM findings
 WHERE evidence->>'kind' = 'habit_split'
   AND evidence->>'habit' IN ('High-mood days', 'High-energy days', 'High-focus days');
