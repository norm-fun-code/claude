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
  morningNotify.runMorningBriefing = async () => { calls.push('brief'); buildCount += 1; return { built: true, sent: 1 }; };
  analyzeMod.analyze = async () => {};
  watchMod.runWatch = async () => ({});
  crossContextMod.generateCrossContext = async () => ({});
  experimentsMod.proposeExperiments = async () => ({ created: 0 });
  experimentsMod.autoStartExperiment = async () => null;
  wealthNudgesMod.runWealthNudges = async () => ({ sent: 0 });
}

/** Pre-seed durable readiness state so THIS poll is the 2nd stable observation
 *  (matching the stubbed finalized day's fingerprint), making the gate ready. */
async function seedStableState() {
  const snap = readiness.extractFinalizedSnapshot(finalizedDay());
  const fp = readiness.fingerprintOf(snap);
  await sourcesStore.registerSource({ id: readiness.READINESS_SOURCE_ID, domain: 'health', displayName: 'Eight Sleep readiness state' });
  await sourcesStore.updateConfig(readiness.READINESS_SOURCE_ID, {
    readiness: { day: today(), fingerprint: fp, observations: 1, firstStableAt: Date.now() - 20 * MIN },
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
  await db.query(`DELETE FROM sources WHERE id = $1`, [readiness.READINESS_SOURCE_ID]);
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
