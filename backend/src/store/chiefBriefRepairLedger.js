// Durable ledger for automatic scoped Chief Brief repair attempts (goals_stale,
// plan_conflict) — see migration 063. Replaces the old
// goalsRepairAttempt/planConflictRepairAttempt markers that used to be baked
// into the `briefings` content blob itself (routes/briefing.js's
// performScopedChiefBriefRebuild no longer inserts a row on a failed
// attempt, so there is no row left to carry that marker — and even before
// that change, mixing repair-attempt bookkeeping into the published content
// blurred the "what does the user see" / "what did the last attempt do"
// line this whole fix exists to draw).
'use strict';
const { query } = require('../db');

function localDay(d = new Date(), tz = process.env.TZ || 'America/New_York') {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

// Callers pass contextKey values sourced from a Postgres DATE column
// (store/intentions.js's weekStart) — the pg driver returns those as JS
// Date objects, not strings. Comparing a freshly-read Date object against a
// STRING read back from this table's own `text` column would never match by
// reference/format even for the identical calendar week (a Date `!==` any
// string), silently defeating the cooldown on every single check. Normalize
// to a plain YYYY-MM-DD string on both the write and the read/compare side.
function normalizeContextKey(k) {
  if (k == null) return null;
  return k instanceof Date ? k.toISOString().slice(0, 10) : String(k);
}

/** Upsert the latest attempt for a repair reason. One row per reason — only
 *  the latest attempt matters for cooldown/eligibility purposes. */
async function recordAttempt({ repairReason, succeeded, contextKey = null, reasonCodes = [], tz } = {}) {
  const day = localDay(new Date(), tz);
  await query(
    `INSERT INTO chief_brief_repair_attempts (repair_reason, local_day, attempted_at, succeeded, context_key, reason_codes)
     VALUES ($1, $2, now(), $3, $4, $5)
     ON CONFLICT (repair_reason) DO UPDATE
       SET local_day = EXCLUDED.local_day, attempted_at = now(), succeeded = EXCLUDED.succeeded,
           context_key = EXCLUDED.context_key, reason_codes = EXCLUDED.reason_codes, updated_at = now()`,
    [repairReason, day, succeeded, normalizeContextKey(contextKey), JSON.stringify(reasonCodes ?? [])]
  );
}

async function lastAttempt(repairReason) {
  const { rows } = await query(`SELECT * FROM chief_brief_repair_attempts WHERE repair_reason = $1`, [repairReason]);
  return rows[0] ?? null;
}

/**
 * Is a new automatic repair attempt allowed right now?
 *
 * The cooldown applies to EVERY prior attempt, success or failure. It used
 * to exempt successes (`if (!prior || prior.succeeded) return true`), on the
 * assumption that a successful repair fixes the underlying condition and so
 * won't re-trigger. In production it does re-trigger: a repair can "succeed"
 * (it produced a valid brief) without the triggering condition actually
 * clearing — the training-day contract still fails, or the goal week is
 * still mismatched. The condition is re-evaluated on the very next cache
 * serve, the ledger says "last attempt succeeded, go ahead", and a full
 * scoped LLM rebuild fires AGAIN. Every subsequent request repeats it:
 * observed in production as 7 rebuilds in 3 minutes while the user sat on a
 * loading card (Aug 6 2026), each one a fresh LLM call and a new briefings
 * row, and each one making GET /briefing slow enough to blow the mobile
 * client's fetch timeout so no brief ever rendered.
 *
 * A repair that just ran is therefore NOT retried until `cooldownMs` has
 * elapsed regardless of outcome. `contextKey` remains the deliberate escape
 * hatch: a genuinely NEW context (e.g. the week rolled over, so this is a
 * different problem than the one just attempted) is eligible immediately.
 */
function isEligible({ prior, contextKey = null, cooldownMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  if (!prior) return true;
  const normalizedKey = normalizeContextKey(contextKey);
  if (normalizedKey != null && prior.context_key !== normalizedKey) return true;
  return (now - new Date(prior.attempted_at).getTime()) > cooldownMs;
}

async function eligibleForRepair(repairReason, { contextKey = null, cooldownMs = 10 * 60 * 1000 } = {}) {
  return isEligible({ prior: await lastAttempt(repairReason), contextKey, cooldownMs });
}

module.exports = { recordAttempt, lastAttempt, eligibleForRepair, isEligible, localDay };
