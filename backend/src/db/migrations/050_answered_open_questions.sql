-- Durable, server-side record of the chief brief's answered "one open
-- question" — see intelligence/open-question-policy.js. Previously,
-- "already answered" was inferred by scanning recent 'brief_context'
-- annotations for word overlap with a freshly-generated openQuestion, which
-- only the FULL daily build ever did (the scoped chief-brief-only rebuild
-- skipped it entirely, so the same question could resurface immediately
-- after being answered). This table is the one authoritative ledger every
-- generation path checks, keyed by LOCAL DATE so a genuinely new occurrence
-- on a later day is never suppressed.
CREATE TABLE IF NOT EXISTS answered_open_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_date date NOT NULL,
  question_text text NOT NULL,
  fingerprint text,
  topic_key text,
  answer text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_answered_open_questions_date ON answered_open_questions (local_date);
