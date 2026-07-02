-- Cached TTS audio (brief narrations). Keyed on content hash so a rebuilt
-- brief re-synthesizes and an unchanged one serves from cache. Rows are small
-- in number (one-ish per day) and pruned on write.
CREATE TABLE IF NOT EXISTS tts_audio (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key  TEXT NOT NULL UNIQUE,
  audio      BYTEA NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'audio/wav',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
