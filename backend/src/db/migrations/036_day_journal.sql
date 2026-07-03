-- Daily context journal — the narrative subjective signal. The app already has
-- the numbers (metrics) and thin subjective ratings (mood/energy/focus 1-5), but
-- not the STORY: why today was hard, that there was a launch or a fight or a bad
-- night. A free-text daily recap ("today's context: …", captured by voice) is
-- the richest input the N-of-1 engine can get.
--
-- It flows into: the Ask brain (so "why was I tired last week?" can cite "you
-- noted a stressful launch Wednesday"), the evening brief (tonight reflects
-- today), and the nightly self-model consolidation — where, over weeks, it
-- distills into learned patterns ("Mondays read stressful", "you sleep worse
-- after travel") rather than being replayed raw forever.

CREATE TABLE IF NOT EXISTS day_journal (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- the local day this context is ABOUT (multiple entries per day are allowed;
  -- they append rather than overwrite).
  entry_date  DATE NOT NULL,
  text        TEXT NOT NULL,
  -- voice | chat | manual
  source      TEXT NOT NULL DEFAULT 'voice'
);

CREATE INDEX IF NOT EXISTS day_journal_date_idx ON day_journal (entry_date DESC);
