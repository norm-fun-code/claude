-- Add pause support to experiments: a paused experiment stops the clock until
-- resumed, at which point end_date is extended by the days paused.
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
