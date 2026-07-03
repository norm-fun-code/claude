-- Commitments: the missing middle of the loop. NormOS already ADVISES (briefs,
-- recs) and GRADES (evening day-close), but between those two it went silent —
-- everything it asked of you was only checked after the fact. A commitment is a
-- thing you said you'd do (by voice, from a brief, or typed), optionally with a
-- due time, that gets an on-time follow-up nudge and is graded that evening.
--
-- This turns an advisor into a chief of staff: it doesn't just tell you to wind
-- down early — it reminds you at 9pm and notes whether it happened.

CREATE TABLE IF NOT EXISTS commitments (
  id            SERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- what you committed to, in your own words ("wind down by 10:30", "book the doctor")
  title         TEXT NOT NULL,
  detail        TEXT,
  -- where it came from: voice | brief | chat | manual
  source        TEXT NOT NULL DEFAULT 'voice',
  -- when it should happen / when to nudge. NULL = an untimed "someday" commitment
  -- (shows on Today, never pushes).
  due_at        TIMESTAMPTZ,
  -- open | done | skipped | expired
  status        TEXT NOT NULL DEFAULT 'open',
  -- optional outcome metric (e.g. 'habits:cold_shower') so the runner can skip a
  -- nudge for something the data already shows you did, and the evening brief can
  -- auto-grade it.
  metric_key    TEXT,
  completed_at  TIMESTAMPTZ,
  -- last time a follow-up nudge fired for this commitment (dedup / restraint).
  reminded_at   TIMESTAMPTZ
);

-- The runner scans for open, due, not-yet-reminded rows every few minutes.
CREATE INDEX IF NOT EXISTS commitments_due_idx
  ON commitments (due_at)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS commitments_status_idx ON commitments (status);
