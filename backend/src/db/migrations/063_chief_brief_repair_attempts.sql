-- Durable ledger for automatic scoped Chief Brief repair attempts
-- (goals_stale, plan_conflict) — Chief Brief regression fix.
--
-- Root cause this exists to fix: the retry/cooldown marker for these
-- automatic repairs (goalsRepairAttempt / planConflictRepairAttempt) used to
-- be baked into the `briefings` content blob itself, which conflated
-- "did the last automatic repair attempt fail" with "what is the canonical
-- published daily briefing" — and once performScopedChiefBriefRebuild stops
-- inserting a new row on a FAILED attempt (see routes/briefing.js), there is
-- no longer any row to carry that marker at all. This is the smallest
-- reliable, durable, cross-instance mechanism to record it instead — one row
-- per repair reason, upserted on every attempt (not one row per attempt;
-- only the cooldown-relevant latest attempt matters here, unlike
-- morning_build_jobs' full per-attempt history).
CREATE TABLE IF NOT EXISTS chief_brief_repair_attempts (
  repair_reason text PRIMARY KEY, -- 'goals_stale' | 'plan_conflict'
  local_day date NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  succeeded boolean NOT NULL,
  -- Repair-specific context the attempt was scoped to (goals_stale: the
  -- week_start it was trying to fix), so a context change (the week rolling
  -- over) makes a new attempt eligible immediately instead of waiting out a
  -- cooldown for an already-moot fix. Null for repairs with no such context
  -- (plan_conflict).
  context_key text,
  reason_codes jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
);
