-- First-seen ledger for the insight curation layer. The findings table is
-- superseded-and-recreated on every analysis run, so a finding's created_at
-- resets each time and can't tell us what's genuinely NEW vs. a stable pattern
-- that's been true for weeks. This ledger keys each finding by a stable
-- signature (type + the underlying metric/relationship, independent of the
-- exact numbers) and records when it was first and last observed. The curator
-- uses first_seen to score novelty — brand-new findings rank high, long-standing
-- patterns recede toward a floor so the "What The Data Shows" card surfaces what
-- changed rather than re-showing the same confirmed correlation every day.
CREATE TABLE IF NOT EXISTS finding_first_seen (
  signature   TEXT PRIMARY KEY,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);
