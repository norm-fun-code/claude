-- "What explains this?" — an optional context loop for meaningful anomaly
-- cards (audit item: anomaly-context). None of the three existing
-- open-question mechanisms fit: answered_open_questions/signal_answers only
-- track answered-vs-not (no "skipped" tri-state); open_question_instances'
-- subject_type is calendar-specific by convention; findings.id is destroyed
-- and recreated every analyze() run (supersedeAuto), so it can't anchor a
-- durable per-anomaly question. anomaly_key is the stable identity instead —
-- see intelligence/analyze.js's computeAnomalies, which derives it as
-- `anomaly:${metricKey}:${localObservationDate}` (at most one anomaly per
-- metric per run, so this is deterministic and stable across rebuilds).
--
-- This table intentionally snapshots the anomaly's observed/baseline/unit
-- fields at question-creation time rather than re-reading findings later —
-- findings are superseded+recreated every run and must not be relied on for
-- historical display once a question has been asked.
--
-- context_assertion_id links to the structured explanation once given (see
-- intelligence/anomalyContext.js's answerAnomalyContext, which forcibly
-- binds the compiled assertion's effective window to local_observation_date
-- via util/date.js's localDayBoundsUtc — never the wording-inferred date).
CREATE TABLE IF NOT EXISTS anomaly_context_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anomaly_key text NOT NULL UNIQUE,
  metric text NOT NULL,
  domains text[] NOT NULL DEFAULT '{}',
  observed_value numeric,
  baseline_mean numeric,
  baseline_std numeric,
  deviation numeric,
  unit text,
  observed_at timestamptz,
  local_observation_date date NOT NULL,
  tz text NOT NULL,
  source_fresh boolean NOT NULL DEFAULT true,
  -- unanswered | answered | skipped
  status text NOT NULL DEFAULT 'unanswered',
  raw_answer text,
  context_assertion_id uuid REFERENCES context_assertions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  retired_reason text
);

CREATE INDEX IF NOT EXISTS idx_anomaly_context_questions_date ON anomaly_context_questions (local_observation_date);
CREATE INDEX IF NOT EXISTS idx_anomaly_context_questions_status ON anomaly_context_questions (status) WHERE retired_at IS NULL;
