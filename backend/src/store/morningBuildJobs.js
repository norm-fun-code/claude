// Durable morning-brief build-job ledger (see migration 061). One row per
// build ATTEMPT — a retry creates a new row with attempt_number incremented,
// so the client's status poll (and any diagnostic) can see the full attempt
// history for the day. This is the durable identity POST /briefing/rebuild
// hands back instead of a bare timestamp — see mobile/src/hooks/useBriefing.ts,
// which used to infer "the rebuild finished" from builtAt alone and could
// mistake a degraded/blank attempt for success.
'use strict';
const { query } = require('../db');

const VALID_STATES = new Set(['waiting_for_sleep', 'queued', 'building', 'retry_wait', 'ready', 'failed']);

function localDay(d = new Date(), tz = process.env.TZ || 'America/New_York') {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/** Start a new build-attempt row. `attemptNumber` should be 1 + however many
 *  prior attempts exist for today (see attemptsToday below) — the caller
 *  computes this so the count is visible without a second round trip here. */
async function createJob({ trigger, state = 'queued', attemptNumber = 1, localDay: day = null, tz } = {}) {
  const day2 = day || localDay(new Date(), tz);
  const { rows } = await query(
    `INSERT INTO morning_build_jobs (local_day, trigger, state, attempt_number)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [day2, trigger, state, attemptNumber]
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
  if (!fields.length) return getJob(id);
  const { rows } = await query(
    `UPDATE morning_build_jobs SET ${fields.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0] ?? null;
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

module.exports = {
  VALID_STATES, localDay, createJob, updateJob, getJob, latestJobForDay, attemptsToday, activeJobForDay,
};
