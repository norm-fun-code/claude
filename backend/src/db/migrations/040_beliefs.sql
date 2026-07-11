-- Durable beliefs — what NormOS has LEARNED about the user, as opposed to what
-- it can recompute from raw metrics each night. A full learning-loop audit
-- found that every feedback signal (things the user says, dismissal patterns,
-- measured recommendation outcomes) either decays out of a 14-day rolling
-- context window or terminates in one-off prompt text; nothing the user
-- teaches the system persists. This table is the durable home for exactly the
-- knowledge that has none today:
--
--   user_statement       — a durable preference/constraint/fact the user stated
--                          ("I skip cold showers when sick"), extracted from
--                          the day journal / brief-context answers
--   dismissal_pattern    — a type-level preference inferred from repeatedly
--                          dismissing the same kind of insight
--   recommendation_outcome — a lever→outcome pattern the ledger has measured
--                          enough times to state as a belief
--
-- Deliberately NOT stored here (to keep one source of truth per fact):
-- experiment verdicts (experiments table already persists them; the self-model
-- renders PROVEN ON YOU / RULED OUT from it) and forecast calibration (its own
-- ledger). Beliefs are only for knowledge with no other durable home.
CREATE TABLE IF NOT EXISTS beliefs (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  -- Stable identity so re-promotion UPDATES the belief instead of duplicating
  -- it (e.g. 'dismissal:subscription_review', 'stated:cold-showers-when-sick').
  dedup_key   TEXT NOT NULL UNIQUE,
  -- One plain human-readable sentence — written to be injected verbatim into
  -- the self-model text every surface reads.
  statement   TEXT NOT NULL,
  confidence  REAL,
  evidence    JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- active | retired. Retired beliefs stay as history but stop being surfaced;
  -- a retired belief is never silently resurrected by re-promotion.
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS beliefs_status_kind_idx ON beliefs (status, kind);
