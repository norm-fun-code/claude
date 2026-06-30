-- "I didn't wear my watch for this" flag. When true, NormOS estimates the
-- steps + active energy this activity burned (from type × duration × body weight)
-- and credits them to the day's totals under source 'activity_est'. When false
-- (the default, preserving prior behavior), the watch already measured movement,
-- so no estimate is written and there's no double-counting.
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS no_watch BOOLEAN NOT NULL DEFAULT false;
