// Durable morning-brief build-job ledger (see migration 061). One row per
// build ATTEMPT — a retry creates a new row with attempt_number incremented,
// so the client's status poll (and any diagnostic) can see the full attempt
// history for the day. This is the durable identity POST /briefing/rebuild
// hands back instead of a bare timestamp — see mobile/src/hooks/useBriefing.ts,
// which used to infer "the rebuild finished" from builtAt alone and could
// mistake a degraded/blank attempt for success.
'use strict';
const crypto = require('crypto');
const { query } = require('../db');

// This process's own lease-owner identity (deployment-safe recovery, item
// 5) — stable for the life of this process, unique across replicas/restarts.
// Any build job this process creates or heartbeats stamps this value into
// lease_owner, so a startup recovery scan by the NEXT process (a fresh PID,
// therefore a fresh PROCESS_LEASE_OWNER) can tell "a DIFFERENT process
// abandoned this" apart from "I'm still the one working on it."
const PROCESS_LEASE_OWNER = `${process.pid}-${crypto.randomUUID()}`;

// 'interrupted' (migration 068): the explicit terminal state a startup
// recovery scan stamps on a job whose lease expired before it reached
// ready/failed — see recoverInterruptedJobs below. Distinct from 'failed' so
// diagnostics can tell "the generation itself failed" from "the process
// that owned this job died before it could report anything at all."
const VALID_STATES = new Set(['waiting_for_sleep', 'queued', 'building', 'retry_wait', 'ready', 'failed', 'interrupted']);

// How long a lease is valid without a heartbeat renewal before another
// process may declare it abandoned (migration 068's lease_owner/
// lease_expires_at) — replaces the old "wait out STALE_IN_FLIGHT_MS (15min)"
// as the ONLY way to notice a dead process's job. touchHeartbeat renews this
// on every 20s tick, so a genuinely-dead process is detectable within
// roughly one missed renewal window, not 15 minutes.
const LEASE_DURATION_MS = 60 * 1000;

function localDay(d = new Date(), tz = process.env.TZ || 'America/New_York') {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/** Start a new build-attempt row. `attemptNumber` should be 1 + however many
 *  prior attempts exist for today (see attemptsToday below) — the caller
 *  computes this so the count is visible without a second round trip here.
 *  `leaseOwner`/`correlationId` are optional identifiers for the process
 *  instance and end-to-end log correlation (see migration 068) — a job
 *  created without them (legacy callers) simply has no lease/correlation
 *  until the first touchHeartbeat/acquireLease call.
 *
 *  Relies on idx_morning_build_jobs_one_active_per_day (migration 068) for
 *  true single-flight enforcement: a concurrent second INSERT for the same
 *  local_day while one is already non-terminal raises a unique-violation
 *  (Postgres error code 23505), which the caller should catch and treat as
 *  "adopt the existing job" (see activeJobForDay) rather than a hard error. */
async function createJob({ trigger, state = 'queued', attemptNumber = 1, localDay: day = null, tz, leaseOwner = null, correlationId = null } = {}) {
  const day2 = day || localDay(new Date(), tz);
  const leaseExpiresAt = leaseOwner ? new Date(Date.now() + LEASE_DURATION_MS) : null;
  const { rows } = await query(
    `INSERT INTO morning_build_jobs (local_day, trigger, state, attempt_number, tz, lease_owner, lease_expires_at, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [day2, trigger, state, attemptNumber, tz || process.env.TZ || 'America/New_York', leaseOwner, leaseExpiresAt, correlationId]
  );
  return rows[0];
}

/** Patch a job row — only the fields passed are updated. `updated_at` always
 *  advances. Never throws; a failed status update must not crash a build
 *  that otherwise succeeded (or crash the caller reporting a failure). */
async function updateJob(id, patch = {}) {
  if (!id) return null;
  const fields = [];
  const values = [];
  let i = 1;
  const set = (col, val) => { fields.push(`${col} = $${++i}`); values.push(val); };
  if (patch.state !== undefined) {
    if (!VALID_STATES.has(patch.state)) throw new Error(`invalid build-job state: ${patch.state}`);
    set('state', patch.state);
  }
  if (patch.snapshotId !== undefined) set('snapshot_id', patch.snapshotId);
  if (patch.qualityStatus !== undefined) set('quality_status', patch.qualityStatus);
  if (patch.reasonCodes !== undefined) set('reason_codes', JSON.stringify(patch.reasonCodes ?? []));
  if (patch.publishedBriefingId !== undefined) set('published_briefing_id', patch.publishedBriefingId);
  if (patch.errorMessage !== undefined) set('error_message', patch.errorMessage);
  // 'premium_fresh' | 'grounded_usable' — the tier a 'ready' job actually
  // published at (brain/publishTier.js). Never set for 'failed'/'interrupted'.
  if (patch.publishTier !== undefined) set('publish_tier', patch.publishTier);
  if (patch.correlationId !== undefined) set('correlation_id', patch.correlationId);
  if (patch.pushResult !== undefined) set('push_result', JSON.stringify(patch.pushResult ?? {}));
  if (patch.leaseOwner !== undefined) set('lease_owner', patch.leaseOwner);
  if (patch.leaseExpiresAt !== undefined) set('lease_expires_at', patch.leaseExpiresAt);
  // `phase` is the fine-grained progress step within the coarse `state`
  // ('building_snapshot'|'generating'|'validating'|'repairing'|'publishing').
  // Every transition is also durably appended to phase_history so a killed
  // process's last-known phase survives for diagnostics even if it never
  // reaches a terminal state.
  if (patch.phase !== undefined) {
    set('phase', patch.phase);
    fields.push(`phase_history = phase_history || $${++i}::jsonb`);
    values.push(JSON.stringify([{ phase: patch.phase, at: new Date().toISOString() }]));
  }
  if (!fields.length) return getJob(id);
  const { rows } = await query(
    `UPDATE morning_build_jobs SET ${fields.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0] ?? null;
}

/** Heartbeat: touch `updated_at` on an in-flight job with no other field
 *  change, so isJobStale (below) can distinguish "still genuinely running"
 *  from "orphaned — the process that owned it died mid-build" using a much
 *  tighter window than STALE_IN_FLIGHT_MS would otherwise safely allow.
 *  Never throws — a missed heartbeat must not crash the build it's
 *  reporting on; the next heartbeat (or the coarser STALE_IN_FLIGHT_MS
 *  fallback) recovers. */
async function touchHeartbeat(id, { leaseOwner } = {}) {
  if (!id) return;
  try {
    if (leaseOwner) {
      // Renew the lease only while we still actually own it — a heartbeat
      // from a process whose lease was already reassigned (e.g. a startup
      // recovery scan decided it was abandoned and requeued a new attempt)
      // must not resurrect a lease out from under the new owner.
      await query(
        `UPDATE morning_build_jobs SET updated_at = now(), lease_expires_at = now() + interval '${LEASE_DURATION_MS} milliseconds'
         WHERE id = $1 AND lease_owner = $2 AND state IN ('waiting_for_sleep', 'queued', 'building', 'retry_wait')`,
        [id, leaseOwner]
      );
    } else {
      await query(`UPDATE morning_build_jobs SET updated_at = now() WHERE id = $1 AND state IN ('waiting_for_sleep', 'queued', 'building', 'retry_wait')`, [id]);
    }
  } catch { /* best-effort */ }
}

async function getJob(id) {
  if (!id) return null;
  const { rows } = await query(`SELECT * FROM morning_build_jobs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** The newest job row for `day` (today by default) — "the current job for
 *  today" per the durable-contract design (one row per attempt, newest wins). */
async function latestJobForDay(day = null, tz) {
  const day2 = day || localDay(new Date(), tz);
  const { rows } = await query(
    `SELECT * FROM morning_build_jobs WHERE local_day = $1 ORDER BY created_at DESC LIMIT 1`,
    [day2]
  );
  return rows[0] ?? null;
}

/** How many attempts have already been recorded for `day` — used to compute
 *  the next attempt_number and to feed the retry ledger's classification. */
async function attemptsToday(day = null, tz) {
  const day2 = day || localDay(new Date(), tz);
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM morning_build_jobs WHERE local_day = $1`,
    [day2]
  );
  return rows[0]?.n ?? 0;
}

/** A job still actively in progress for `day` (not a terminal state) — lets
 *  a new trigger discover and return the ALREADY-active job instead of
 *  starting a redundant one (reuses the existing advisory lock for mutual
 *  exclusion on the actual build; this is just the read-side lookup). */
async function activeJobForDay(day = null, tz) {
  const day2 = day || localDay(new Date(), tz);
  const { rows } = await query(
    `SELECT * FROM morning_build_jobs
      WHERE local_day = $1 AND state IN ('waiting_for_sleep', 'queued', 'building', 'retry_wait')
      ORDER BY created_at DESC LIMIT 1`,
    [day2]
  );
  return rows[0] ?? null;
}

const IN_FLIGHT_STATES = new Set(['waiting_for_sleep', 'queued', 'building', 'retry_wait']);

// Real builds finish in well under this window (ingest + analyze + one LLM
// call). Bug report ("it builds the brief, I close the app, reopen it, and
// nothing is there") traced partly to this: if the process that owns a job
// crashes (OOM, hard redeploy, an escaped exception outside the JS try/catch
// paths that otherwise always mark a job terminal) between creating it and
// finishing, the row is orphaned in an "in flight" state forever — and
// `updated_at` never advances again, unlike a genuinely still-running build's.
const STALE_IN_FLIGHT_MS = 15 * 60 * 1000;

/** Pure: is this in-flight-looking job actually just an abandoned row from a
 *  process that died mid-build, rather than a build genuinely still running?
 *  Judged ONLY by staleness of its own last update — never by state alone,
 *  since a legitimately slow build (or one waiting out `retry_wait`'s
 *  backoff) must not be misdiagnosed as orphaned. */
function isJobStale(job, nowMs = Date.now(), thresholdMs = STALE_IN_FLIGHT_MS) {
  if (!job || !IN_FLIGHT_STATES.has(job.state)) return false;
  const updated = new Date(job.updated_at).getTime();
  if (!Number.isFinite(updated)) return false;
  return nowMs - updated >= thresholdMs;
}

/** Lease-based staleness — the deployment-safe replacement for waiting out
 *  STALE_IN_FLIGHT_MS (15min). A job with a lease is abandoned the moment
 *  lease_expires_at passes without a renewing heartbeat (LEASE_DURATION_MS,
 *  ~60s) — detectable on the very next startup scan or poll, not 15 minutes
 *  later. Falls back to the old updated_at-based isJobStale for legacy rows
 *  that predate the lease columns (lease_expires_at null). */
function isJobAbandoned(job, nowMs = Date.now()) {
  if (!job || !IN_FLIGHT_STATES.has(job.state)) return false;
  if (job.lease_expires_at) {
    const expires = new Date(job.lease_expires_at).getTime();
    return Number.isFinite(expires) && nowMs >= expires;
  }
  return isJobStale(job, nowMs);
}

/** Every row for `day`, oldest first — the complete attempt history a
 *  production incident timeline (or the admin incident-report endpoint)
 *  needs: trigger, attempt number, every state/phase transition, quality,
 *  reason codes, publish tier, and push result for each attempt made that
 *  day. */
async function jobsForDay(day = null, tz) {
  const day2 = day || localDay(new Date(), tz);
  const { rows } = await query(
    `SELECT * FROM morning_build_jobs WHERE local_day = $1 ORDER BY created_at ASC`,
    [day2]
  );
  return rows;
}

/** Startup/poll-time recovery scan (deployment-safe recovery, item 5): find
 *  same-day jobs whose lease has expired without a renewal — proof the
 *  process that owned them is gone, not merely slow — and mark them
 *  'interrupted' rather than leaving them silently orphaned in 'building'
 *  until the old 15-minute check happened to notice. Returns the list of
 *  newly-interrupted jobs so the caller can decide whether to requeue
 *  exactly one recovery attempt for today (never more than one — see
 *  idx_morning_build_jobs_one_active_per_day, which only allows this UPDATE
 *  to proceed because 'interrupted' isn't one of the indexed in-flight
 *  states, freeing the local_day for a fresh attempt). */
async function recoverInterruptedJobs(day = null, tz) {
  const day2 = day || localDay(new Date(), tz);
  const { rows: candidates } = await query(
    `SELECT * FROM morning_build_jobs
      WHERE local_day = $1 AND state IN ('waiting_for_sleep', 'queued', 'building', 'retry_wait')
        AND lease_expires_at IS NOT NULL AND lease_expires_at < now()`,
    [day2]
  );
  const recovered = [];
  for (const job of candidates) {
    const { rows } = await query(
      `UPDATE morning_build_jobs SET state = 'interrupted',
         error_message = coalesce(error_message, 'lease expired — the owning process did not renew in time (deployment or crash)')
       WHERE id = $1 AND state IN ('waiting_for_sleep', 'queued', 'building', 'retry_wait')
       RETURNING *`,
      [job.id]
    );
    if (rows[0]) recovered.push(rows[0]);
  }
  return recovered;
}

module.exports = {
  VALID_STATES, LEASE_DURATION_MS, PROCESS_LEASE_OWNER, localDay, createJob, updateJob, getJob, latestJobForDay, attemptsToday, activeJobForDay,
  IN_FLIGHT_STATES, STALE_IN_FLIGHT_MS, isJobStale, isJobAbandoned, touchHeartbeat, jobsForDay, recoverInterruptedJobs,
};
