-- The Judgment and Attention Policy's ledger. One central decision point now
-- answers "given this event, what should NormOS do about it right now?" for
-- every domain (health/wellbeing/wealth watchers, finding-driven nudges,
-- check-ins) instead of each surface independently deciding to interrupt.
--
-- attention_log is simultaneously: the audit trail (every judged event, incl.
-- store_silently), the cross-surface dedup ledger (event_key + cooldown), the
-- novelty ledger (first-seen per key), and the daily interruption-budget
-- counter (count of notify_now/offer_action rows today). One table, four
-- jobs — deliberately not four separate tables, since they're all just
-- different queries over the same "what did the policy decide, and when" facts.
CREATE TABLE IF NOT EXISTS attention_log (
  id                BIGSERIAL PRIMARY KEY,
  event_key         TEXT NOT NULL,       -- domain:type:subject:bucket — see intelligence/events.js
  source            TEXT,
  domain            TEXT,
  type              TEXT,
  subject           TEXT,
  disposition       TEXT NOT NULL,       -- one of the 7 primary dispositions
  reason            TEXT,                -- concise human-readable explanation (which gate/threshold decided)
  scores            JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {value, urgency, interrupt, novelty, relevance}
  gates             JSONB NOT NULL DEFAULT '{}'::jsonb,  -- which deterministic gates fired
  delivered         BOOLEAN NOT NULL DEFAULT false,
  delivered_channel TEXT,                -- 'push' | 'brief' | 'question' | null
  outcome           TEXT,                -- 'dismissed' | 'ignored' | 'accepted' | 'completed' | null (pending)
  outcome_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cooldown/dedup lookups: "has this exact fact been surfaced recently?"
CREATE INDEX IF NOT EXISTS attention_log_key_time ON attention_log (event_key, created_at DESC);
-- Daily interruption-budget counter: only rows that actually consumed a slot.
CREATE INDEX IF NOT EXISTS attention_log_budget ON attention_log (created_at)
  WHERE disposition IN ('notify_now', 'offer_action');
-- Outcome-feedback promotion into beliefs (dismissal/ignore patterns per subject).
CREATE INDEX IF NOT EXISTS attention_log_outcome ON attention_log (domain, type, subject, outcome)
  WHERE outcome IS NOT NULL;

-- Explicit, revocable, per-capability consent for auto_act. Default-deny: no
-- row means no autonomous action. Never inferred from a read scope (e.g. a
-- calendar OAuth token existing is NOT permission to write to it).
CREATE TABLE IF NOT EXISTS consent_grants (
  capability_id  TEXT PRIMARY KEY,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ
);
