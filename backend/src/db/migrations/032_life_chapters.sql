-- Life chapters: persistent long-arc facts about the user's life (a pregnancy
-- and its due date, a big deadline, a season of life) that should inform every
-- brief without being re-typed into weekly context. Unlike annotations (which
-- expire in days) these auto-advance: a pregnancy chapter derives the current
-- week from the due date, a countdown derives days remaining.
CREATE TABLE IF NOT EXISTS life_chapters (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           TEXT NOT NULL DEFAULT 'countdown', -- 'pregnancy' | 'countdown' | 'note'
  label          TEXT NOT NULL,                     -- "Nancy pregnant", "Q3 board deck"
  key_date       DATE,                              -- the anchor date (due date, deadline)
  key_date_label TEXT,                              -- "due", "deadline", "starts"
  notes          TEXT,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_life_chapters_active ON life_chapters (active, key_date);
