// Real-Postgres regression tests for deployment-safe morning-build recovery
// (July 30 2026 incident hardening, section 5) — migration 068's
// lease_owner/lease_expires_at columns, idx_morning_build_jobs_one_active_per_day
// unique index, and morningBuildJobs.js's recoverInterruptedJobs. Production
// restarted mid-morning near the July 30 wake-readiness transition; these
// tests prove a killed process's job is detected and recovered promptly
// (lease-scale, not the old 15-minute STALE_IN_FLIGHT_MS wait) and that
// exactly one fresh attempt can proceed afterward — never two concurrent
// builds for the same local day.
'use strict';
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const buildJobs = require('../../src/store/morningBuildJobs');

const TZ = 'America/New_York';
const TAG = `lease-test-${Date.now()}`;
const day = (offset) => `2026-08-${String(10 + offset).padStart(2, '0')}`; // isolated fake days per test

after(async () => {
  await db.query(`DELETE FROM morning_build_jobs WHERE local_day >= '2026-08-10' AND local_day <= '2026-08-20'`);
  await closeDb();
});

test('required: idx_morning_build_jobs_one_active_per_day rejects a second concurrent active job for the same local_day', async () => {
  const d = day(1);
  const first = await buildJobs.createJob({ trigger: 'scheduled', state: 'building', localDay: d, tz: TZ, leaseOwner: `${TAG}-owner-a` });
  assert.ok(first.id);
  await assert.rejects(
    buildJobs.createJob({ trigger: 'self_heal', state: 'building', localDay: d, tz: TZ, leaseOwner: `${TAG}-owner-b` }),
    (err) => err.code === '23505',
    'a concurrent second active-state INSERT for the same day must fail with a unique violation, not silently succeed'
  );
});

test('required: recoverInterruptedJobs marks an expired-lease job interrupted and leaves a fresh-lease job untouched', async () => {
  const d = day(2);
  const dead = await buildJobs.createJob({ trigger: 'scheduled', state: 'building', localDay: d, tz: TZ, leaseOwner: `${TAG}-dead` });
  // Simulate the owning process having died: force the lease into the past
  // directly (touchHeartbeat/createJob only ever set it into the future).
  await db.query(`UPDATE morning_build_jobs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1`, [dead.id]);

  const d2 = day(3);
  const alive = await buildJobs.createJob({ trigger: 'scheduled', state: 'building', localDay: d2, tz: TZ, leaseOwner: `${TAG}-alive` });
  // Alive job's lease is still in the future (createJob's default LEASE_DURATION_MS).

  const recoveredDead = await buildJobs.recoverInterruptedJobs(d, TZ);
  assert.equal(recoveredDead.length, 1);
  assert.equal(recoveredDead[0].id, dead.id);
  assert.equal(recoveredDead[0].state, 'interrupted');

  const recoveredAlive = await buildJobs.recoverInterruptedJobs(d2, TZ);
  assert.equal(recoveredAlive.length, 0, 'a job with a still-valid lease must never be marked interrupted');
  const aliveRow = await buildJobs.getJob(alive.id);
  assert.equal(aliveRow.state, 'building');
});

test('required: after a job is marked interrupted, the local_day is free for exactly one new active job — no duplicate build', async () => {
  const d = day(4);
  const dead = await buildJobs.createJob({ trigger: 'scheduled', state: 'building', localDay: d, tz: TZ, leaseOwner: `${TAG}-dead2` });
  await db.query(`UPDATE morning_build_jobs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1`, [dead.id]);

  const recovered = await buildJobs.recoverInterruptedJobs(d, TZ);
  assert.equal(recovered.length, 1);

  // Now a fresh recovery attempt should succeed (the unique index no longer
  // blocks — 'interrupted' isn't one of the indexed in-flight states).
  const recoveryJob = await buildJobs.createJob({ trigger: 'self_heal', state: 'building', localDay: d, tz: TZ, leaseOwner: `${TAG}-recovery` });
  assert.ok(recoveryJob.id);
  assert.notEqual(recoveryJob.id, dead.id, 'the recovery attempt must be a NEW job row, preserving the original interrupted job for diagnostics');

  // And a THIRD concurrent attempt must still be rejected — never two active
  // jobs at once even immediately after a recovery.
  await assert.rejects(
    buildJobs.createJob({ trigger: 'scheduled', state: 'building', localDay: d, tz: TZ, leaseOwner: `${TAG}-third` }),
    (err) => err.code === '23505'
  );

  const allJobsForDay = await buildJobs.jobsForDay(d, TZ);
  assert.equal(allJobsForDay.length, 2, 'both the original interrupted attempt and the recovery attempt must be visible in the day\'s full history');
  const states = allJobsForDay.map((j) => j.state).sort();
  assert.deepEqual(states, ['building', 'interrupted']);
});

test('required: touchHeartbeat renews the lease only for the process that actually still owns it', async () => {
  const d = day(5);
  const job = await buildJobs.createJob({ trigger: 'scheduled', state: 'building', localDay: d, tz: TZ, leaseOwner: `${TAG}-owner-x` });
  const before = await buildJobs.getJob(job.id);

  // A heartbeat from the WRONG owner (e.g. a reassigned job) must not renew.
  await buildJobs.touchHeartbeat(job.id, { leaseOwner: `${TAG}-owner-y` });
  const afterWrongOwner = await buildJobs.getJob(job.id);
  assert.equal(new Date(afterWrongOwner.lease_expires_at).getTime(), new Date(before.lease_expires_at).getTime());

  // A heartbeat from the CORRECT owner renews it forward.
  await buildJobs.touchHeartbeat(job.id, { leaseOwner: `${TAG}-owner-x` });
  const afterRightOwner = await buildJobs.getJob(job.id);
  assert.ok(new Date(afterRightOwner.lease_expires_at).getTime() >= new Date(before.lease_expires_at).getTime());
});
