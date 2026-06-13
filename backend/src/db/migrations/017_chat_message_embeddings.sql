-- Long-term conversational memory: embed each user question so a NEW question
-- can semantically recall RELEVANT PAST conversations beyond the recent tail —
-- the "last time you asked about X, here's what we concluded" capability. Same
-- 768-dim space as documents.embedding so we reuse the existing embed provider.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS embedding vector(768);

-- Partial index over only the embedded rows (user questions). Single-user scale
-- is small, but this keeps the cosine-distance recall fast as the log grows.
CREATE INDEX IF NOT EXISTS idx_chat_messages_embedding
  ON chat_messages USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50)
  WHERE embedding IS NOT NULL;
