-- Production Safety Gate (audit recommendation #1): moved off server.js's
-- boot path (see 052's header comment for why running data-mutating DELETEs
-- on every restart is unsafe). One-time cleanup: environment-metric
-- correlations now come exclusively from computeDaytimeCardio (Apple Watch
-- daytime HRV/RHR), never the general Pearson engine, and several pairs are
-- tautological (exercise habit -> active energy) or backwards-causal
-- (energy is an OUTPUT of HRV, not a lever for it) and are no longer
-- generated. This only ever matches legacy rows from before those fixes.
DELETE FROM findings
 WHERE evidence->>'kind' = 'correlation'
   AND (
     evidence->>'a' LIKE 'environment:%'
     OR evidence->>'b' LIKE 'environment:%'
     OR (evidence->>'a', evidence->>'b') IN (
       ('habits:exercise','health:active_energy'),('health:active_energy','habits:exercise'),
       ('habits:exercise','health:exercise_minutes'),('health:exercise_minutes','habits:exercise'),
       ('health:exercise_minutes','health:active_energy'),('health:active_energy','health:exercise_minutes'),
       ('health:hrv','wellbeing:energy'),('wellbeing:energy','health:hrv'),
       ('health:resting_hr','wellbeing:energy'),('wellbeing:energy','health:resting_hr')
     )
   );
