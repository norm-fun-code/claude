// Chief Brief regression fix — the 8 required backend regression scenarios,
// each exercising a real production route/store function against real
// Postgres. Root cause under test: a failed/degraded/pending build or
// automatic-repair attempt must never delete, replace, or invalidate a
// valid same-local-day Chief Brief already published — see
// store/briefings.js's resolveLastGoodChiefBrief/latestPublishableDailyForLocalDay,
// routes/briefing.js's performScopedChiefBriefRebuild, and
// store/chiefBriefRepairLedger.js.
//
// Each test uses its OWN marker suffix and cleans up its own rows in
// t.after — several scenarios deliberately seed multiple same-day rows, and
// this file's selectors scan broadly across same-day history by design, so
// cross-test contamination (an earlier test's leftover row being "found" by
// a later test's own recovery scan) is a real risk without per-test isolation.
'use strict';
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const briefingsStore = require('../../src/store/briefings');
const { SNAPSHOT_VERSION } = require('../../src/brain/snapshot');

const app = buildTestApp();
const MARKER = `cb-lifecycle-${Date.now()}`;

function todayIso() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function seedRow(content, { generatedAt = null } = {}) {
  const full = {
    testMarker: MARKER,
    localDate: todayIso(),
    chiefBrief: { synthesis: `${MARKER} placeholder brief`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    morningFocus: '',
    snapshotVersion: SNAPSHOT_VERSION,
    fieldsBuiltAt: {},
    fieldVersions: {},
    ...content,
  };
  const { rows } = await db.query(
    generatedAt
      ? `INSERT INTO briefings (kind, content, generated_at) VALUES ('daily', $1, $2) RETURNING id, generated_at`
      : `INSERT INTO briefings (kind, content, generated_at) VALUES ('daily', $1, now()) RETURNING id, generated_at`,
    generatedAt ? [JSON.stringify(full), generatedAt] : [JSON.stringify(full)]
  );
  return rows[0];
}

// Cleans up every row this test file could have created (marker-scoped, not
// time-scoped — scenario 6 deliberately seeds a row dated YESTERDAY). Called
// after EVERY test so one scenario's seeded rows can never bleed into the
// next scenario's "what's the latest/only row" assertions.
async function cleanupAllTagged() {
  await db.query(
    `DELETE FROM briefings WHERE kind = 'daily' AND content->>'testMarker' = $1`,
    [MARKER]
  ).catch(() => {});
}

function degradedChiefMock() {
  return async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) {
      return {
        text: JSON.stringify({ chiefBrief: { synthesis: 'short', action: 'a', risk: 'r', move: 'm', openQuestion: '' }, morningFocus: 'short' }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
}

function freshChiefMock(text) {
  return async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) {
      return {
        text: JSON.stringify({
          chiefBrief: {
            synthesis: `${MARKER} ${text}`,
            action: 'Make progress on the open goal today, deliberately and without rushing.',
            risk: 'No material risk is flagged for today at all.',
            move: 'No change is needed from the current plan.',
            openQuestion: '',
          },
          morningFocus: 'Keep today steady, protect the open goal, and revisit the plan again later if anything changes.',
        }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
}

after(async () => {
  await cleanupAllTagged();
  await closeDb();
});

// ── 1. Good same-day build followed by degraded full attempt: GET still returns the good Chief Brief ──
test('scenario 1 — a good same-day build followed by a degraded full-rebuild attempt: GET /briefing still returns the good Chief Brief', async (t) => {
  t.after(cleanupAllTagged);
  const GOOD = `${MARKER} today is genuinely on track — protect the afternoon focus block and keep steady momentum.`;
  await seedRow({ chiefBrief: { synthesis: GOOD, action: 'a', risk: 'r', move: 'm', openQuestion: '' } });

  llm.generateText = degradedChiefMock();
  t.after(() => { delete llm.generateText; });

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.chiefBrief.synthesis, GOOD, 'the degraded attempt must never overwrite the existing good brief');
  assert.equal(res.body.chiefBriefStale, true, 'carried-forward content is explicitly flagged stale');
  assert.equal(res.body.chiefBriefProvenance?.source, 'last_good');
});

// ── 2. Good same-day build followed by failed scoped repair: no null row replaces it ──
test('scenario 2 — a good same-day build followed by a failed scoped repair: no null row replaces it in the briefings table', async (t) => {
  t.after(cleanupAllTagged);
  const GOOD = `${MARKER} the plan for today is steady and everything checks out fine so far.`;
  const seeded = await seedRow({ chiefBrief: { synthesis: GOOD, action: 'a', risk: 'r', move: 'm', openQuestion: '' } });

  llm.generateText = degradedChiefMock();
  t.after(() => { delete llm.generateText; });

  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.chiefBrief.synthesis, GOOD, 'the failed repair must carry forward the good brief, not null it');

  // id-scoped, not generated_at-scoped: `seeded.generated_at` came back from
  // RETURNING as a JS Date (millisecond precision); Postgres's own
  // timestamptz column retains microsecond precision, so re-sending that
  // (rounded) JS Date as a `>` bound can spuriously match the seeded row
  // itself back. Marker-scoped so an unrelated pre-existing row in a shared
  // dev DB can't produce a false failure here either.
  const { rows } = await db.query(
    `SELECT content->'chiefBrief' AS cb FROM briefings WHERE kind = 'daily' AND content->>'testMarker' = $1 AND id != $2`,
    [MARKER, seeded.id]
  );
  assert.equal(rows.length, 0, 'a failed scoped-repair attempt must not insert ANY new row — a chiefBrief:null row would poison every subsequent GET');
});

// ── 3. Automatic goals-staleness repair failure preserves the prior published brief ──
test('scenario 3 — automatic goals-staleness repair failure preserves the prior published brief (via GET /briefing, not the manual endpoint)', async (t) => {
  t.after(cleanupAllTagged);
  const intentionsStore = require('../../src/store/intentions');
  const currentWeek = intentionsStore.weekStart();
  const priorWeek = intentionsStore.priorWeekStart();
  await intentionsStore.saveIntention({ weekStart: currentWeek, context: `${MARKER} cw`, goals: [{ text: `${MARKER} ship it`, achieved: false }] });
  await db.query(`DELETE FROM chief_brief_repair_attempts WHERE repair_reason = 'goals_stale'`);
  t.after(async () => { await db.query(`DELETE FROM weekly_intentions WHERE week_start = $1`, [currentWeek]); });

  const STALE_GOOD = `${MARKER} all of this week's goals are already wrapped up, nice work.`;
  await seedRow({ chiefBrief: { synthesis: STALE_GOOD, action: 'a', risk: 'r', move: 'm', openQuestion: '' }, goalsWeekStart: priorWeek });

  llm.generateText = degradedChiefMock();
  t.after(() => { delete llm.generateText; });

  const res = await request(app).get('/api/briefing').set(authHeader()).timeout(20000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.chiefBrief.synthesis, STALE_GOOD, 'the prior published brief must survive a failed automatic goals repair');
  assert.equal(res.body.chiefBriefPending, false);
  assert.equal(res.body.chiefBriefGoalsStale, true, 'still explicitly flagged stale until a repair succeeds');
});

// ── 4. Latest row degraded/null but an earlier same-day row is fresh: publishable selector recovers the fresh row ──
test('scenario 4 — latest row pending/null but an earlier same-day row is publishable: the selector recovers it, GET /briefing serves it', async (t) => {
  t.after(cleanupAllTagged);
  const GOOD = `${MARKER} the earlier build today was solid — steady plan, nothing urgent to flag.`;
  await seedRow({ chiefBrief: { synthesis: GOOD, action: 'a', risk: 'r', move: 'm', openQuestion: '' } });
  // A later, POISONED row — exactly what the old destructive path could
  // insert (chiefBrief: null, chiefBriefPending: true) as the newest row.
  const poisoned = await seedRow({ chiefBrief: null, chiefBriefPending: true, chiefBriefQuality: { status: 'failed' } });

  // Unit-level: the selector itself recovers the earlier good row.
  const recovered = await briefingsStore.latestPublishableDailyForLocalDay(todayIso());
  assert.ok(recovered, 'expected a publishable row to be found');
  assert.equal(recovered.content.chiefBrief.synthesis, GOOD);
  assert.notEqual(recovered.id, poisoned.id);

  // Route-level: GET /briefing (cache-hit path) must self-heal the same way.
  const res = await request(app).get('/api/briefing').set(authHeader()).timeout(20000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.chiefBrief.synthesis, GOOD, 'GET /briefing must recover the earlier good row, not serve the poisoned latest one');
  assert.equal(res.body.chiefBriefPending, false);
});

// ── 5. No valid same-day row: honest failed/pending response ──
test('scenario 5 — no valid same-day row exists at all: GET /briefing returns an honest pending response, never fabricated content', async (t) => {
  t.after(cleanupAllTagged);
  await seedRow({ chiefBrief: null, chiefBriefPending: true, chiefBriefQuality: { status: 'failed' } });

  llm.generateText = degradedChiefMock();
  t.after(() => { delete llm.generateText; });

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.chiefBrief, null);
  assert.equal(res.body.chiefBriefPending, true);
  assert.equal(res.body.chiefBriefProvenance, null, 'no content is being shown, so provenance must be null');
  assert.ok(['degraded', 'failed'].includes(res.body.chiefBriefAttempt?.state));
});

// ── 6. A prior-day good row is not returned as today's brief ──
test('scenario 6 — a prior-day good row is never returned as today\'s Chief Brief', async (t) => {
  t.after(cleanupAllTagged);
  const YESTERDAY_GOOD = `${MARKER} yesterday's plan was steady and everything wrapped up fine.`;
  const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
  await seedRow(
    { chiefBrief: { synthesis: YESTERDAY_GOOD, action: 'a', risk: 'r', move: 'm', openQuestion: '' }, localDate: '2000-01-01' },
    { generatedAt: yesterday }
  );
  // No row for TODAY at all — only yesterday's good one exists.

  const recovered = await briefingsStore.latestPublishableDailyForLocalDay(todayIso());
  assert.equal(recovered, null, 'a prior-day row must never be returned when scanning for TODAY\'s publishable row');

  // Route-level: GET /briefing must not resurrect yesterday's content as today's.
  llm.generateText = degradedChiefMock();
  t.after(() => { delete llm.generateText; });
  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.notEqual(res.body.chiefBrief?.synthesis, YESTERDAY_GOOD, 'yesterday\'s content must never masquerade as today\'s brief');
});

// ── 7. Successful repair replaces the old content ──
test('scenario 7 — a successful scoped repair replaces the old content and IS persisted as a new row', async (t) => {
  t.after(cleanupAllTagged);
  const OLD = `${MARKER} the old plan before repair.`;
  const seeded = await seedRow({ chiefBrief: { synthesis: OLD, action: 'a', risk: 'r', move: 'm', openQuestion: '' } });

  // Clears assessChiefBriefQuality's REQUIRED_FIELD_MIN_WORDS (synthesis 12
  // words) once the single-token MARKER prefix is counted in.
  const NEW = 'a fresh, genuinely updated plan for today with real specifics and clear next steps.';
  llm.generateText = freshChiefMock(NEW);
  t.after(() => { delete llm.generateText; });

  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.chiefBrief.synthesis, new RegExp(NEW.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(res.body.chiefBriefStale, false);
  assert.equal(res.body.chiefBriefProvenance?.source, 'fresh');

  const { rows } = await db.query(
    `SELECT content->'chiefBrief'->>'synthesis' AS synthesis FROM briefings WHERE kind = 'daily' AND content->>'testMarker' = $1 AND id != $2`,
    [MARKER, seeded.id]
  );
  assert.equal(rows.length, 1, 'a successful repair must publish exactly one new row');
  assert.match(rows[0].synthesis, /fresh, genuinely updated plan/);
});

// ── 8. Failed attempts remain visible in attempt diagnostics without entering the published-content path ──
test('scenario 8 — failed attempts remain visible in the repair-attempt ledger without ever entering the published-content path', async (t) => {
  t.after(cleanupAllTagged);
  await db.query(`DELETE FROM chief_brief_repair_attempts WHERE repair_reason = 'plan_conflict'`);
  const chiefBriefRepairLedger = require('../../src/store/chiefBriefRepairLedger');

  await chiefBriefRepairLedger.recordAttempt({ repairReason: 'plan_conflict', succeeded: false, reasonCodes: ['synthesis_underfilled'] });
  const last = await chiefBriefRepairLedger.lastAttempt('plan_conflict');
  assert.ok(last, 'the failed attempt must be durably recorded');
  assert.equal(last.succeeded, false);
  assert.deepEqual(last.reason_codes, ['synthesis_underfilled']);

  // And it must never have touched the briefings table.
  const { rows } = await db.query(
    `SELECT 1 FROM briefings WHERE kind = 'daily' AND content->'chiefBriefQuality'->'reasonCodes' @> '["synthesis_underfilled"]'::jsonb`
  );
  assert.equal(rows.length, 0, 'attempt diagnostics must live in the ledger, never leak into a published briefings row via this path');
});

// ── Production-like end-to-end regression sequence ──
test('e2e — publish a valid morning brief, run a degraded later attempt, simulate app termination (cold-launch GET), the same morning brief remains visible', async (t) => {
  t.after(cleanupAllTagged);
  const MORNING = `${MARKER} the morning brief: today is steady, protect the focus block, ship the open item.`;
  await seedRow({ chiefBrief: { synthesis: MORNING, action: 'a', risk: 'r', move: 'm', openQuestion: '' } });

  // A later, degraded automatic attempt (simulating an afternoon watcher-triggered rebuild).
  llm.generateText = degradedChiefMock();
  const degradedRes = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(degradedRes.status, 200);
  assert.equal(degradedRes.body.chiefBrief.synthesis, MORNING, 'the degraded attempt must not have replaced the morning brief');
  // The failed-attempt status is shown non-destructively on THIS response —
  // a degraded/failed FULL-build attempt is deliberately never persisted
  // (see buildFreshBriefing's publish gate), so a LATER, unrelated request
  // has no durable memory of it; in production the mobile client's own
  // merge/cache (see mobile/src/lib/briefingMerge.ts) is what carries this
  // exact attempt verdict forward across the "kill and reopen" gap, not the
  // server remembering a transient attempt forever.
  assert.ok(
    ['degraded', 'failed'].includes(degradedRes.body.chiefBriefAttempt?.state),
    `expected a non-fresh attempt state on the degraded response; got ${degradedRes.body.chiefBriefAttempt?.state}`
  );
  delete llm.generateText;

  // "Kill and reopen the app": nothing client-side persists across this in an
  // integration test — the only durable state is Postgres. A cold-launch GET
  // /briefing (no refresh) must still serve the identical morning brief.
  const coldLaunchRes = await request(app).get('/api/briefing').set(authHeader()).timeout(20000);
  assert.equal(coldLaunchRes.status, 200);
  assert.equal(coldLaunchRes.body.chiefBrief.synthesis, MORNING, 'cold-launch GET /briefing after app restart must still show the identical morning Chief Brief');
  assert.ok(!coldLaunchRes.body.chiefBriefPending, 'must not be pending — real content is showing');
});
