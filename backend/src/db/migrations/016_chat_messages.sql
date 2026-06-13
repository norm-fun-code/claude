-- Persistent chat memory: every Q&A turn is appended here so conversations
-- survive app restarts and NormOS can pull a thread across sessions ("tell me
-- more about the sleep-spending thing"). Single-user, so a flat append log is
-- enough; the most recent N turns are loaded back as context per question.
CREATE TABLE IF NOT EXISTS chat_messages (
  id         SERIAL PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  sources    JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages (created_at DESC);
