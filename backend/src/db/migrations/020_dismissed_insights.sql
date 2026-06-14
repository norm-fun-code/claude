-- User-dismissed "What The Data Shows" insights. Keyed by a STABLE signature
-- (type + the insight title with numbers stripped) so a recurring insight whose
-- dollar amount drifts month to month — e.g. "Review: Honda Financial is $6,924/yr"
-- — stays dismissed even as the figure changes. Card-level dismissal: the
-- underlying finding/computation is untouched; we just stop surfacing it.
CREATE TABLE IF NOT EXISTS dismissed_insights (
  dismiss_key  TEXT PRIMARY KEY,
  title        TEXT,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
