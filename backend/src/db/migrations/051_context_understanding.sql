-- Context Understanding Layer — durable structured meaning compiled from
-- everything the user tells NormOS (chief-brief question answers, manual
-- briefing context, corrections/retractions). See
-- intelligence/context-compiler.js (extraction: Anthropic Structured
-- Outputs + deterministic temporal/negation/correction/identity
-- validation) and intelligence/context-resolver.js (the canonical
-- ResolvedContext projection every surface reads instead of independently
-- reinterpreting raw annotation text).
--
-- context_assertions: WHAT the user communicated. Linked to the annotations
-- row it was compiled from (annotations remains the raw-text audit trail;
-- this is the compiled structured layer on top) so persistence stays
-- atomic with the existing annotation write — see routes/annotations.js.
CREATE TABLE IF NOT EXISTS context_assertions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_annotation_id uuid REFERENCES annotations(id),
  source text NOT NULL,                            -- provenance: 'briefing_context' | 'ask' | 'voice' | 'checkin' | 'manual'
  raw_text text NOT NULL,
  assertion_type text NOT NULL,                     -- event|state|preference|constraint|plan|decision|correction|explanation|classification|completion
  subject text,
  predicate text,
  object_value text,
  entities jsonb NOT NULL DEFAULT '[]'::jsonb,
  concepts jsonb NOT NULL DEFAULT '[]'::jsonb,
  domains text[] NOT NULL DEFAULT '{}',
  event_status text NOT NULL DEFAULT 'occurred',    -- occurred|planned|ongoing|completed|negated|retracted|superseded
  effective_start timestamptz,
  effective_end timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  confidence numeric,
  source_authority text NOT NULL DEFAULT 'user',    -- user|device|established_knowledge|personal_experiment|personal_observation|model_hypothesis
  supersedes_assertion_id uuid REFERENCES context_assertions(id),
  compiler_version text NOT NULL,
  retired_at timestamptz,
  retired_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_context_assertions_active ON context_assertions (event_status, effective_start) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_context_assertions_annotation ON context_assertions (source_annotation_id);
CREATE INDEX IF NOT EXISTS idx_context_assertions_domains ON context_assertions USING gin (domains);

-- context_relations: WHY an assertion matters — how it connects to a target
-- (a metric, a calendar block, a goal, an action type, ...), carrying the
-- evidence tier that justifies (or doesn't) the language used to describe
-- it. Never deleted; retired (like annotations) so history/audit survives.
CREATE TABLE IF NOT EXISTS context_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_assertion_id uuid NOT NULL REFERENCES context_assertions(id),
  target_type text NOT NULL,                        -- metric|calendar_event|goal|commitment|workout|action_type|decision|domain
  target_id text NOT NULL,
  relationship text NOT NULL,                        -- explains|contributes_to|contradicts|constrains|enables|changes_priority|classifies|completes|invalidates|supersedes|supports
  direction text,                                    -- positive|negative|neutral
  evidence_basis text NOT NULL,                       -- user_explicit|established_knowledge|personal_experiment|personal_observation|canonical_fact|model_hypothesis
  confidence numeric,
  strength numeric,
  window_start timestamptz,
  window_end timestamptz,
  expires_at timestamptz,
  supporting_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  permitted_language text,
  unresolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,          -- set when an unresolved relation (a modeled open question) gets answered
  retired_at timestamptz,
  retired_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_context_relations_target ON context_relations (target_type, target_id) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_context_relations_source ON context_relations (source_assertion_id);
CREATE INDEX IF NOT EXISTS idx_context_relations_unresolved ON context_relations (unresolved) WHERE unresolved = true AND retired_at IS NULL;
