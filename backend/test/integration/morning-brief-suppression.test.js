// Bug: BRIEFING_FRESH_SKIP_MS's rolling 2-hour freshness window meant an
// 8:03am manual build stopped suppressing the automatic trigger by 10:03am —
// an 11:33am scheduler/cron/watcher/Eight-Sleep-triggered run would rebuild
// AND re-announce "Good morning" a second time the same day. Fixed with
// local-calendar-day semantics (builtToday(), see morning.test.js for the
// pure-function fixed-timezone coverage) plus a Postgres advisory lock shared
// with the manual "Rebuild" button (routes/briefing.js's REBUILD_LOCK_ID) so
// a manual build in flight and an automatic trigger can't both proceed.
//
// This file exercises the real end-to-end wiring: runMorningBriefing() against
// a real DB, with buildFreshBriefing/push/sleep-check-in stubbed so no LLM or
// push infrastructure is needed and build/send counts are directly observable.
const test = require('node:test');
const { after, afterEach, before } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const devicesStore = require('../../src/store/devices');
const expo = require('../../src/notify/expo');
const briefingRoute = require('../../src/routes/briefing');
const briefingsStore = require('../../src/store/briefings');
const recovery = require('../../src/intelligence/recovery');
const morning = require('../../src/notify/morning');

const ORIG_BUILD = briefingRoute.buildFreshBriefing;
const ORIG_PUBLISH = briefingRoute.publishBriefingDraft;
const ORIG_SEND = expo.sendPush;
const ORIG_TOKENS = devicesStore.listActiveTokens;
const ORIG_DEACTIVATE = devicesStore.deactivate;
const ORIG_NEEDS = recovery.needsSleepCheckIn;

let sendCount = 0;
let buildCount = 0;

function stubAll({ buildDelayMs = 0 } = {}) {
  sendCount = 0;
  buildCount = 0;
  devicesStore.listActiveTokens = async () => ['ExponentPushToken[ZZmorning-test]'];
  devicesStore.deactivate = async () => {};
  expo.sendPush = async () => {
    sendCount += 1;
    return { ok: true, sent: 1, tickets: [], invalidTokens: [] };
  };
  recovery.needsSleepCheckIn = async () => false;
  // Mirrors the real buildFreshBriefing/publishBriefingDraft split (see
  // routes/briefing.js): publish:false (the automatic morning path's prepare
  // step) must NOT persist — persistence only happens when the caller later
  // calls publishBriefingDraft (also stubbed below), exactly like production.
  // Mirrors publishBriefingDraft's verified publication receipt contract
  // (morning-notification lifecycle fix, item A) — real callers (warmAndNotify's
  // force path reads response.publicationReceipt; its automatic path reads
  // publishBriefingDraft's own return value) both need a receipt shaped like
  // the real one, not just a bare save.
  function receiptFor(content, saved) {
    return {
      briefingId: saved.id,
      snapshotId: content.snapshotId ?? null,
      snapshotVersion: content.snapshotVersion ?? null,
      localDay: new Date().toLocaleDateString('en-CA'),
      generatedAt: saved.generated_at,
      builtAt: content.builtAt ?? null,
      qualityStatus: content.chiefBriefQuality?.status ?? null,
      readbackVerified: true,
    };
  }
  briefingRoute.buildFreshBriefing = async ({ publish = true } = {}) => {
    buildCount += 1;
    if (buildDelayMs) await new Promise((r) => setTimeout(r, buildDelayMs));
    const content = {
      _test: 'ZZmorning',
      day: new Date().toISOString().slice(0, 10),
      builtAt: new Date().toISOString(),
      snapshotId: `ZZmorning-snap-${buildCount}`,
      chiefBrief: { synthesis: 'ZZmorning test build', action: 'a', risk: 'r', move: 'm', openQuestion: '' },
      // A genuine automatic build always carries quality metadata (see
      // brain/claimValidator.js's assessChiefBriefQuality via generateChiefBrief) —
      // 'fresh' here so these tests exercise the normal successful-build path,
      // not the separate quality-gating behavior covered in morning-lifecycle tests.
      chiefBriefQuality: { status: 'fresh', reasonCodes: [], fieldWordCounts: {}, fallbackFields: [], violatedChecks: [] },
    };
    if (publish) {
      const saved = await briefingsStore.saveBriefing({ kind: 'daily', content });
      content.publicationReceipt = receiptFor(content, saved);
    }
    return content;
  };
  briefingRoute.publishBriefingDraft = async (content) => {
    const saved = await briefingsStore.saveBriefing({ kind: 'daily', content });
    return receiptFor(content, saved);
  };
}

async function cleanup() {
  // Tagged via content->>'_test' (not content->'chiefBrief'->>'synthesis') so
  // a seeded row with chiefBrief:null — the "failed build" fixture — is still
  // reliably cleaned up between tests instead of leaking into later ones.
  await db.query(`DELETE FROM briefings WHERE content->>'_test' = 'ZZmorning'`);
  // Several OTHER integration files in this suite build a real briefing via
  // GET /api/briefing?refresh=1 and don't clean up their `briefings` row
  // afterward (a pre-existing gap, not introduced here). Since these tests
  // assert on "the latest daily briefing" system-wide, any such leftover row
  // dated TODAY would silently take over that role and break the "prior day"
  // /concurrent-race assertions below with no relation to this fix. Clear
  // today's daily briefings outright — this suite owns that invariant.
  const tz = process.env.TZ || 'America/New_York';
  await db.query(
    `DELETE FROM briefings WHERE kind = 'daily' AND (generated_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [tz]
  );
  await db.query(`DELETE FROM nudges WHERE dedup_key LIKE 'morning_brief_push:%' AND created_at >= now() - interval '1 hour'`);
  // The automatic path now mints a durable morning_build_jobs row per
  // attempt (item D) — clean those up too so this suite's real (unstubbed)
  // job-store calls don't leave stray rows for other tests to trip over.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  await db.query(`DELETE FROM morning_build_jobs WHERE local_day = $1`, [today]);
}

before(async () => { await cleanup(); });
afterEach(async () => {
  await cleanup();
  expo.sendPush = ORIG_SEND;
  devicesStore.listActiveTokens = ORIG_TOKENS;
  devicesStore.deactivate = ORIG_DEACTIVATE;
  recovery.needsSleepCheckIn = ORIG_NEEDS;
  briefingRoute.buildFreshBriefing = ORIG_BUILD;
  briefingRoute.publishBriefingDraft = ORIG_PUBLISH;
});
after(async () => { await closeDb(); });

async function seedBriefing({ generatedAt, chiefBrief }) {
  await db.query(
    `INSERT INTO briefings (kind, content, generated_at) VALUES ('daily', $1, $2)`,
    [JSON.stringify({ _test: 'ZZmorning', chiefBrief }), generatedAt]
  );
}

test('a manual build earlier today suppresses the automatic trigger entirely: no rebuild, zero pushes', async () => {
  stubAll();
  await seedBriefing({ generatedAt: new Date(Date.now() - 5000), chiefBrief: { synthesis: 'ZZmorning manual build' } });

  const result = await morning.runMorningBriefing({ send: true });
  assert.equal(result.built, false);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 'already_built_today');
  assert.equal(buildCount, 0, 'buildFreshBriefing must never be called');
  assert.equal(sendCount, 0, 'no push must be sent');
});

test('a build from a PRIOR day does not suppress — normal build/push proceeds', async () => {
  stubAll();
  await seedBriefing({ generatedAt: new Date(Date.now() - 25 * 3600000), chiefBrief: { synthesis: 'ZZmorning prior day' } });

  const result = await morning.runMorningBriefing({ send: true });
  assert.equal(result.built, true);
  assert.equal(buildCount, 1, 'the automatic build must run');
  assert.equal(sendCount, 1, 'the automatic push must fire');
});

test('a failed/incomplete manual build (no chiefBrief at all) does not suppress — normal build/push proceeds', async () => {
  stubAll();
  await seedBriefing({ generatedAt: new Date(Date.now() - 5000), chiefBrief: null });

  const result = await morning.runMorningBriefing({ send: true });
  assert.equal(result.built, true, 'a genuinely broken manual build must not block the scheduled build');
  assert.equal(buildCount, 1);
  assert.equal(sendCount, 1);
});

test('force:true bypasses the guard even when a valid build already exists today', async () => {
  stubAll();
  await seedBriefing({ generatedAt: new Date(Date.now() - 5000), chiefBrief: { synthesis: 'ZZmorning already built' } });

  const result = await morning.runMorningBriefing({ send: true, force: true });
  assert.equal(result.built, true);
  assert.equal(buildCount, 1);
});

test('concurrent automatic-trigger attempts produce at most one build and one push', async () => {
  stubAll({ buildDelayMs: 300 });

  const [a, b] = await Promise.all([
    morning.runMorningBriefing({ send: true }),
    morning.runMorningBriefing({ send: true }),
  ]);

  assert.equal(buildCount, 1, 'buildFreshBriefing must be called at most once across the concurrent race');
  assert.equal(sendCount, 1, 'exactly one push must go out, not two');
  const builtCount = [a, b].filter((r) => r.built).length;
  assert.equal(builtCount, 1, 'exactly one of the two concurrent attempts builds; the other cleanly skips');
});
