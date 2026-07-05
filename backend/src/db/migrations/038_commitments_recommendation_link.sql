-- Links a commitment back to the recommendation it was auto-created from, so
-- resolving the commitment (done/skipped) can close the loop on a
-- metric-less recommendation — one that has no outcome_metric to auto-measure
-- against (chat-sourced <rec> tags, and leverage findings without a basis
-- outcome). ON DELETE SET NULL: recommendations can be swipe-deleted without
-- taking the commitment down with them.
ALTER TABLE commitments
  ADD COLUMN IF NOT EXISTS recommendation_id INTEGER REFERENCES recommendations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS commitments_recommendation_idx ON commitments (recommendation_id);
