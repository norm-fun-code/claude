// Cross-day lifecycle hardening pass — self-healing GET /briefing: when the
// canonical morning cutoff has passed and no publishable current-day brief
// exists, GET /briefing must enqueue exactly one durable recovery build
// (deduped via the SAME advisory lock + build-job ledger a manual/scheduled
// rebuild already uses) and return immediately with an honest sanitized
// preparing state carrying the new build's id — never requiring the user to
// discover and press Rebuild before today's data can exist, and never
// blocking the GET response on the 60-90s build itself.
'use strict';
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const briefingsStore = require('../../src/store/briefings');
const buildJobs = require('../../src/store/morningBuildJobs');
const { SNAPSHOT_VERSION } = require('../../src/brain/snapshot');
const {
  pastMorningCutoff, triggerRecoveryBuildIfNeeded, MORNING_RECOVERY_GRACE_MIN,
} = require('../../src/routes/briefing');

const REBUILD_LOCK_ID = 727002;
const TZ = 'America/New_York';
const app = buildTestApp();

function todayLocalDay(tz = TZ) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

after(async () => {
  // Background self-heal builds kicked off by these tests are fire-and-forget
  // (same pattern as briefing-rebuild-lock.test.js) — give them a moment to
  // settle before closing the pool.
  await new Promise((r) => setTimeout(r, 1000));
  await db.query(`DELETE FROM morning_build_jobs WHERE trigger = 'self_heal'`);
  await db.query(`DELETE FROM briefings WHERE kind = 'daily' AND content->>'localDate' = $1`, ['2020-01-01']);
  await closeDb();
});

// ── pastMorningCutoff — pure logic, no DB ──
test('pastMorningCutoff: before the scheduled hour+grace is false, at/after is true', () => {
  const oldHour = process.env.SCHEDULE_HOUR;
  const oldMinute = process.env.SCHEDULE_MINUTE;
  process.env.SCHEDULE_HOUR = '8';
  process.env.SCHEDULE_MINUTE = '30';
  try {
    // 8:00am ET — before the 8:30 + 30min grace cutoff (9:00).
    assert.equal(pastMorningCutoff(new Date('2026-07-28T12:00:00.000Z'), TZ), false);
    // 9:00am ET exactly — right at the cutoff.
    assert.equal(pastMorningCutoff(new Date('2026-07-28T13:00:00.000Z'), TZ), true);
    // 3:00pm ET — well past.
    assert.equal(pastMorningCutoff(new Date('2026-07-28T19:00:00.000Z'), TZ), true);
    // 2:00am ET the same calendar day — well before.
    assert.equal(pastMorningCutoff(new Date('2026-07-28T06:00:00.000Z'), TZ), false);
  } finally {
    if (oldHour === undefined) delete process.env.SCHEDULE_HOUR; else process.env.SCHEDULE_HOUR = oldHour;
    if (oldMinute === undefined) delete process.env.SCHEDULE_MINUTE; else process.env.SCHEDULE_MINUTE = oldMinute;
  }
});

test('pastMorningCutoff defaults to 8:30am + grace when SCHEDULE_HOUR/MINUTE are unset', () => {
  const oldHour = process.env.SCHEDULE_HOUR;
  const oldMinute = process.env.SCHEDULE_MINUTE;
  delete process.env.SCHEDULE_HOUR;
  delete process.env.SCHEDULE_MINUTE;
  try {
    assert.ok(MORNING_RECOVERY_GRACE_MIN > 0);
    // 8:00am ET — before default 8:30 cutoff.
    assert.equal(pastMorningCutoff(new Date('2026-07-28T12:00:00.000Z'), TZ), false);
    // 9:15am ET — after 8:30 + 30min grace (9:00).
    assert.equal(pastMorningCutoff(new Date('2026-07-28T13:15:00.000Z'), TZ), true);
  } finally {
    if (oldHour === undefined) delete process.env.SCHEDULE_HOUR; else process.env.SCHEDULE_HOUR = oldHour;
    if (oldMinute === undefined) delete process.env.SCHEDULE_MINUTE; else process.env.SCHEDULE_MINUTE = oldMinute;
  }
});

// ── triggerRecoveryBuildIfNeeded — real Postgres, real advisory lock ──
test('required: lock contention (another build already holds REBUILD_LOCK_ID) never spawns a second recovery build', async (t) => {
  const day = todayLocalDay();
  t.after(async () => { await db.query(`DELETE FROM morning_build_jobs WHERE local_day = $1 AND trigger = 'self_heal'`, [day]); });

  const holder = await db.pool.connect();
  try {
    const { rows } = await holder.query('SELECT pg_try_advisory_lock($1) AS acquired', [REBUILD_LOCK_ID]);
    assert.equal(rows[0].acquired, true, 'test setup: must be able to take the lock when nothing else holds it');

    const buildId = await triggerRecoveryBuildIfNeeded(day, TZ);
    assert.equal(buildId, null, 'never fabricate a build id when the lock is genuinely contended');

    const jobs = await db.query(`SELECT id FROM morning_build_jobs WHERE local_day = $1 AND trigger = 'self_heal'`, [day]);
    assert.equal(jobs.rows.length, 0, 'no job row was created while the lock was held elsewhere');
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [REBUILD_LOCK_ID]);
    holder.release();
  }
});

test('required: an uncontended trigger enqueues exactly one durable job, and a second concurrent call dedupes onto the SAME job (never a duplicate)', async (t) => {
  const day = todayLocalDay();
  t.after(async () => { await db.query(`DELETE FROM morning_build_jobs WHERE local_day = $1 AND trigger = 'self_heal'`, [day]); });

  const buildId1 = await triggerRecoveryBuildIfNeeded(day, TZ);
  assert.ok(buildId1, 'a real build id is returned');

  const job = await buildJobs.getJob(buildId1);
  assert.equal(job.trigger, 'self_heal');
  // local_day is a Postgres `date` column — node-pg returns a JS Date; format
  // it the same way the rest of this test compares calendar days.
  assert.equal(new Date(job.local_day).toISOString().slice(0, 10), day);
  assert.ok(['building', 'ready', 'failed'].includes(job.state));

  // A second call while the first is still active (or has just settled)
  // must never spawn a second job for the same day — either it sees the
  // still-active job via activeJobForDay, or (once settled) the
  // attemptsToday cap eventually stops further spawning. Immediately after
  // the first call, the job is still in-flight (advisory lock + DB write are
  // synchronous relative to the returned id), so this exercises the
  // activeJobForDay dedup path specifically.
  const buildId2 = await triggerRecoveryBuildIfNeeded(day, TZ);
  assert.equal(buildId2, buildId1, 'the second call must resolve to the SAME job, never a new one');

  const jobs = await db.query(`SELECT id FROM morning_build_jobs WHERE local_day = $1 AND trigger = 'self_heal'`, [day]);
  assert.equal(jobs.rows.length, 1, 'exactly one recovery build job was created');

  // Let the background build settle (same fail-fast-in-test-env pattern as
  // briefing-rebuild-lock.test.js) and confirm the advisory lock is released.
  const deadline = Date.now() + 10_000;
  let acquired = false;
  while (Date.now() < deadline) {
    const check = await db.pool.connect();
    try {
      const { rows } = await check.query('SELECT pg_try_advisory_lock($1) AS acquired', [REBUILD_LOCK_ID]);
      acquired = rows[0].acquired;
      if (acquired) { await check.query('SELECT pg_advisory_unlock($1)', [REBUILD_LOCK_ID]); break; }
    } finally {
      check.release();
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(acquired, true, 'the lock must be released once the background recovery build settles');
});

test('required: a safety cap stops spawning further recovery builds once MAX_SELF_HEAL_ATTEMPTS_PER_DAY prior attempts already failed today', async (t) => {
  const day = todayLocalDay();
  t.after(async () => { await db.query(`DELETE FROM morning_build_jobs WHERE local_day = $1 AND trigger IN ('self_heal', 'manual')`, [day]); });

  // Seed 3 already-failed attempts for today (any trigger counts toward
  // attemptsToday — mirrors the real ledger's semantics).
  for (let i = 1; i <= 3; i++) {
    const job = await buildJobs.createJob({ trigger: 'manual', state: 'building', attemptNumber: i, localDay: day, tz: TZ });
    await buildJobs.updateJob(job.id, { state: 'failed', errorMessage: 'seeded failure' });
  }

  const buildId = await triggerRecoveryBuildIfNeeded(day, TZ);
  assert.equal(buildId, null, 'the cap must stop further auto-retries once the pipeline has already failed repeatedly today');

  const selfHealJobs = await db.query(`SELECT id FROM morning_build_jobs WHERE local_day = $1 AND trigger = 'self_heal'`, [day]);
  assert.equal(selfHealJobs.rows.length, 0, 'no new self-heal job was created past the cap');
});

// ── GET /briefing route-level: recoveryBuildId surfaces on a genuinely stale day ──
test('required: GET /briefing self-heals — a previous-day cached brief past the cutoff gets an honest preparing response carrying a real recoveryBuildId', async (t) => {
  const oldHour = process.env.SCHEDULE_HOUR;
  const oldMinute = process.env.SCHEDULE_MINUTE;
  // Force "past cutoff" deterministically regardless of the real wall clock
  // this test happens to run at — 00:00 + 30min grace is behind any
  // reasonable time-of-day this suite runs.
  process.env.SCHEDULE_HOUR = '0';
  process.env.SCHEDULE_MINUTE = '0';

  const day = todayLocalDay();
  // This is a scratch test DB — an earlier test run in this same session
  // (including this very file's own "uncontended trigger" test above, whose
  // background build is fire-and-forget) may have left a genuinely
  // publishable 'daily' row whose generated_at falls on today's local day —
  // latestPublishableDailyForLocalDay matches on generated_at's local day,
  // NOT content.localDate, so that's the condition to clear here too. Clear
  // any such rows first so the "nothing publishable exists" precondition
  // this test targets is actually true.
  await db.query(
    `DELETE FROM briefings WHERE kind = 'daily' AND (generated_at AT TIME ZONE $2)::date = $1::date`,
    [day, TZ]
  );

  const staleDay = '2020-01-01'; // unambiguously a "previous day"
  const saved = await briefingsStore.saveBriefing({
    kind: 'daily',
    content: {
      localDate: staleDay, chiefBrief: null, chiefBriefPending: true, chiefBriefStale: false,
      snapshotVersion: SNAPSHOT_VERSION, timezone: TZ,
      date: '', quote: '', quoteInsight: '', notionInsight: '', notionText: '', notionPageTitle: '',
      weather: null, workout: null, calendar: [], financeSummary: [], leverageActions: [], insights: [],
      forecasts: [], relevantHighlight: null, weeklyReview: null, wealth: null,
    },
  });
  t.after(async () => {
    if (oldHour === undefined) delete process.env.SCHEDULE_HOUR; else process.env.SCHEDULE_HOUR = oldHour;
    if (oldMinute === undefined) delete process.env.SCHEDULE_MINUTE; else process.env.SCHEDULE_MINUTE = oldMinute;
    await db.query(`DELETE FROM briefings WHERE id = $1`, [saved.id]);
    await db.query(`DELETE FROM morning_build_jobs WHERE local_day = $1 AND trigger = 'self_heal'`, [day]);
  });

  const res = await request(app).get('/api/briefing').set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(res.body.dayState, 'previous_day', 'sanity: the seeded row really is being served as a stale prior-day cache hit');
  assert.equal(res.body.chiefBrief, null, 'no publishable current-day brief — an honest pending state, never yesterday\'s masquerading as today\'s');
  assert.ok(res.body.recoveryBuildId, 'a real recovery build id must be handed back so the client can poll it immediately, same as a manual rebuild');

  const job = await buildJobs.getJob(res.body.recoveryBuildId);
  assert.ok(job, 'the returned recoveryBuildId resolves to a real, durable job row');
  assert.equal(job.trigger, 'self_heal');
});

test('required: GET /briefing does NOT self-heal before the morning cutoff, even with no publishable current-day brief', async (t) => {
  const oldHour = process.env.SCHEDULE_HOUR;
  const oldMinute = process.env.SCHEDULE_MINUTE;
  // Cutoff far in the future relative to any real wall-clock time this test
  // runs at (23:00 + grace) — "before cutoff" is always true.
  process.env.SCHEDULE_HOUR = '23';
  process.env.SCHEDULE_MINUTE = '30';

  const staleDay = '2020-01-01';
  const saved = await briefingsStore.saveBriefing({
    kind: 'daily',
    content: {
      localDate: staleDay, chiefBrief: null, chiefBriefPending: true, chiefBriefStale: false,
      snapshotVersion: SNAPSHOT_VERSION, timezone: TZ,
      date: '', quote: '', quoteInsight: '', notionInsight: '', notionText: '', notionPageTitle: '',
      weather: null, workout: null, calendar: [], financeSummary: [], leverageActions: [], insights: [],
      forecasts: [], relevantHighlight: null, weeklyReview: null, wealth: null,
    },
  });
  t.after(async () => {
    if (oldHour === undefined) delete process.env.SCHEDULE_HOUR; else process.env.SCHEDULE_HOUR = oldHour;
    if (oldMinute === undefined) delete process.env.SCHEDULE_MINUTE; else process.env.SCHEDULE_MINUTE = oldMinute;
    await db.query(`DELETE FROM briefings WHERE id = $1`, [saved.id]);
  });

  const res = await request(app).get('/api/briefing').set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(res.body.dayState, 'previous_day');
  assert.equal(res.body.recoveryBuildId, null, 'no recovery build before the cutoff — the scheduled/watcher path is still expected to handle it');

  const day = todayLocalDay();
  const jobs = await db.query(`SELECT id FROM morning_build_jobs WHERE local_day = $1 AND trigger = 'self_heal'`, [day]);
  assert.equal(jobs.rows.length, 0);
});
