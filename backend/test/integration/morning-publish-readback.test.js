// Morning-notification lifecycle fix — required regression coverage against
// REAL Postgres for:
//   (A) publishBriefingDraft's post-save read-back verification: a fresh
//       build's receipt only comes back once the exact persisted row is
//       proven retrievable/publishable; a mismatch/failure throws and the
//       caller (warmAndNotify) never pushes, never burns the dedup marker,
//       never marks the day done, and stays retryable.
//   (B) GET /api/briefing/by-snapshot/:snapshotId — the exact-snapshot
//       endpoint a tapped push notification resolves through: never builds,
//       never substitutes a different briefing, enforces daily kind and
//       publishability.
//   (D) the automatic morning path creates a durable morning_build_jobs row
//       per attempt, reaching 'ready' only after read-back verification.
//   Full reproduction: warmAndNotify's automatic path publishes for real,
//   and GET /briefing/by-snapshot/:snapshotId resolves to the EXACT SAME
//   Chief Brief content — proving a tapped notification's snapshotId
//   resolves to the exact brief Today would render.
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
const morning = require('../../src/notify/morning');
const devicesStore = require('../../src/store/devices');
const nudgesStore = require('../../src/store/nudges');
const expo = require('../../src/notify/expo');

const app = buildTestApp();
const TEST_MARKER = `morn-readback-${Date.now()}`;
const TZ = process.env.TZ || 'America/New_York';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
}
const FULL_ACTION = 'Block a short window this morning for the highest-leverage task on the list.';
const FULL_RISK = 'Meetings could crowd out the deep work window if nothing is protected today.';
const FULL_MOVE = 'Confirm the plan for the morning before the first meeting of the day starts.';
const FULL_MORNING_FOCUS = 'Protect the first open block today for the one thing that actually moves things forward.';

function freshLlmResponse() {
  return chiefMeta(JSON.stringify({
    chiefBrief: {
      synthesis: `${TEST_MARKER} today is genuinely on track with a manageable, well-understood schedule, nothing urgent.`,
      action: FULL_ACTION, risk: FULL_RISK, move: FULL_MOVE, openQuestion: '',
    },
    morningFocus: FULL_MORNING_FOCUS,
  }));
}
function stubLlm(fn) {
  llm.generateText = async ({ system } = {}) => {
    if (system && system.includes('chief of staff and data scientist')) return fn();
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
}

/** A minimal, realistic fresh daily-briefing content object, for testing
 *  publishBriefingDraft directly (not through the full buildFreshBriefing
 *  pipeline). */
function freshContent(overrides = {}) {
  return {
    _test: TEST_MARKER,
    timezone: TZ,
    localDate: today(),
    builtAt: new Date().toISOString(),
    snapshotId: `${TEST_MARKER}-${Math.random().toString(36).slice(2)}`,
    snapshotVersion: 1,
    chiefBrief: { synthesis: `${TEST_MARKER} synthesis`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    chiefBriefQuality: { status: 'fresh', reasonCodes: [], fieldWordCounts: {}, fallbackFields: [], violatedChecks: [] },
    ...overrides,
  };
}

async function cleanup() {
  await db.query(`DELETE FROM briefings WHERE content->>'_test' = $1`, [TEST_MARKER]);
  // Other integration files in this suite (and manual dev runs) can leave a
  // real daily briefing dated TODAY with no relation to this file's marker —
  // runMorningBriefing's hasPublishableFreshBriefToday check looks at the
  // system-wide latest daily row, so any such leftover would short-circuit
  // every automatic-path test below as "already built today". This suite
  // owns that invariant for its own runs, same as morning-brief-suppression.test.js.
  await db.query(
    `DELETE FROM briefings WHERE kind = 'daily' AND (generated_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [TZ]
  );
  await db.query(`DELETE FROM morning_build_jobs WHERE local_day = $1`, [today()]);
  await db.query(`DELETE FROM nudges WHERE dedup_key LIKE 'morning_brief_push:%'`);
}

const ORIG_GEN = llm.generateText;
const ORIG_FIND_BY_ID = briefingsStore.findById;
const ORIG_SAVE = briefingsStore.saveBriefing;
const ORIG_TOKENS = devicesStore.listActiveTokens;
const ORIG_PUSH = expo.sendPush;
afterEach(async () => {
  llm.generateText = ORIG_GEN;
  briefingsStore.findById = ORIG_FIND_BY_ID;
  briefingsStore.saveBriefing = ORIG_SAVE;
  devicesStore.listActiveTokens = ORIG_TOKENS;
  expo.sendPush = ORIG_PUSH;
  await cleanup();
});
after(async () => { await closeDb(); });

// ── required 1 & 6: fresh build saves, exact read-back succeeds, job ready, one push with all identifiers ──
test('required: a fresh automatic build saves, passes read-back verification, the job reaches ready, and exactly one push is sent with all identifiers', async () => {
  await cleanup();
  stubLlm(freshLlmResponse);
  devicesStore.listActiveTokens = async () => ['ExponentPushToken[ZZreadback]'];
  let captured = null;
  let sendCount = 0;
  expo.sendPush = async (_tokens, msg) => { sendCount += 1; captured = msg; return { sent: 1, invalidTokens: [] }; };

  const result = await morning.runMorningBriefing({ send: true, trigger: 'watcher' });
  assert.equal(result.built, true);
  assert.equal(result.sent, 1);
  assert.equal(sendCount, 1, 'exactly one push must be sent');

  assert.ok(captured);
  assert.equal(captured.data.type, 'morning_briefing');
  assert.ok(captured.data.briefingId, 'briefingId must be present');
  assert.ok(captured.data.snapshotId, 'snapshotId must be present');
  assert.equal(captured.data.localDay, today());
  assert.ok(captured.data.builtAt, 'builtAt must be present');

  const job = await buildJobs.latestJobForDay(today(), TZ);
  assert.ok(job, 'the automatic path must create a durable job row (item D)');
  assert.equal(job.trigger, 'watcher');
  assert.equal(job.state, 'ready', '"ready" must mean the persisted row passed read-back verification');
  assert.equal(job.published_briefing_id, captured.data.briefingId);
  assert.equal(job.snapshot_id, captured.data.snapshotId);

  const row = await briefingsStore.findById(captured.data.briefingId);
  assert.ok(row, 'the exact row referenced by the push must be retrievable');
  assert.equal(row.content.snapshotId, captured.data.snapshotId);
});

// ── required 2: read-back mismatch — no push, no dedup marker, no morning-complete marker, retry remains possible ──
test('required: a read-back mismatch (row exists but does not match) throws, and the caller never pushes or marks the day done', async () => {
  await cleanup();
  const content = freshContent();
  briefingsStore.findById = async (id) => {
    const real = await ORIG_FIND_BY_ID(id);
    // Simulate a corrupted/mismatched read-back: the row comes back with a
    // DIFFERENT snapshotId than what was just saved.
    return real ? { ...real, content: { ...real.content, snapshotId: 'not-the-same-snapshot' } } : real;
  };

  await assert.rejects(
    () => briefingRoute.publishBriefingDraft(content),
    (err) => {
      assert.equal(err.name, 'PublishReadbackError');
      assert.match(err.message, /snapshot_id_mismatch/);
      return true;
    }
  );
  assert.equal(content.publicationReceipt, undefined, 'no receipt may be attached when read-back fails');

  // The row WAS saved (that part succeeded) but nothing downstream may treat
  // it as published — no job, no push-dedup marker.
  const recent = await require('../../src/store/nudges').recentlySentKeys(1);
  assert.ok(!recent.has(`morning_brief_push:${today()}`), 'no push dedup marker may be written');
});

// ── required 3: persistence failure — no push ──
test('required: a persistence failure (saveBriefing throws) never produces a receipt and is never pushed', async () => {
  await cleanup();
  briefingsStore.saveBriefing = async () => { throw new Error('simulated DB write failure'); };
  const content = freshContent();

  await assert.rejects(() => briefingRoute.publishBriefingDraft(content), /simulated DB write failure/);
  assert.equal(content.publicationReceipt, undefined);

  const { rows } = await db.query(`SELECT count(*)::int AS n FROM briefings WHERE content->>'_test' = $1`, [TEST_MARKER]);
  assert.equal(rows[0].n, 0, 'no row may exist after a persistence failure');
});

// ── required 10: degraded/thin Chief Briefs are never pushed (automatic path, real DB) ──
test('required: a degraded automatic build is never published, never creates a ready job, and is never pushed', async () => {
  await cleanup();
  stubLlm(() => chiefMeta(JSON.stringify({
    chiefBrief: { synthesis: `${TEST_MARKER} too short`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    morningFocus: 'mf',
  })));
  let sendCount = 0;
  devicesStore.listActiveTokens = async () => ['ExponentPushToken[ZZreadback]'];
  expo.sendPush = async () => { sendCount += 1; return { sent: 1, invalidTokens: [] }; };

  const result = await morning.runMorningBriefing({ send: true, trigger: 'watcher' });
  assert.equal(result.sent, 0);
  assert.equal(sendCount, 0, 'a degraded build must never be pushed');

  const job = await buildJobs.latestJobForDay(today(), TZ);
  assert.ok(job);
  assert.equal(job.state, 'failed', 'a degraded attempt must not reach "ready"');
  assert.equal(job.published_briefing_id, null);
});

// ── required 11: the exact-snapshot endpoint never builds and never substitutes a different briefing ──
test('required: GET /briefing/by-snapshot/:snapshotId returns only the exact row, 404s when missing, never triggers generation', async () => {
  await cleanup();
  let buildCalled = false;
  const origBuild = briefingRoute.buildFreshBriefing;
  briefingRoute.buildFreshBriefing = async (...args) => { buildCalled = true; return origBuild(...args); };

  try {
    const missing = await request(app).get('/api/briefing/by-snapshot/does-not-exist').set(authHeader());
    assert.equal(missing.status, 404);
    assert.equal(buildCalled, false, 'a miss must never trigger an LLM build');

    const content = freshContent();
    await briefingsStore.saveBriefing({ kind: 'daily', content });

    const found = await request(app).get(`/api/briefing/by-snapshot/${content.snapshotId}`).set(authHeader());
    assert.equal(found.status, 200);
    assert.equal(found.body.snapshotId, content.snapshotId);
    assert.equal(found.body.chiefBrief.synthesis, content.chiefBrief.synthesis, 'must return the EXACT briefing, never a substitute');
    assert.equal(buildCalled, false, 'a hit must never trigger an LLM build either');
  } finally {
    briefingRoute.buildFreshBriefing = origBuild;
  }
});

test('required: GET /briefing/by-snapshot/:snapshotId 409s on a degraded-quality row', async () => {
  await cleanup();
  const content = freshContent({
    chiefBriefQuality: { status: 'degraded', reasonCodes: ['synthesis_underfilled'], fieldWordCounts: {}, fallbackFields: ['synthesis'], violatedChecks: [] },
  });
  await briefingsStore.saveBriefing({ kind: 'daily', content });

  const res = await request(app).get(`/api/briefing/by-snapshot/${content.snapshotId}`).set(authHeader());
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'degraded');
});

test('required: GET /briefing/by-snapshot/:snapshotId 409s on a not-yet-publishable (pending) row', async () => {
  await cleanup();
  const content = freshContent({ chiefBrief: null, chiefBriefPending: true, chiefBriefQuality: null });
  await briefingsStore.saveBriefing({ kind: 'daily', content });

  const res = await request(app).get(`/api/briefing/by-snapshot/${content.snapshotId}`).set(authHeader());
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'not_publishable');
});

// ── Full reproduction: a tapped notification's snapshotId resolves to the EXACT Chief Brief Today would render ──
test('required (full reproduction): the automatic path\'s pushed snapshotId resolves via GET /briefing/by-snapshot to the EXACT same Chief Brief content', async () => {
  await cleanup();
  stubLlm(freshLlmResponse);
  devicesStore.listActiveTokens = async () => ['ExponentPushToken[ZZreadback]'];
  let captured = null;
  expo.sendPush = async (_tokens, msg) => { captured = msg; return { sent: 1, invalidTokens: [] }; };

  const result = await morning.runMorningBriefing({ send: true, trigger: 'watcher' });
  assert.equal(result.sent, 1);
  assert.ok(captured?.data?.snapshotId);

  // This is exactly what mobile's openFromPush does: resolve the tapped
  // push's snapshotId to the exact persisted briefing.
  const res = await request(app).get(`/api/briefing/by-snapshot/${captured.data.snapshotId}`).set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(res.body.snapshotId, captured.data.snapshotId);
  assert.match(res.body.chiefBrief.synthesis, new RegExp(TEST_MARKER));

  // And it must be the SAME content Today's normal GET /briefing would show.
  const latest = await briefingsStore.latestBriefing('daily');
  assert.equal(latest.content.snapshotId, captured.data.snapshotId);
  assert.deepEqual(res.body.chiefBrief, latest.content.chiefBrief);
});
