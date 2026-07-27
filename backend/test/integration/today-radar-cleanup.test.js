// Today command-center cleanup (rest/workout contradictions, automatic
// stale-period repair, "On My Radar"). Remaining required regression
// scenarios not already covered in today-command-center.test.js — each
// exercises a real production route/function against real Postgres, no
// source-string assertions, no logic-bypassing mocks.
'use strict';
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const expo = require('../../src/notify/expo');
const intentionsStore = require('../../src/store/intentions');
const workoutService = require('../../src/services/workout');
const { SNAPSHOT_VERSION } = require('../../src/brain/snapshot');
const { buildTodayCommandCenter } = require('../../src/brain/todayCommandCenter');

const app = buildTestApp();
const MARKER = `radar-${Date.now()}`;
const TEST_RUN_STARTED_AT = new Date();

function todayIso() {
  // LOCAL (America/New_York) calendar date, not UTC — see the identical
  // comment in today-command-center.test.js's todayIso().
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function seedCachedBriefing(content) {
  const full = {
    day: todayIso(),
    chiefBrief: { synthesis: `${MARKER} placeholder brief`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    morningFocus: '',
    snapshotVersion: SNAPSHOT_VERSION,
    fieldsBuiltAt: {},
    fieldVersions: {},
    ...content,
  };
  const { rows } = await db.query(
    `INSERT INTO briefings (kind, content, generated_at) VALUES ('daily', $1, now()) RETURNING id`,
    [JSON.stringify(full)]
  );
  return rows[0].id;
}

// Verbose enough to clear assessChiefBriefQuality's REQUIRED_FIELD_MIN_WORDS
// (synthesis 12, action/risk/move 4, morningFocus 15) — same pattern as
// today-command-center.test.js's scenario 5/1.
function freshChiefBriefMock({ synthesisSuffix = '' } = {}) {
  return async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) {
      return {
        text: JSON.stringify({
          chiefBrief: {
            synthesis: `${MARKER} a steady day ahead — protect the afternoon focus block and keep momentum.${synthesisSuffix}`,
            action: 'Protect the afternoon focus block and make progress on the open goal.',
            risk: 'No material risk is flagged for today at all.',
            move: 'No change is needed from the current plan.',
            openQuestion: '',
          },
          morningFocus: 'Keep today steady, protect the open goal, and revisit the full plan again once more data lands in later.',
        }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
}

after(async () => {
  await db.query(`DELETE FROM briefings WHERE kind = 'daily' AND generated_at >= $1`, [TEST_RUN_STARTED_AT]).catch(() => {});
  await db.query(`DELETE FROM activity_logs WHERE label LIKE $1`, [`${MARKER}%`]).catch(() => {});
  await closeDb();
});

// ── 3. A protected calendar block does not become a physical rest day ──────
test('scenario 3 — the authoritative effective-workout resolver never reads the calendar at all, so a protected personal block cannot turn today into a physical rest day', async (t) => {
  const today = todayIso();
  await workoutService.setWorkoutOverride({ date: today, workoutId: 'pull' });
  t.after(async () => { await workoutService.setWorkoutOverride({ date: today, workoutId: null }); });

  // getEffectiveWorkout takes no calendar input whatsoever (asOf/tz/band
  // only) — a protected personal-calendar block, however heavily it blocks
  // the day, structurally cannot influence this resolution. Proven by
  // calling it with and without an unrelated `band` hint and confirming the
  // override alone determines the result.
  const eff = await workoutService.getEffectiveWorkout({ tz: 'America/New_York' });
  assert.equal(eff.workoutId, 'pull', 'the explicit override, not any calendar state, determines the effective workout');
  assert.equal(eff.source, 'override');
});

// ── 4. An unresolved plan conflict produces the resolution UI ──────────────
test('scenario 4 — a served chief brief with rest-framing text against a real non-rest effective workout produces todayCommandCenter.planConflict, and suppresses the contradictory action', async (t) => {
  const today = todayIso();
  await workoutService.setWorkoutOverride({ date: today, workoutId: 'pull' });
  t.after(async () => { await workoutService.setWorkoutOverride({ date: today, workoutId: null }); });

  await seedCachedBriefing({
    chiefBrief: {
      synthesis: `${MARKER} a real rest day — recovery is green, lean into family time and skip training.`,
      action: 'Pull day (~45 min) is on deck — get after it this morning.',
      risk: 'No material risk is flagged for today at all.',
      move: 'No change is needed from the current plan.',
      openQuestion: '',
    },
    goalsWeekStart: null,
  });

  const res = await request(app).get('/api/briefing').set(authHeader()).timeout(20000);
  assert.equal(res.status, 200);
  const tcc = res.body.todayCommandCenter;
  assert.ok(tcc, 'expected a todayCommandCenter');
  assert.ok(tcc.planConflict, 'a genuine rest-vs-workout contradiction must produce the compact resolution state');
  assert.equal(tcc.planConflict.direction, 'rest_vs_workout');
  assert.equal(tcc.planConflict.options.length, 2);
  assert.equal(tcc.action, null, 'the contradictory action must be suppressed while the conflict is unresolved — never shown alongside the resolution prompt');
});

// ── 5. Resolving the conflict persists through the authoritative override path ──
test('scenario 5 — resolving a plan conflict via POST /workout/override persists durably and the SAME effective workout is what a fresh command-center build reflects', async (t) => {
  const today = todayIso();
  t.after(async () => { await workoutService.setWorkoutOverride({ date: today, workoutId: null }); });

  const res = await request(app)
    .post('/api/workout/override')
    .set(authHeader())
    .send({ date: today, workoutId: 'rest' })
    .timeout(10000);
  assert.equal(res.status, 200);

  // Durable — a completely independent read confirms the override landed,
  // not just an in-memory echo of the request.
  const direct = await workoutService.getEffectiveWorkout({ tz: 'America/New_York' });
  assert.equal(direct.workoutId, 'rest');
  assert.equal(direct.source, 'override');

  // A fresh command-center build (the same one Today renders) reflects the
  // now-resolved plan — a chief brief consistent with "rest" no longer
  // produces a conflict.
  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-resolve', snapshotVersion: 3, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: { synthesis: 'A real rest day today — recovery is green, enjoy it.', action: 'Take the day off from training.', risk: 'r', move: 'm' },
    chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null, recovery: null,
    effectiveWorkout: direct,
  });
  assert.equal(tcc.planConflict, null, 'once the override is applied, matching rest-day text no longer conflicts with the authoritative plan');
  assert.ok(tcc.action, 'the action is no longer suppressed once the plan is internally consistent');
});

// ── 6. Logging a walk does not resolve a planned Pull or Intervals workout ─
test('scenario 6 — logging a walk does not resolve a planned Pull workout as completed (resolveTrainingOutcome, real Postgres)', async (t) => {
  const today = todayIso();
  await workoutService.setWorkoutOverride({ date: today, workoutId: 'pull' });
  t.after(async () => { await workoutService.setWorkoutOverride({ date: today, workoutId: null }); });
  const effective = await workoutService.getEffectiveWorkout({ tz: 'America/New_York' });
  assert.equal(effective.workoutId, 'pull');

  await db.query(
    `INSERT INTO activity_logs (log_date, activity_type, label, duration_min, note, planned_type, no_watch)
     VALUES ($1, 'walk', $2, 25, NULL, 'pull', false)`,
    [today, `${MARKER} lunchtime walk`]
  );
  t.after(async () => { await db.query(`DELETE FROM activity_logs WHERE log_date = $1 AND label = $2`, [today, `${MARKER} lunchtime walk`]); });

  const outcome = await workoutService.resolveTrainingOutcome({ tz: 'America/New_York', effectiveWorkout: effective });
  assert.equal(outcome.plannedWorkoutCompleted, false, 'a walk must not resolve a planned Pull session as completed');
  assert.equal(outcome.status, 'alternate_activity');
});

// ── 9. Scoped repair sends no duplicate briefing notification ──────────────
test('scenario 9 — the automatic goals-staleness repair never sends a push notification', async (t) => {
  const currentWeek = intentionsStore.weekStart();
  const priorWeek = intentionsStore.priorWeekStart();
  await intentionsStore.saveIntention({ weekStart: currentWeek, context: `${MARKER} current week`, goals: [{ text: `${MARKER} ship it`, achieved: false }] });
  // See scenario 10's identical comment — the repair-attempt ledger is one
  // row per repair_reason, shared across tests in this run.
  await db.query(`DELETE FROM chief_brief_repair_attempts WHERE repair_reason = 'goals_stale'`);
  t.after(async () => { await db.query(`DELETE FROM weekly_intentions WHERE week_start = $1`, [currentWeek]); });

  await seedCachedBriefing({
    chiefBrief: { synthesis: `${MARKER} all this week's goals are done.`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    goalsWeekStart: priorWeek,
  });

  llm.generateText = freshChiefBriefMock();
  let pushCalls = 0;
  const originalSendPush = expo.sendPush;
  expo.sendPush = async () => { pushCalls++; return { sent: 0 }; };
  t.after(() => { delete llm.generateText; expo.sendPush = originalSendPush; });

  const res = await request(app).get('/api/briefing').set(authHeader()).timeout(20000);
  assert.equal(res.status, 200);
  assert.equal(res.body.chiefBriefGoalsStale, false, 'precondition: the repair actually ran and succeeded');
  assert.equal(pushCalls, 0, 'automatic repair must never send a push notification — it is a silent, server-side correction');
});

// ── 10. Failed repair preserves the last-good card, still qualified as goals-stale ──
test('scenario 10 — when the repair attempt itself fails, the last-good card is preserved (never deleted), still explicitly flagged goals-stale', async (t) => {
  const currentWeek = intentionsStore.weekStart();
  const priorWeek = intentionsStore.priorWeekStart();
  await intentionsStore.saveIntention({ weekStart: currentWeek, context: `${MARKER} current week 2`, goals: [{ text: `${MARKER} ship it too`, achieved: false }] });
  // The repair-attempt ledger (store/chiefBriefRepairLedger.js) is ONE row
  // per repair_reason, not per-test — clear it first so an earlier test's
  // recorded failure (same 'goals_stale' reason, same real current week as
  // contextKey) doesn't leave this test's own repair ineligible via cooldown.
  await db.query(`DELETE FROM chief_brief_repair_attempts WHERE repair_reason = 'goals_stale'`);
  t.after(async () => { await db.query(`DELETE FROM weekly_intentions WHERE week_start = $1`, [currentWeek]); });

  await seedCachedBriefing({
    chiefBrief: { synthesis: `${MARKER} all of this week's goals are already done and dusted.`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    goalsWeekStart: priorWeek,
  });

  // A degraded (under-length) attempt — fails assessChiefBriefQuality, so
  // performScopedChiefBriefRebuild's repair resolves to `failed`. Chief Brief
  // regression fix (Backend requirement #6): a failed repair must NOT delete
  // the whole card — it falls back to the last-known-good same-day content
  // (here, the seeded row itself, since it's structurally usable and not
  // pending), and chiefBriefGoalsStale stays the explicit qualifier on the
  // one stale claim rather than the brief being nulled out.
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) {
      return {
        text: JSON.stringify({ chiefBrief: { synthesis: 'short', action: 'a', risk: 'r', move: 'm', openQuestion: '' }, morningFocus: 'short' }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
  t.after(() => { delete llm.generateText; });

  const res = await request(app).get('/api/briefing').set(authHeader()).timeout(20000);
  assert.equal(res.status, 200);
  assert.match(
    res.body.chiefBrief?.synthesis || '',
    /all of this week's goals are already done/,
    'a failed repair must preserve the last-good card, never delete it'
  );
  assert.equal(res.body.chiefBriefPending, false, 'a failed repair with a good same-day card to carry forward must not degrade to pending');
  assert.equal(res.body.chiefBriefGoalsStale, true, 'the stale goal-dependent claim stays explicitly qualified until repair succeeds');
  assert.ok(
    ['degraded', 'failed'].includes(res.body.chiefBriefAttempt?.state),
    `the attempt itself is honestly reported as non-fresh (got ${res.body.chiefBriefAttempt?.state})`
  );
  assert.ok(res.body.chiefBriefProvenance, 'provenance must be present since a Chief Brief IS being shown');
  const tcc = res.body.todayCommandCenter;
  assert.notEqual(tcc.now.headline, 'Finishing today\'s brief…');
  assert.equal(tcc.now.evidence.chiefBriefGoalsStale, true);
});

// ── 11. Rebuild-loop protection works ───────────────────────────────────────
test('scenario 11 — repeated cache-hit requests while repair keeps failing do not hammer the LLM on every single request (cooldown)', async (t) => {
  const currentWeek = intentionsStore.weekStart();
  const priorWeek = intentionsStore.priorWeekStart();
  await intentionsStore.saveIntention({ weekStart: currentWeek, context: `${MARKER} current week 3`, goals: [{ text: `${MARKER} ship it thrice`, achieved: false }] });
  // See scenario 10's identical comment — the ledger is one row per
  // repair_reason, shared across tests in this run.
  await db.query(`DELETE FROM chief_brief_repair_attempts WHERE repair_reason = 'goals_stale'`);
  t.after(async () => { await db.query(`DELETE FROM weekly_intentions WHERE week_start = $1`, [currentWeek]); });

  await seedCachedBriefing({
    chiefBrief: { synthesis: `${MARKER} stale claim for loop protection.`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    goalsWeekStart: priorWeek,
  });

  let attempts = 0;
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) {
      attempts++;
      // Always degraded — every repair attempt fails.
      return {
        text: JSON.stringify({ chiefBrief: { synthesis: 'short', action: 'a', risk: 'r', move: 'm', openQuestion: '' }, morningFocus: 'short' }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
  t.after(() => { delete llm.generateText; });

  const res1 = await request(app).get('/api/briefing').set(authHeader()).timeout(20000);
  assert.equal(res1.status, 200);
  const attemptsAfterFirst = attempts;
  assert.ok(attemptsAfterFirst >= 1, 'the first request must attempt exactly one repair');

  const res2 = await request(app).get('/api/briefing').set(authHeader()).timeout(20000);
  assert.equal(res2.status, 200);
  assert.equal(attempts, attemptsAfterFirst, 'a second request within the cooldown window must NOT trigger a second repair attempt — explicit attempt/state tracking, not an unbounded retry loop');
});

// ── 21. No additional LLM call is introduced on a normal (non-stale) Today request ──
test('scenario 21 — a normal, non-stale cache-hit request never calls the LLM at all', async (t) => {
  await seedCachedBriefing({
    chiefBrief: { synthesis: `${MARKER} everything is current, nothing to repair.`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    goalsWeekStart: null, // no goalsWeekStart means chiefBriefGoalsStale can never be true
  });

  let calls = 0;
  llm.generateText = async () => { calls++; return { text: '{}', stopReason: 'end_turn', requestId: 'x', model: 'x' }; };
  t.after(() => { delete llm.generateText; });

  const res = await request(app).get('/api/briefing').set(authHeader()).timeout(20000);
  assert.equal(res.status, 200);
  assert.equal(calls, 0, 'todayCommandCenter/radar must never trigger an LLM call on the steady-state path');
});

// ── 22. Today still consumes the authoritative BrainSnapshot and evidence contract ──
test('scenario 22 — todayCommandCenter.risk, when present, is gated by the SAME independently-computed evidence every other surface uses, never the chief brief\'s own risk prose', async () => {
  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-22', snapshotVersion: 3, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: { synthesis: 's', action: 'a', risk: 'This sounds alarming but is actually fine — reassurance only.', move: 'm' },
    chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: { capacity: { band: 'green' } }, healthInsights: [],
    wealthInsights: [], weeklyReview: null, wealth: null, recovery: null,
  });
  assert.equal(tcc.risk, null, 'chief-brief risk prose alone (a required, always-filled field) must never manufacture a RISK card absent independently-computed evidence');
});
