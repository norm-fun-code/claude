'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS planner_state (
      id INT PRIMARY KEY DEFAULT 1,
      state JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT single_row CHECK (id = 1)
    );

    CREATE TABLE IF NOT EXISTS scenarios (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      params JSONB NOT NULL DEFAULT '{}',
      results JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS advisor_chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      messages JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      plan_year INT,
      params JSONB NOT NULL DEFAULT '{}',
      summary JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Dated pictures of the account side, so changes can be explained later. The complete
    -- flag records whether every balance was known at the time: a snapshot taken with a gap is
    -- short by an unknown amount and must not be differenced.
    CREATE TABLE IF NOT EXISTS wealth_snapshots (
      id          BIGSERIAL PRIMARY KEY,
      as_of       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      net_worth   NUMERIC NOT NULL,
      accessible  NUMERIC,
      by_class    JSONB NOT NULL DEFAULT '{}'::jsonb,
      complete    BOOLEAN NOT NULL DEFAULT TRUE,
      note        TEXT
    );
    CREATE INDEX IF NOT EXISTS wealth_snapshots_as_of ON wealth_snapshots (as_of DESC);
    -- Account classification, keyed on the provider's STABLE id rather than the display
    -- name, so renaming an account in Monarch cannot silently reclassify net worth.
    CREATE TABLE IF NOT EXISTS account_classes (
      account_id  TEXT PRIMARY KEY,
      class       TEXT NOT NULL,
      stripe_kind TEXT,
      note        TEXT,
      set_by      TEXT NOT NULL DEFAULT 'user',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Hiding is a flag, not a class: a closed 2014 savings account is still cash, and
    -- folding "hidden" into the class would throw the classification away the moment it is
    -- hidden. Kept dated and reversible, with the name recorded so a hidden account can be
    -- listed and restored even if the provider stops returning it at all.
    ALTER TABLE account_classes ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE account_classes ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;
    ALTER TABLE account_classes ADD COLUMN IF NOT EXISTS hidden_name TEXT;
    ALTER TABLE account_classes ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
    -- Dated, per-account confirmations. The ONLY thing permitted to turn a missing provider
    -- balance into a number. raw_missing preserves what the provider actually returned so
    -- the gap stays visible after the override is applied.
    CREATE TABLE IF NOT EXISTS account_overrides (
      account_id   TEXT PRIMARY KEY,
      account_name TEXT,
      balance      NUMERIC,
      raw_missing  TEXT,
      note         TEXT,
      confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      superseded_at TIMESTAMPTZ
    );
    -- Alert state, keyed on the monitor's STABLE condition key rather than a row id, so a
    -- dismissal survives the alert being re-detected on the next refresh. Dismissed and
    -- resolved are permanent; snoozed carries an expiry and reopens on its own.
    CREATE TABLE IF NOT EXISTS alert_states (
      alert_key   TEXT PRIMARY KEY,
      state       TEXT NOT NULL CHECK (state IN ('open','dismissed','snoozed','resolved')),
      snooze_until TIMESTAMPTZ,
      note        TEXT,
      since       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- Kept for the record so a resolved alert can still be read back with what it said.
      last_seen   JSONB
    );

    -- Decisions, their reasoning, and the conditions that should re-open them. The whole
    -- point is the rationale and the trigger, not the choice: a decision without its reason
    -- cannot be reviewed later, only second-guessed.
    CREATE TABLE IF NOT EXISTS decisions (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      choice      TEXT,
      rationale   TEXT NOT NULL,
      alternatives JSONB NOT NULL DEFAULT '[]'::jsonb,
      assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- [{id, metric, op, value, description}] — evaluated by monitors.js, never by a model.
      reconsider_when JSONB NOT NULL DEFAULT '[]'::jsonb,
      review_by   DATE,
      status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retired')),
      superseded_by TEXT,
      decided_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Figures that can only come from a document, held with their provenance. Nothing here
    -- is used by the model until reviewed = TRUE.
    CREATE TABLE IF NOT EXISTS tax_facts (
      id          BIGSERIAL PRIMARY KEY,
      tax_year    INT NOT NULL,
      field       TEXT NOT NULL,
      value       NUMERIC,
      source_kind TEXT NOT NULL,
      source_name TEXT,
      locator     TEXT,
      reviewed    BOOLEAN NOT NULL DEFAULT FALSE,
      reviewed_at TIMESTAMPTZ,
      superseded_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tax_facts_current
      ON tax_facts (tax_year, field) WHERE superseded_at IS NULL;

    -- Briefings. status starts 'pending' and only becomes 'ready' once the whole thing is
    -- written, so a half-generated briefing can never be read as a finished one. A failure
    -- is recorded as a failure rather than leaving the last good briefing to look current.
    CREATE TABLE IF NOT EXISTS briefings (
      id          TEXT PRIMARY KEY,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')),
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      detection   JSONB,
      narrative   TEXT,
      error       TEXT,
      -- Whether every monitor actually ran. A briefing built over a gap says so.
      complete    BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS briefings_ready
      ON briefings (generated_at DESC) WHERE status = 'ready';

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

module.exports = { pool, query: (...args) => pool.query(...args), initSchema };
