// End-to-end wiring for the sleep-readiness gate: proves that EVERY automatic
// morning trigger (scheduler.morningRoutine used by the watcher/catch-up, and
// the external /api/cron/morning route) funnels through the SAME gate, that a
// not-ready night never builds or pushes, that the one final ingest happens
// before the brief, that concurrent triggers produce exactly one build, and
// that force:true still bypasses for manual testing.
//
// The Eight Sleep API + the heavy pipeline steps are stubbed via their module
// objects so no network/LLM is needed and build ordering is directly
// observable; the readiness gate itself (and its durable Postgres state) runs
// for real against the test DB.
const test = require('node:test');
const { after, afterEach, before } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');

const eightSleepApi = require('../../src/services/eight-sleep-api');
const readiness = require('../../src/intelligence/sleep-readiness');
const scheduler = require('../../src/scheduler');
const ingestRun = require('../../src/ingest/run');
const morningNotify = require('../../src/notify/morning');
const analyzeMod = require('../../src/intelligence/analyze');
const watchMod = require('../../src/intelligence/watch');
const crossContextMod = require('../../src/intelligence/crossContext');
const experimentsMod = require('../../src/intelligence/experiments');
const wealthNudgesMod = require('../../src/intelligence/wealth-nudges');
const sourcesStore = require('../../src/store/sources');
const morningRetryLedger = require('../../src/intelligence/morning-retry-ledger');

const TZ = process.env.TZ || 'America/New_York';
const MIN = 60 * 1000;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

const ORIG = {};
const app = buildTestApp();
let calls = [];
let buildCount = 0;

// presenceEnd is a FIXED anchor (captured once), not Date.now() per call — the
// seeded fingerprint and the gate's fingerprint must be byte-identical to count
// as the same observation, so this must not drift by the ms between two calls.
// Still comfortably older than the 12-min telemetry floor for the whole run.
const PRESENCE_END = new Date(Date.now() - 40 * MIN).toISOString();

function finalizedDay() {
  return {
    day: today(),
    score: 84,
    sleepDuration: 7.4 * 3600,
    presenceDuration: 8 * 3600,
    deepDuration: 1.6 * 3600,
    remDuration: 1.7 * 3600,
    lightDuration: 4.1 * 3600,
    sleepQualityScore: { hrv: { current: 58 }, heartRate: { current: 51 }, respiratoryRate: { current: 14 } },
    presenceEnd: PRESENCE_END,
  };
}

/** Stub the Eight Sleep API + the heavy pipeline. `present`/`days` control the
 *  gate's live view; everything downstream just records call order. */
function stubAll({ present = false, days = [finalizedDay()] } = {}) {
  calls = [];
  buildCount = 0;
  eightSleepApi.getCreds = async () => ({ token: 't', userId: 'u' });
  eightSleepApi.getIntervalPresent = async () => present;
  eightSleepApi.getTrends = async () => days;
  ingestRun.runIngest = async () => { calls.push('ingest'); return []; };
  // quality:'fresh' — a genuine successful automatic build always carries
  // quality metadata (brain/claimValidator.js's assessChiefBriefQuality via
  // generateChiefBrief); scheduler.morningRoutine() only marks the day done
  // when quality is exactly 'fresh' (see the audit fix in scheduler.js).
  morningNotify.runMorningBriefing = async () => { calls.push('brief'); buildCount += 1; return { built: true, sent: 1, quality: 'fresh' }; };
  analyzeMod.analyze = async () => {};
  watchMod.runWatch = async () => ({});
  crossContextMod.generateCrossContext = async () => ({});
  experimentsMod.proposeExperiments = async () => ({ created: 0 });
  experimentsMod.autoStartExperiment = async () => null;
  wealthNudgesMod.runWealthNudges = async () => ({ sent: 0 });
}

/** Pre-seed durable readiness state so THIS poll is the 2nd stable observation
 *  (matching the stubbed finalized day's fingerprint), past BOTH the 10-min
 *  stability floor AND the 30-min wake-confirmation window (production
 *  default — see sleep-readiness.js's thresholds().wakeConfirmationMinMs),
 *  making the gate genuinely ready. 20 minutes used to be enough under the
 *  old single 10-minute-only gate — that was exactly the production bug
 *  (stability alone treated as proof the night was over); 35 minutes is the
 *  honest fixture for what "ready" actually requires now. */
async function seedStableState() {
  const snap = readiness.extractFinalizedSnapshot(finalizedDay());
  const fp = readiness.fingerprintOf(snap);
  await sourcesStore.registerSource({ id: readiness.READINESS_SOURCE_ID, domain: 'health', displayName: 'Eight Sleep readiness state' });
  await sourcesStore.updateConfig(readiness.READINESS_SOURCE_ID, {
    readiness: { day: today(), fingerprint: fp, observations: 1, firstStableAt: Date.now() - 35 * MIN },
  });
}

before(async () => {
  // Clean any durable readiness/marker state a prior (possibly interrupted) run
  // left in the shared DB — otherwise a stale, fingerprint-matching row could
  // pre-satisfy the gate and make the first "not ready" assertion flaky.
  await cleanup();
  ORIG.getCreds = eightSleepApi.getCreds;
  ORIG.getIntervalPresent = eightSleepApi.getIntervalPresent;
  ORIG.getTrends = eightSleepApi.getTrends;
  ORIG.runIngest = ingestRun.runIngest;
  ORIG.runMorningBriefing = morningNotify.runMorningBriefing;
  ORIG.analyze = analyzeMod.analyze;
  ORIG.runWatch = watchMod.runWatch;
  ORIG.generateCrossContext = crossContextMod.generateCrossContext;
  ORIG.proposeExperiments = experimentsMod.proposeExperiments;
  ORIG.autoStartExperiment = experimentsMod.autoStartExperiment;
  ORIG.runWealthNudges = wealthNudgesMod.runWealthNudges;
  ORIG.EMAIL = process.env.EIGHT_SLEEP_EMAIL;
  ORIG.PASSWORD = process.env.EIGHT_SLEEP_PASSWORD;
  ORIG.CRON = process.env.CRON_SECRET;
  process.env.EIGHT_SLEEP_EMAIL = 'test@example.com';
  process.env.EIGHT_SLEEP_PASSWORD = 'pw';
  process.env.CRON_SECRET = 'test-cron-secret';
});

async function cleanup() {
  // Both durable per-day state machines this suite exercises must be reset —
  // otherwise a same-day retry-backoff row left by an earlier test (in this
  // file or a prior interrupted run) makes a LATER test's "first attempt
  // today" assumption false, and every readiness assertion after it starts
  // failing with retry_backoff instead of the reason under test.
  await db.query(`DELETE FROM sources WHERE id = ANY($1)`, [[readiness.READINESS_SOURCE_ID, morningRetryLedger.LEDGER_SOURCE_ID]]);
  await db.query(`DELETE FROM nudges WHERE dedup_key LIKE 'morning_routine:%' OR dedup_key LIKE 'morning_brief_push:%'`);
}

afterEach(async () => {
  await cleanup();
  eightSleepApi.getCreds = ORIG.getCreds;
  eightSleepApi.getIntervalPresent = ORIG.getIntervalPresent;
  eightSleepApi.getTrends = ORIG.getTrends;
  ingestRun.runIngest = ORIG.runIngest;
  morningNotify.runMorningBriefing = ORIG.runMorningBriefing;
  analyzeMod.analyze = ORIG.analyze;
  watchMod.runWatch = ORIG.runWatch;
  crossContextMod.generateCrossContext = ORIG.generateCrossContext;
  experimentsMod.proposeExperiments = ORIG.proposeExperiments;
  experimentsMod.autoStartExperiment = ORIG.autoStartExperiment;
  wealthNudgesMod.runWealthNudges = ORIG.runWealthNudges;
});

after(async () => {
  if (ORIG.EMAIL === undefined) delete process.env.EIGHT_SLEEP_EMAIL; else process.env.EIGHT_SLEEP_EMAIL = ORIG.EMAIL;
  if (ORIG.PASSWORD === undefined) delete process.env.EIGHT_SLEEP_PASSWORD; else process.env.EIGHT_SLEEP_PASSWORD = ORIG.PASSWORD;
  if (ORIG.CRON === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = ORIG.CRON;
  await closeDb();
});

test('morningRoutine does NOT build when the night is not yet finalized/stable (only one observation)', async () => {
  stubAll({ present: false, days: [finalizedDay()] }); // no seed → obs 1
  const r = await scheduler.morningRoutine({ reason: 'watcher' });
  assert.equal(r.built, false);
  assert.equal(r.skipped, 'not_ready');
  assert.equal(r.reason, 'insufficient_stability');
  assert.deepEqual(calls, [], 'neither ingest nor brief may run when not ready');
  assert.equal(buildCount, 0);
});

test('an active interval (still tracking) never builds — no early brief', async () => {
  stubAll({ present: true, days: [finalizedDay()] });
  await seedStableState(); // even with prior stability, active presence vetoes
  const r = await scheduler.morningRoutine({ reason: 'watcher' });
  assert.equal(r.built, false);
  assert.equal(r.reason, 'session_active');
  assert.equal(buildCount, 0);
});

test('when readiness is confirmed, the ONE final ingest runs BEFORE the brief is built', async () => {
  stubAll({ present: false, days: [finalizedDay()] });
  await seedStableState(); // this poll is the 2nd stable obs → ready
  const r = await scheduler.morningRoutine({ reason: 'watcher' });
  assert.equal(r.built, true, 'a finalized+stable night builds');
  assert.equal(buildCount, 1);
  assert.ok(calls.includes('ingest') && calls.includes('brief'), 'both ingest and brief ran');
  assert.ok(calls.indexOf('ingest') < calls.indexOf('brief'), 'final ingest must precede the brief build');
});

test('concurrent automatic triggers produce exactly one build (in-flight guard)', async () => {
  stubAll({ present: false, days: [finalizedDay()] });
  await seedStableState();
  const [a, b] = await Promise.all([
    scheduler.morningRoutine({ reason: 'watcher' }),
    scheduler.morningRoutine({ reason: 'cron' }),
  ]);
  assert.equal(buildCount, 1, 'exactly one build across the concurrent race');
  const builtBoth = [a, b].filter((x) => x.built).length;
  assert.equal(builtBoth, 1, 'exactly one attempt builds; the other cleanly skips');
});

test('required: a scheduler restart after sleep finalization catches up (no in-memory state required)', async () => {
  stubAll({ present: false, days: [finalizedDay()] });
  // Seed durable readiness state as if the stability observations happened
  // BEFORE a process restart wiped every in-memory variable — the only thing
  // that must survive is what's actually persisted in Postgres (sleep-readiness.js's
  // sources.config.readiness). If restart-safety were broken, a freshly loaded
  // module with zero in-process history would see this as "obs 1" and refuse.
  await seedStableState();

  // Simulate the restart itself: drop scheduler.js from Node's require cache
  // and re-require it, so `_morningRoutineInFlight` and any other
  // module-level variable starts from its true post-boot default — exactly
  // what happens when the process actually restarts. (notify/morning.js and
  // sleep-readiness.js are deliberately left cached — this test's stubs are
  // set on those exact module objects; scheduler.js re-requires them by the
  // same cached path, same as it would for any of its other dependencies
  // that aren't part of what this test is proving restart-safe.)
  delete require.cache[require.resolve('../../src/scheduler')];
  const freshScheduler = require('../../src/scheduler');

  const r = await freshScheduler.morningRoutine({ reason: 'watcher' });
  assert.equal(r.built, true, 'a night finalized before a restart must still build on the first post-restart poll');
  assert.equal(buildCount, 1);
});

test('external cron CANNOT bypass the gate — a not-ready night returns not_ready with no build', async () => {
  stubAll({ present: false, days: [finalizedDay()] }); // obs 1 → not ready
  const res = await request(app)
    .post('/api/cron/morning')
    .set(authHeader())
    .query({ secret: 'test-cron-secret' })
    .send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.built, false);
  assert.equal(res.body.skipped, 'not_ready');
  assert.equal(buildCount, 0, 'cron must not build an unfinalized night');
});

test('cron ?force=1 bypasses the gate for authenticated manual testing', async () => {
  stubAll({ present: true, days: [] }); // even actively tracking, force overrides
  const res = await request(app)
    .post('/api/cron/morning')
    .set(authHeader())
    .query({ secret: 'test-cron-secret', force: '1' })
    .send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.built, true);
  assert.equal(buildCount, 1);
});

test('cron with a bad secret is rejected (401) and never touches the gate', async () => {
  stubAll();
  const res = await request(app)
    .post('/api/cron/morning')
    .set(authHeader())
    .query({ secret: 'wrong' })
    .send({});
  assert.equal(res.status, 401);
  assert.equal(buildCount, 0);
});

test('a second automatic trigger after the routine already ran today is skipped', async () => {
  stubAll({ present: false, days: [finalizedDay()] });
  await seedStableState();
  const first = await scheduler.morningRoutine({ reason: 'watcher' });
  assert.equal(first.built, true);
  // A later cron for the same day must see the marker and skip without rebuilding.
  const second = await scheduler.morningRoutine({ reason: 'cron' });
  assert.equal(second.built, false);
  assert.equal(second.skipped, 'already_ran_today');
  assert.equal(buildCount, 1, 'still exactly one build for the day');
});

// Scenario 4 (required test): a DEGRADED automatic build (a claim-validator
// grounded-fallback sentence, or an underfilled response — see
// brain/claimValidator.js's assessChiefBriefQuality) must NOT burn the
// once-a-day morning marker. A later trigger must not see "already ran
// today" — it must instead be held by the bounded retry-backoff ledger
// (intelligence/morning-retry-ledger.js), never re-attempting on every poll.
test('scenario 4: a hard_failed automatic build does not create the completed-day marker; a later trigger is held by retry backoff, not "already ran today"', async () => {
  stubAll({ present: false, days: [finalizedDay()] });
  await seedStableState();
  // A genuinely hard_failed outcome (an unresolved factual contradiction —
  // see brain/publishTier.js) — distinct from a merely-underfilled
  // grounded_usable build, which DOES now mark the day done (see the
  // superseded assertion in morning-build-lifecycle.test.js). Matches the
  // real shape warmAndNotify actually returns for this case: built:false,
  // skipped:'quality_not_publishable'.
  morningNotify.runMorningBriefing = async () => {
    calls.push('brief'); buildCount += 1;
    return { built: false, sent: 0, quality: 'degraded', skipped: 'quality_not_publishable', publishTier: 'hard_failed' };
  };

  const first = await scheduler.morningRoutine({ reason: 'watcher' });
  assert.equal(first.built, false);
  assert.equal(first.quality, 'degraded');

  const second = await scheduler.morningRoutine({ reason: 'watcher' });
  assert.notEqual(second.skipped, 'already_ran_today', 'a degraded build must never burn the once-a-day marker');
  assert.equal(second.skipped, 'retry_backoff', 'held by the bounded backoff, not silently re-attempted on every poll');
  assert.equal(buildCount, 1, 'the second trigger did not re-run the expensive build while backoff is active');
});

// Scenario 5 (required test): once the retry-ledger's backoff window has
// elapsed, a bounded later automatic attempt CAN publish — and only THEN
// (quality fresh) does the day get marked done.
test('scenario 5: a bounded later retry can publish once quality becomes fresh, and only then marks the day done', async () => {
  stubAll({ present: false, days: [finalizedDay()] });
  await seedStableState();
  let call = 0;
  morningNotify.runMorningBriefing = async () => {
    calls.push('brief'); buildCount += 1; call += 1;
    return call === 1
      ? { built: false, sent: 0, quality: 'degraded', skipped: 'quality_not_publishable', publishTier: 'hard_failed' }
      : { built: true, sent: 1, quality: 'fresh', publishTier: 'premium_fresh' };
  };

  const first = await scheduler.morningRoutine({ reason: 'watcher' });
  assert.equal(first.quality, 'degraded');

  // Fast-forward the retry ledger's backoff window directly in its durable
  // state (no real wait, no env-var override needed — MORNING_RETRY_BACKOFF_MIN=0
  // would fall through to the default via the same `Number(x) || default`
  // pattern every other threshold in this codebase uses, since 0 is falsy).
  const ledgerRow = await sourcesStore.getSource(morningRetryLedger.LEDGER_SOURCE_ID);
  await sourcesStore.updateConfig(morningRetryLedger.LEDGER_SOURCE_ID, {
    ledger: { ...ledgerRow.config.ledger, lastAttemptAt: Date.now() - 25 * MIN },
  });

  const second = await scheduler.morningRoutine({ reason: 'watcher' });
  assert.equal(second.built, true);
  assert.equal(second.quality, 'fresh');
  assert.equal(buildCount, 2, 'the retry actually ran a second real attempt, not a cached result');

  // Now the day IS done — a third trigger cleanly skips via the marker.
  const third = await scheduler.morningRoutine({ reason: 'watcher' });
  assert.equal(third.skipped, 'already_ran_today');
  assert.equal(buildCount, 2, 'no further build once fresh quality has published');
});
