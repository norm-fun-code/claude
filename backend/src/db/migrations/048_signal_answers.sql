-- Durable, server-side ledger of pre-brief signal answers, keyed by a STABLE
-- subject + local date (e.g. subject_key='calendar_load', local_date=
-- '2026-07-17') rather than by a per-build signal object. This is what lets
-- yesterday's "tomorrow's calendar is heavily blocked" question and today's
-- "packed calendar" question — both about the SAME underlying date — share
-- one answer and suppress each other. The client's AsyncStorage cache is only
-- an optimistic UI layer in front of this; this table is the authority.
CREATE TABLE IF NOT EXISTS signal_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_key text NOT NULL,
  local_date date NOT NULL,
  fingerprint text,
  answer text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_key, local_date)
);

CREATE INDEX IF NOT EXISTS idx_signal_answers_subject_date ON signal_answers (subject_key, local_date);
