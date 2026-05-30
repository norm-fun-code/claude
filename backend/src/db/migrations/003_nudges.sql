-- Phase 6: proactive nudges.
--   devices — registered push targets (Expo push tokens) for this person's
--             phones, so NormOS can reach out instead of waiting to be opened.
--   nudges  — the log of what was pushed (and when), which doubles as the
--             de-dup ledger so the same insight doesn't nag day after day.

CREATE TABLE IF NOT EXISTS devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  push_token   TEXT NOT NULL UNIQUE,             -- Expo push token (ExponentPushToken[...])
  platform     TEXT,                             -- ios | android
  label        TEXT,                             -- e.g. "iPhone 15"
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nudges (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dedup_key  TEXT NOT NULL,                      -- stable per underlying insight (e.g. forecast:<goalId>)
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  priority   DOUBLE PRECISION NOT NULL DEFAULT 0,
  basis      JSONB NOT NULL DEFAULT '{}',        -- what this nudge was derived from
  status     TEXT NOT NULL DEFAULT 'pending',    -- pending | sent | failed | skipped
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_nudges_dedup ON nudges (dedup_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nudges_status ON nudges (status, created_at DESC);
