-- Production Safety Gate (audit recommendation #1): moved off server.js's
-- boot path (see 052's header comment). One-time cleanup: stale
-- "High-energy days -> HRV" ledger rows from a backwards-causality finding
-- that's since been removed (energy is an OUTPUT of HRV, not a lever for
-- it). Only un-rated rows, so no user feedback is ever lost.
DELETE FROM recommendations
 WHERE outcome_measured_at IS NULL
   AND title ILIKE '%high-energy days%';
