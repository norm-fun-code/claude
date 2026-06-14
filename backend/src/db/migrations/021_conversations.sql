-- Conversation threads for "Ask NormOS". Previously chat was a single global
-- thread; this lets the user SAVE a conversation (archive it with a title),
-- browse saved ones in a sidebar, resume them, and delete them. Long-term
-- semantic memory still spans ALL messages regardless of thread.
CREATE TABLE IF NOT EXISTS conversations (
  id         SERIAL PRIMARY KEY,
  title      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  saved_at   TIMESTAMPTZ,                    -- non-null once the user saves it
  is_active  BOOLEAN NOT NULL DEFAULT false  -- the one live thread being added to
);

-- At most one active (live) thread at a time.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_active
  ON conversations (is_active) WHERE is_active;

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx
  ON chat_messages (conversation_id, id);

-- Fold any pre-existing single-thread messages into one active conversation.
WITH ins AS (
  INSERT INTO conversations (title, is_active)
  SELECT 'Earlier conversation', true
  WHERE EXISTS (SELECT 1 FROM chat_messages WHERE conversation_id IS NULL)
  RETURNING id
)
UPDATE chat_messages
   SET conversation_id = (SELECT id FROM ins)
 WHERE conversation_id IS NULL AND EXISTS (SELECT 1 FROM ins);
