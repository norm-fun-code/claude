// Required regression coverage for the morning-brief build/publish lifecycle
// fix (production bug: "no usable brief at 8am; first manual rebuild came
// back with a blank Chief Brief; a second rebuild finally worked"). Proves,
// against REAL Postgres:
//   - a degraded/failed attempt is recorded as a build ATTEMPT, never saved
//     as the canonical daily briefing (routes/briefing.js's thisAttemptFresh
//     gate on publishBriefingDraft);
//   - the durable build-job contract (store/morningBuildJobs.js) reflects
//     that truthfully — 'ready' only once a fresh draft is actually
//     persisted, 'failed' otherwise — so a client polling job STATE (not
//     builtAt) can never mistake a degraded attempt for success;
//   - a persistence failure is surfaced as failed/retryable, never a false
//     "published";
//   - lock contention and a marker-lookup error never falsely gate/suppress.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const briefingsStore = require('../../src/store/briefings');
const buildJobs = require('../../src/store/morningBuildJobs');
const briefingRoute = require('../../src/routes/briefing');
const scheduler = require('../../src/scheduler');
const morningRetryLedger = require('../../src/intelligence/morning-retry-ledger');
const sourcesStore = require('../../src/store/sources');
const nudgesStore = require('../../src/store/nudges');

const app = buildTestApp();
const TEST_MARKER = `morn-lifecycle-${Date.now()}`;
const TZ = process.env.TZ || 'America/New_York';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
}

const FULL_ACTION = 'Block a short window this morning for the highest-leverage task on the list.';
const FULL_RISK = 'Meetings could crowd out the deep work window if nothing is protected today.';
const FULL_MOVE = 'Confirm the plan for the morning before the first meeting of the day starts.';
const FULL_MORNING_FOCUS = 'Protect the first open block today for the one thing that actually moves things forward.';

/** A schema-valid, long-enough (fresh-quality) chief-brief LLM response. */
function freshLlmResponse() {
  return chiefMeta(JSON.stringify({
    chiefBrief: {
      synthesis: `${TEST_MARKER} today is genuinely on track with a manageable, well-understood schedule, nothing urgent.`,
      action: FULL_ACTION, risk: FULL_RISK, move: FULL_MOVE, openQuestion: '',
    },
    morningFocus: FULL_MORNING_FOCUS,
  }));
}

/** A schema-valid but under-filled (degraded-quality) chief-brief response. */
function degradedLlmResponse() {
  return chiefMeta(JSON.stringify({
    chiefBrief: { synthesis: `${TEST_MARKER} too short`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    morningFocus: 'mf',
  }));
}

function stubLlm(fn) {
  llm.generateText = async ({ system } = {}) => {
    if (system && system.includes('chief of staff and data scientist')) return fn();
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
}

async function cleanup() {
  await db.query(`DELETE FROM briefings WHERE content->'chiefBrief'->>'synthesis' LIKE $1 OR content->>'chiefBrief' LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM morning_build_jobs WHERE local_day = $1`, [today()]);
  await db.query(`DELETE FROM sources WHERE id = ANY($1)`, [[morningRetryLedger.LEDGER_SOURCE_ID]]);
  await db.query(`DELETE FROM nudges WHERE dedup_key LIKE 'morning_routine:%' OR dedup_key LIKE 'morning_brief_push:%'`);
}

const ORIG_GEN = llm.generateText;
afterEach(async () => {
  llm.generateText = ORIG_GEN;
  await cleanup();
});
after(async () => { await closeDb(); });

// (July 30 2026 incident hardening — supersedes the old "must never be
// persisted" premise) a first-ever build (no prior fresh brief at all)
// whose generation is merely underfilled (schema-valid, no claim violation)
// is grounded_usable under the 3-tier contract and DOES publish — the exact
// gap that produced the July 30 incident: this content used to vanish
// entirely (job 'failed', no briefing row) instead of shipping a safe,
// if-thin, real brief.
test('required (superseded): a first-ever underfilled-but-safe build publishes as grounded_usable; the build-job status reports it honestly', async () => {
  await cleanup();
  stubLlm(degradedLlmResponse);

  const before = await db.query(`SELECT count(*)::int AS n FROM briefings`);
  const res = await request(app).post('/api/briefing/rebuild').set(authHeader());
  assert.equal(res.status, 202);
  const { buildId } = res.body;
  assert.ok(buildId);

  // Poll the durable job status until it reaches a terminal state.
  let job = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const r = await request(app).get('/api/briefing/rebuild/status').query({ buildId }).set(authHeader());
    if (r.body.state === 'ready' || r.body.state === 'failed') { job = r.body; break; }
    await new Promise((r2) => setTimeout(r2, 200));
  }
  assert.ok(job, 'the job must reach a terminal state');
  assert.equal(job.state, 'ready', 'an underfilled-but-safe attempt is grounded_usable — a genuine publish, not a failure');
  assert.ok(job.publishedBriefingId, 'the grounded_usable brief was published and referenced by this job');

  const after1 = await db.query(`SELECT count(*)::int AS n FROM briefings`);
  assert.equal(after1.rows[0].n, before.rows[0].n + 1, 'exactly one new briefings row was inserted for the grounded_usable attempt');
});

// (July 30 2026 incident hardening — supersedes the old "publishes ONLY the
// fresh candidate" premise) a grounded_usable first candidate DOES publish
// (job1 'ready'), but a subsequent premium_fresh retry is a strictly BETTER
// tier and correctly overwrites it (never-downgrade only blocks a WORSE
// attempt from replacing a better one, never the reverse) — job state (not
// builtAt) remains the truth about which candidate is actually canonical.
test('required (superseded): a grounded_usable first candidate publishes, and a fresh retry (a strictly better tier) replaces it; job state (not builtAt) is the truth', async () => {
  await cleanup();

  stubLlm(degradedLlmResponse);
  const res1 = await request(app).post('/api/briefing/rebuild').set(authHeader());
  assert.equal(res1.status, 202);
  let job1 = null;
  { const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const r = await request(app).get('/api/briefing/rebuild/status').query({ buildId: res1.body.buildId }).set(authHeader());
      if (r.body.state === 'ready' || r.body.state === 'failed') { job1 = r.body; break; }
      await new Promise((r2) => setTimeout(r2, 200));
    }
  }
  assert.equal(job1.state, 'ready', 'an underfilled-but-safe candidate is grounded_usable — it publishes');
  assert.ok(job1.publishedBriefingId);

  stubLlm(freshLlmResponse);
  const res2 = await request(app).post('/api/briefing/rebuild').set(authHeader());
  assert.equal(res2.status, 202);
  assert.notEqual(res2.body.buildId, res1.body.buildId, 'a retry is a NEW job row, not a mutation of the prior one');
  let job2 = null;
  { const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const r = await request(app).get('/api/briefing/rebuild/status').query({ buildId: res2.body.buildId }).set(authHeader());
      if (r.body.state === 'ready' || r.body.state === 'failed') { job2 = r.body; break; }
      await new Promise((r2) => setTimeout(r2, 200));
    }
  }
  assert.equal(job2.state, 'ready', 'the fresh retry must actually publish');
  assert.ok(job2.publishedBriefingId, 'a ready job references the briefing row it published');
  assert.equal(job2.attemptNumber, 2, 'the retry is recorded as attempt 2 for today, not a fresh count');

  // The canonical daily briefing is the FRESH (premium) one — a strictly
  // better tier correctly supersedes the earlier grounded_usable candidate.
  const latest = await briefingsStore.latestBriefing('daily');
  assert.equal(latest.id, job2.publishedBriefingId);
  assert.equal(latest.content.publishTier, 'premium_fresh');
  assert.match(latest.content.chiefBrief.synthesis, new RegExp(TEST_MARKER));
  assert.doesNotMatch(latest.content.chiefBrief.synthesis, /too short/);
});

// (July 30 2026 incident hardening — supersedes the old "job becomes
// failed" premise) if a later attempt only reaches a LOWER tier than what's
// already canonical (premium_fresh already published; the retry is merely
// grounded_usable), the never-downgrade invariant leaves the existing good
// brief completely untouched — AND, since a genuinely publishable brief
// exists for today (the untouched one), the job correctly reports 'ready'
// (not 'failed': nothing actually needs retrying — today's brief is fine),
// referencing the SAME existing row rather than a new one.
test('required (superseded): a same-or-lower-tier retry never downgrades an existing premium brief; the job reports ready against the UNCHANGED existing row', async () => {
  await cleanup();
  // Seed an existing fresh brief for today.
  stubLlm(freshLlmResponse);
  const seedRes = await request(app).post('/api/briefing/rebuild').set(authHeader());
  let seedJob = null;
  { const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const r = await request(app).get('/api/briefing/rebuild/status').query({ buildId: seedRes.body.buildId }).set(authHeader());
      if (r.body.state === 'ready' || r.body.state === 'failed') { seedJob = r.body; break; }
      await new Promise((r2) => setTimeout(r2, 200));
    }
  }
  assert.equal(seedJob.state, 'ready');
  const goodBriefingId = seedJob.publishedBriefingId;

  const before = await db.query(`SELECT count(*)::int AS n FROM briefings`);

  // Now a subsequent attempt only reaches grounded_usable — strictly worse
  // than the already-published premium_fresh.
  stubLlm(degradedLlmResponse);
  const retryRes = await request(app).post('/api/briefing/rebuild').set(authHeader());
  let retryJob = null;
  { const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const r = await request(app).get('/api/briefing/rebuild/status').query({ buildId: retryRes.body.buildId }).set(authHeader());
      if (r.body.state === 'ready' || r.body.state === 'failed') { retryJob = r.body; break; }
      await new Promise((r2) => setTimeout(r2, 200));
    }
  }
  assert.equal(retryJob.state, 'ready', 'a genuinely publishable brief exists for today (the untouched premium one) — nothing needs retrying');
  assert.equal(retryJob.publishedBriefingId, goodBriefingId, 'the job references the SAME existing row — never a new, worse one');

  // The good brief is untouched — still the latest canonical row, byte-identical, and NO new row was inserted.
  const latest = await briefingsStore.latestBriefing('daily');
  assert.equal(latest.id, goodBriefingId);
  assert.match(latest.content.chiefBrief.synthesis, /genuinely on track/);
  const after1 = await db.query(`SELECT count(*)::int AS n FROM briefings`);
  assert.equal(after1.rows[0].n, before.rows[0].n, 'the never-downgrade invariant must not insert any new row for the worse attempt');
});

// Required test 8: a persistence failure (the draft itself was fresh, but
// saving it failed) must never be reported as published.
test('required: a persistence failure prevents the build from being reported as published/ready', async () => {
  await cleanup();
  stubLlm(freshLlmResponse);
  const origSave = briefingsStore.saveBriefing;
  briefingsStore.saveBriefing = async () => { throw new Error('simulated disk-full'); };
  try {
    const result = await briefingRoute.buildFreshBriefing({ force: true });
    assert.equal(result.publishFailed, true, 'a persistence failure must be surfaced on the response, not swallowed');
    assert.equal(result.chiefBriefQuality?.status, 'fresh', 'the DRAFT itself was genuinely fresh — only the save failed');
  } finally {
    briefingsStore.saveBriefing = origSave;
  }
  const rows = await db.query(`SELECT * FROM briefings WHERE content->'chiefBrief'->>'synthesis' LIKE $1`, [`%${TEST_MARKER}%`]);
  assert.equal(rows.rows.length, 0, 'nothing was actually persisted');
});

// Required test 10: lock contention must never consume a bounded retry
// attempt — it is not a real generation attempt.
test('required: lock contention does not consume retry-ledger allowance', async () => {
  await cleanup();
  delete process.env.EIGHT_SLEEP_EMAIL;
  delete process.env.EIGHT_SLEEP_PASSWORD;

  const before = await morningRetryLedger.canAttempt({});
  assert.equal(before.allowed, true);

  // Hold the SAME advisory lock notify/morning.js's runMorningBriefing uses,
  // from a separate connection — simulating a manual rebuild already in flight.
  const holder = await db.pool.connect();
  await holder.query('SELECT pg_try_advisory_lock($1)', [briefingRoute.REBUILD_LOCK_ID]);
  try {
    const result = await scheduler.morningRoutine({ reason: 'watcher' });
    assert.equal(result.skipped, 'rebuild_in_progress', 'contended lock must be reported distinctly');
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [briefingRoute.REBUILD_LOCK_ID]);
    holder.release();
  }

  const ledgerRow = await sourcesStore.getSource(morningRetryLedger.LEDGER_SOURCE_ID).catch(() => null);
  assert.equal(ledgerRow, null, 'lock contention must never write a retry-ledger attempt at all');
});

// Required test 12: a morning-marker lookup error must not silently
// suppress the day — it must be treated as unknown, not "already ran".
test('required: a morning-marker lookup error is treated as unknown, never as "already ran"', async () => {
  const orig = nudgesStore.recentlySentKeys;
  nudgesStore.recentlySentKeys = async () => { throw new Error('simulated db blip'); };
  try {
    const marker = await scheduler.morningRanToday();
    assert.equal(marker.ran, false, 'an error must never be reported as ran:true');
    assert.equal(marker.error, true);
  } finally {
    nudgesStore.recentlySentKeys = orig;
  }
});

// Required test 13: a manual rebuild (POST /briefing/rebuild) and an
// automatic trigger (scheduler.morningRoutine) racing at the same moment
// must publish and push AT MOST ONCE — they share routes/briefing.js's
// REBUILD_LOCK_ID advisory lock (notify/morning.js's runMorningBriefing
// acquires the same lock the manual route holds), so whichever loses the
// race cleanly skips instead of racing to a second concurrent build/push.
test('required: concurrent automatic + manual triggers publish and push at most once', async () => {
  await cleanup();
  stubLlm(freshLlmResponse);
  // No Eight Sleep creds configured — the automatic path's readiness gate is
  // bypassed (eightSleepConfigured()===false), so it goes straight for the
  // shared lock exactly like a data-driven trigger would once ready.
  delete process.env.EIGHT_SLEEP_EMAIL;
  delete process.env.EIGHT_SLEEP_PASSWORD;

  const manualRes = await request(app).post('/api/briefing/rebuild').set(authHeader());
  assert.equal(manualRes.status, 202);
  const { buildId } = manualRes.body;
  assert.ok(buildId, 'manual trigger must win the race and get a real build job');

  // Fire the automatic trigger immediately — the manual background build is
  // still holding the lock at this point.
  const autoResult = await scheduler.morningRoutine({ reason: 'watcher' });
  assert.equal(autoResult.built, false, 'the automatic trigger must not build a second time');
  assert.equal(autoResult.skipped, 'rebuild_in_progress', 'the automatic trigger must see the lock held, not race to its own build');

  // Let the manual build finish.
  let job = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const statusRes = await request(app).get('/api/briefing/rebuild/status').query({ buildId }).set(authHeader());
    job = statusRes.body;
    if (job.state === 'ready' || job.state === 'failed') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(job.state, 'ready', 'the manual build must complete successfully');

  const rows = await db.query(`SELECT * FROM briefings WHERE content->'chiefBrief'->>'synthesis' LIKE $1 ORDER BY generated_at ASC`, [`%${TEST_MARKER}%`]);
  assert.equal(rows.rows.length, 1, 'exactly one canonical briefing must be published across the race');

  const pushRows = await db.query(`SELECT * FROM nudges WHERE dedup_key LIKE 'morning_brief_push:%'`);
  assert.ok(pushRows.rows.length <= 1, 'at most one morning-ready push may be recorded across the race');
});

// Bug report: "it builds the brief, I close the app, reopen it, and nothing
// is there." A job whose owning process crashed mid-build is left "building"
// forever — updated_at never advances again — which fed the mobile client
// false "still in flight" evidence indefinitely. GET /briefing/rebuild/status
// must recognize a genuinely stale in-flight job and durably resolve it to
// 'failed', not keep reporting it as still running.
test('required: a build job orphaned mid-build (stale "building" row) is durably resolved to failed by the status poll, not reported as in-flight forever', async () => {
  await cleanup();
  const day = today();
  const job = await buildJobs.createJob({ trigger: 'scheduled', state: 'building', attemptNumber: 1, localDay: day, tz: TZ });
  // Simulate a process crash: back-date updated_at well past the stale
  // window without going through updateJob (which always sets it to now()).
  await db.query(`UPDATE morning_build_jobs SET updated_at = now() - interval '20 minutes' WHERE id = $1`, [job.id]);

  const res = await request(app).get('/api/briefing/rebuild/status').query({ buildId: job.id }).set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'failed', 'a stale in-flight job must be reported as failed, not building');
  assert.match(res.body.errorMessage || '', /stale_in_flight/);

  // Durable, not just an in-response patch: a second poll (or activeJobForDay,
  // which the manual-rebuild race depends on) must see the same resolved
  // state from the database, not re-derive "still building" from the row.
  const persisted = await buildJobs.getJob(job.id);
  assert.equal(persisted.state, 'failed');
  const active = await buildJobs.activeJobForDay(day, TZ);
  assert.equal(active, null, 'the resolved job must no longer read as "active" to a new trigger');
});

test('a genuinely recent "building" job is left untouched by the status poll — must not be misdiagnosed as abandoned', async () => {
  await cleanup();
  const day = today();
  const job = await buildJobs.createJob({ trigger: 'scheduled', state: 'building', attemptNumber: 1, localDay: day, tz: TZ });

  const res = await request(app).get('/api/briefing/rebuild/status').query({ buildId: job.id }).set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'building', 'a build only just started must still read as in-flight');
});
