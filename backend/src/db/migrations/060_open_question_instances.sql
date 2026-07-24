-- A server-owned canonical instance for every Chief Brief openQuestion the
-- moment it's generated — see intelligence/open-question-policy.js's
-- bindOpenQuestionInstance and intelligence/open-question-subject.js's
-- deterministic (non-LLM) calendar-load subject detector.
--
-- Root cause this exists to fix: the Chief Brief's freeform "one open
-- question" ("You have 9 hours of meetings tomorrow/today...") had no
-- server-side identity at all — mobile echoed back only the raw question
-- TEXT plus a text-derived fingerprint (see answered_open_questions,
-- migration 050), so an answer like "It's a Sabbath block, not actual
-- meetings" had nothing to bind to: no subject local date, no specific
-- work-busy block reference. routes/annotations.js could only guess from
-- the answer's own (often block/date-free) wording, or silently accept the
-- answer without ever changing the canonical meeting-load number.
--
-- This table is populated ONCE, at question-generation time (full daily
-- build and the scoped chief-brief-only rebuild), with whatever structured
-- subject the deterministic classifier could establish — never reconstructed
-- later from the answer. Mobile echoes back only `id`; the server loads
-- subject_type/subject_local_date/subject_block_ids from THIS row, never
-- from client-supplied metadata, when it's an identity-bearing question.
CREATE TABLE IF NOT EXISTS open_question_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The local date the question was ASKED/shown on (may differ from the date
  -- its subject describes — e.g. asked the evening before about tomorrow).
  local_date date NOT NULL,
  question_text text NOT NULL,
  fingerprint text,
  topic_key text,
  -- 'calendar_load' today; null for a generic (non-subject-bound) question,
  -- which answers exactly like the old free-text-only flow always did.
  subject_type text,
  -- The local date the SUBJECT describes (e.g. tomorrow's meeting load,
  -- asked about this evening).
  subject_local_date date,
  -- Deterministically resolved at generation time (see
  -- open-question-subject.js's pickBlockBinding): a single id when one
  -- block unambiguously carries the load (or one dominates it), multiple
  -- ids ONLY when subject_ambiguous is true (nothing was safe to bind
  -- automatically — answering requires a targeted clarification instead of
  -- a guess).
  subject_block_ids jsonb NOT NULL DEFAULT '[]',
  subject_ambiguous boolean NOT NULL DEFAULT false,
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_open_question_instances_date ON open_question_instances (local_date);
