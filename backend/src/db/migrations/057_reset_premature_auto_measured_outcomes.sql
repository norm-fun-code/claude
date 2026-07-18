-- Production Safety Gate (audit recommendation #1): moved off server.js's
-- boot path (see 052's header comment) — this is store/recommendations.js's
-- former clearPrematureAutoOutcomes(), ported to SQL since its logic is a
-- single deterministic, idempotent UPDATE. One-time repair: the old
-- recommendation-outcome engine auto-measured after only ~3 days, so
-- short-window noise got stamped "No effect" before the effect had a real
-- chance to show. The engine now requires MIN_ELAPSED_DAYS = 7 (see
-- store/recommendations.js) before auto-measuring — this resets any
-- already-persisted outcome that was measured before a FULL 7 days had
-- elapsed back to "Measuring…" (outcome_delta/outcome_measured_at NULL) so
-- it gets re-judged once real data is in. User thumbs are preserved: those
-- write an exact ±1 delta, which an auto-measurement (a raw metric
-- difference) effectively never produces, hence the `abs(...) <> 1` guard.
-- Only ever matches legacy rows measured under the old 3-day threshold.
UPDATE recommendations
   SET outcome_delta = NULL, outcome_measured_at = NULL
 WHERE outcome_measured_at IS NOT NULL
   AND outcome_delta IS NOT NULL
   AND abs(outcome_delta) <> 1
   AND outcome_measured_at < created_at + interval '7 days';
