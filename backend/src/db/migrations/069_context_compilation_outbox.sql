-- Durable retry ledger for user-context compilation. A raw statement is the
-- audit record; ContextAssertions are its canonical structured projection.
-- If the compiler provider is temporarily unavailable, we must not silently
-- leave the statement as raw-only forever.
CREATE TABLE IF NOT EXISTS context_compilation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_annotation_id uuid REFERENCES annotations(id),
  raw_text text NOT NULL,
  source text NOT NULL,
  question text,
  timezone text NOT NULL DEFAULT 'America/New_York',
  recorded_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  completed_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'canceled'))
);

CREATE INDEX IF NOT EXISTS context_compilation_jobs_pending_idx
  ON context_compilation_jobs (status, next_attempt_at, created_at);

-- A raw annotation has at most one live compilation job. Retried attempts
-- update that one row rather than duplicating structured context later.
CREATE UNIQUE INDEX IF NOT EXISTS context_compilation_jobs_one_live_annotation_idx
  ON context_compilation_jobs (source_annotation_id)
  WHERE source_annotation_id IS NOT NULL AND status IN ('pending', 'processing');

-- User statements used to be promoted into `beliefs` by a nightly LLM pass.
-- Assertions are now the sole authority for what the user said; beliefs are
-- reserved for learned policies and inferred/confirmed outcome patterns.
INSERT INTO context_assertions
  (source, raw_text, assertion_type, subject, predicate, object_value,
   entities, concepts, domains, event_status, recorded_at, confidence,
   source_authority, compiler_version)
SELECT
  'legacy_user_statement_belief_migration', b.statement, 'state', 'user',
  'stated', b.statement, '[]'::jsonb, '[]'::jsonb, ARRAY['other']::text[],
  'occurred', b.updated_at, b.confidence, 'user', 'legacy-belief-migration-v1'
FROM beliefs b
WHERE b.kind = 'user_statement'
  AND b.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM context_assertions a
     WHERE a.source = 'legacy_user_statement_belief_migration'
       AND a.raw_text = b.statement
  );

UPDATE beliefs
   SET status = 'retired', updated_at = now()
 WHERE kind = 'user_statement' AND status = 'active';
