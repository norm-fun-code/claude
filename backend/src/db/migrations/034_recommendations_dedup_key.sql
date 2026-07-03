-- The recommendation ledger deduped by fuzzy title text (number-normalized).
-- That breaks whenever a finding's title copy gets reworded — e.g. the
-- sleep_impact title changed from "Best sleep nights → 13% better HRV" to
-- "Best sleep nights lift your next-day HRV" — because the two phrasings
-- don't collapse to the same normalized string, so both live on in the ledger
-- as if they were separate insights. dedup_key is a stable identifier derived
-- from the finding's basis (kind + lever/outcome/metric/habit/activity/goal),
-- which doesn't change when the display copy is tuned.
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS dedup_key TEXT;
CREATE INDEX IF NOT EXISTS recommendations_dedup_key_idx ON recommendations (dedup_key) WHERE dedup_key IS NOT NULL;
