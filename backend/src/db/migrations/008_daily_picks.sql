-- Day-locked content picks (e.g. the Wisdom tab's Readwise highlight set), so a
-- pick made on the first request of the day stays identical all day across
-- devices and pull-to-refresh — matching how the Notion page and daily quote
-- are already day-locked in the briefing. One row per (kind, pick_date).
CREATE TABLE IF NOT EXISTS daily_picks (
  kind       TEXT NOT NULL,         -- e.g. 'highlights'
  pick_date  DATE NOT NULL,         -- local calendar date the pick covers
  payload    JSONB NOT NULL,        -- the chosen content (array of ids/objects)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, pick_date)
);
