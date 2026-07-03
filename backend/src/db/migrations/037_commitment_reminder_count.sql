-- Persistent follow-through: a commitment used to fire ONE reminder and then go
-- quiet, even if you never did it. Now it re-nudges every few hours until you
-- complete or skip it. reminder_count caps how many times total, so persistence
-- never becomes nagging (paired with the re-nudge interval, quiet hours, a
-- max-age cutoff, and the daily push cap already in the runner).
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0;
