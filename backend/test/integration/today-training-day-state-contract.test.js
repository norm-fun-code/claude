// The trainingDayState fact/state layer (brain/trainingDayState.js) —
// production regression coverage for the incident where Today rendered:
//   headline: "Treat today as a genuine rest day, not a data point."
//   action:   "Today's Pull session (~45 min) is the only structured load."
// Both fields were free text from the same chief-brief LLM call with nothing
// forcing them to agree with each other or with the authoritative effective
// workout. These tests exercise the real production functions (buildTodayCommandCenter,
// the /api/briefing cache-hit auto-repair) against real Postgres.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const documents = require('../../src/store/documents');
const monarchWealth = require('../../src/services/monarch-wealth');
const workoutService = require('../../src/services/workout');
const { buildTodayCommandCenter } = require('../../src/brain/todayCommandCenter');
const { SNAPSHOT_VERSION } = require('../../src/brain/snapshot');

const app = buildTestApp();
const MARKER = `tds-${Date.now()}`;
const TEST_RUN_STARTED_AT = new Date();

function todayIso() {
  // LOCAL (America/New_York) calendar date, not UTC — getEffectiveWorkout
  // and every other production "today" resolver key off the injected tz, so
  // a UTC-date fixture silently misses its own override during the ET-behind-
  // UTC window (~8pm-midnight ET), when UTC has already rolled to tomorrow.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function seedCachedBriefing(content) {
  const full = {
    day: todayIso(),
    chiefBrief: { synthesis: `${MARKER} placeholder`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
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

after(async () => {
  await db.query(`DELETE FROM briefings WHERE kind = 'daily' AND generated_at >= $1`, [TEST_RUN_STARTED_AT]).catch(() => {});
  await closeDb();
});

// ── 1. The exact production fixture resolves to WORKOUT, headline and action agree ──
test('scenario 1 — production fixture (Sunday, provisional recovery 80, missing sleep device, Pull scheduled, family calendar block, no override) resolves WORKOUT and neutralizes the contradiction, not REST', async () => {
  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-tds-1', snapshotVersion: SNAPSHOT_VERSION, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: {
      synthesis: 'Treat today as a genuine rest day, not a data point.',
      action: "Today's Pull session (~45 min) is the only structured load.",
      risk: 'Nothing acute today.', move: 'No major change.',
    },
    chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null,
    // Provisional/self-reported recovery (missing Eight Sleep device data) —
    // must NOT be able to convert Pull into rest.
    recovery: { proxy: true, category: 'Good', score: 80 },
    effectiveWorkout: { label: 'Pull', source: 'scheduled', workoutId: 'pull', scheduledLabel: 'Pull', scheduledWorkoutId: 'pull' },
  });
  assert.equal(tcc.now.evidence.trainingDayState, 'WORKOUT', 'Pull is scheduled with no override — the resolved state must be WORKOUT, never REST');
  assert.ok(tcc.planConflict, 'the raw headline/action contradiction must be caught and surfaced as a resolvable conflict, not silently rendered');
  assert.notEqual(tcc.now.headline, 'Treat today as a genuine rest day, not a data point.', 'the raw contradictory headline must never be served verbatim');
  assert.match(tcc.now.headline, /Resolve below to continue/, 'the served headline must be the deterministic conflict-resolution line, not an LLM reconciliation attempt');
  assert.equal(tcc.action, null, 'a detected conflict suppresses the action until resolved — never a contradictory action alongside a rest headline');
});

// ── 2. A protected family calendar block does not create REST ─────────────
test('scenario 2 — a protected family calendar block never appears as a reason to call today REST (trainingDayState never reads calendar data)', async () => {
  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-tds-2', snapshotVersion: SNAPSHOT_VERSION, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: {
      synthesis: "Family time is protected on the calendar today, and Pull (~45 min) is today's structured load.",
      action: 'Get Pull in before the family block starts this afternoon.',
      risk: 'Nothing acute today.', move: 'No major change.',
    },
    chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null,
    recovery: { proxy: true, category: 'Good', score: 80 },
    effectiveWorkout: { label: 'Pull', source: 'scheduled', workoutId: 'pull', scheduledLabel: 'Pull', scheduledWorkoutId: 'pull' },
  });
  assert.equal(tcc.now.evidence.trainingDayState, 'WORKOUT');
  assert.equal(tcc.planConflict, null, 'consistent WORKOUT framing that merely mentions a calendar block must not be flagged as a conflict');
  assert.ok(tcc.action, 'a consistent WORKOUT day keeps its action');
});

// ── 3. Missing Eight Sleep data does not create REST ───────────────────────
test('scenario 3 — no recovery reading at all (device away / sync missed) never creates REST on a scheduled Pull day', async () => {
  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-tds-3', snapshotVersion: SNAPSHOT_VERSION, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: { synthesis: "Pull (~45 min) is today's structured load.", action: 'Get Pull in this morning.', risk: 'r', move: 'm' },
    chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null,
    recovery: null,
    effectiveWorkout: { label: 'Pull', source: 'scheduled', workoutId: 'pull', scheduledLabel: 'Pull', scheduledWorkoutId: 'pull' },
  });
  assert.equal(tcc.now.evidence.trainingDayState, 'WORKOUT');
  assert.equal(tcc.planConflict, null);
});

// ── 4. An explicit persisted rest override creates REST and suppresses Pull ─
test('scenario 4 — a real persisted rest override resolves REST and a leftover Pull-prescribing action is caught as a conflict', async (t) => {
  const today = todayIso();
  await workoutService.setWorkoutOverride({ date: today, workoutId: 'rest' });
  t.after(async () => { await workoutService.setWorkoutOverride({ date: today, workoutId: null }); });
  const eff = await workoutService.getEffectiveWorkout({ tz: 'America/New_York' });
  assert.equal(eff.source, 'override');
  assert.equal(eff.label, 'Rest');

  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-tds-4', snapshotVersion: SNAPSHOT_VERSION, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: {
      synthesis: 'Recovery is green today.',
      action: `Today's ${eff.scheduledLabel} session (~45 min) is the only structured load.`,
      risk: 'r', move: 'm',
    },
    chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null,
    recovery: { proxy: false, score: 88 },
    effectiveWorkout: eff,
  });
  assert.equal(tcc.now.evidence.trainingDayState, 'REST');
  assert.ok(tcc.planConflict, 'a leftover workout-prescribing action against an explicit rest override must be caught');
  assert.equal(tcc.action, null, 'the workout action must be suppressed, never shown alongside the rest override');
});

// ── 5. True ambiguity renders the conflict resolver, with both options ────
test('scenario 5 — an unresolved contradiction renders the explicit "Keep rest day" / "Do <workout>" resolver, not a prose reconciliation', async () => {
  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-tds-5', snapshotVersion: SNAPSHOT_VERSION, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: {
      synthesis: 'Treat today as a genuine rest day, not a data point.',
      action: "Today's Pull session (~45 min) is the only structured load.",
      risk: 'r', move: 'm',
    },
    chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null,
    recovery: { proxy: true, score: 80 },
    effectiveWorkout: { label: 'Pull', source: 'scheduled', workoutId: 'pull', scheduledLabel: 'Pull', scheduledWorkoutId: 'pull' },
  });
  assert.ok(tcc.planConflict, 'expected a rendered conflict');
  assert.equal(tcc.planConflict.direction, 'rest_vs_workout');
  assert.equal(tcc.planConflict.options.length, 2);
  assert.deepEqual(tcc.planConflict.options.map((o) => o.id), ['keep_rest', 'do_planned']);
  assert.deepEqual(tcc.planConflict.options.map((o) => o.workoutId), ['rest', 'pull']);
  assert.equal(tcc.planConflict.stableId, `planConflict:snap-tds-5`);
});

// ── 6. NOW headline and the action are derived from the SAME resolved state ─
test('scenario 6 — NOW.headline and ACTION are never independently derived: both come from the SAME trainingDayState/snapshot identity', async () => {
  const snapshotId = 'snap-tds-6';
  // Consistent WORKOUT case: NOW carries the raw synthesis verbatim (never
  // re-synthesized) AND the action is populated from the SAME chiefBrief —
  // proving there is no second, independent read of "what is today."
  const tccConsistent = await buildTodayCommandCenter({
    snapshotId, snapshotVersion: SNAPSHOT_VERSION, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: { synthesis: 'Pull is on deck today, recovery is green.', action: 'Get Pull done this morning.', risk: 'r', move: 'm' },
    chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null,
    recovery: { proxy: false, score: 88 },
    effectiveWorkout: { label: 'Pull', source: 'scheduled', workoutId: 'pull', scheduledLabel: 'Pull', scheduledWorkoutId: 'pull' },
  });
  assert.equal(tccConsistent.now.evidence.trainingDayState, 'WORKOUT');
  assert.equal(tccConsistent.now.headline, 'Pull is on deck today, recovery is green.');
  assert.equal(tccConsistent.action.title, 'Get Pull done this morning.');
  assert.equal(tccConsistent.now.stableId, `now:${snapshotId}`);
  assert.equal(tccConsistent.action.stableId, `action:${snapshotId}`, 'headline and action share the same snapshot identity in their stableIds');

  // Conflicting case: BOTH headline and action are replaced together, from
  // the SAME resolved trainingDayState — never one patched and the other left raw.
  const tccConflict = await buildTodayCommandCenter({
    snapshotId, snapshotVersion: SNAPSHOT_VERSION, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: {
      synthesis: 'Treat today as a genuine rest day, not a data point.',
      action: "Today's Pull session (~45 min) is the only structured load.",
      risk: 'r', move: 'm',
    },
    chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null,
    recovery: { proxy: true, score: 80 },
    effectiveWorkout: { label: 'Pull', source: 'scheduled', workoutId: 'pull', scheduledLabel: 'Pull', scheduledWorkoutId: 'pull' },
  });
  assert.notEqual(tccConflict.now.headline, 'Treat today as a genuine rest day, not a data point.', 'the raw contradictory headline must never be served verbatim');
  assert.equal(tccConflict.action, null, 'the action must be suppressed in lockstep with the headline replacement, not left dangling');
  assert.equal(tccConflict.now.evidence.planConflict, true);
  assert.equal(tccConflict.now.evidence.trainingDayState, 'WORKOUT');
  assert.equal(tccConflict.planConflict.effectiveWorkoutLabel, 'Pull');
});

// ── 7. An invalid cached brief is automatically rebuilt on the next cache-hit serve ──
test('scenario 7 — a STORED brief that fails the trainingDayState contract is auto-repaired on the next cache-hit GET, even though it otherwise passes cache freshness', async (t) => {
  const today = todayIso();
  await workoutService.setWorkoutOverride({ date: today, workoutId: null }); // ensure scheduled (not overridden) Pull-or-whatever
  const eff = await workoutService.getEffectiveWorkout({ tz: 'America/New_York' });
  // Only meaningful when today's effective session is an actual workout (not
  // already Rest) — force it deterministically via a 'pull' override so the
  // scenario always exercises the WORKOUT-vs-rest-claim path regardless of
  // the real schedule on the day this suite happens to run.
  await workoutService.setWorkoutOverride({ date: today, workoutId: 'pull' });
  t.after(async () => { await workoutService.setWorkoutOverride({ date: today, workoutId: null }); });
  const pullEff = await workoutService.getEffectiveWorkout({ tz: 'America/New_York' });
  assert.equal(pullEff.label, 'Pull');

  await seedCachedBriefing({
    chiefBrief: {
      synthesis: `${MARKER} Treat today as a genuine rest day, not a data point.`,
      action: `${MARKER} Today's Pull session (~45 min) is the only structured load.`,
      risk: 'r', move: 'm', openQuestion: '',
    },
    effectiveWorkout: pullEff,
    workout: { label: pullEff.label },
  });

  const REPAIRED = `${MARKER} repaired synthesis — Pull is on deck today, recovery is green enough to hold the plan steady.`;
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) {
      return {
        text: JSON.stringify({
          chiefBrief: {
            synthesis: REPAIRED,
            action: `${MARKER} Get Pull done this morning while the schedule stays light.`,
            risk: 'No material risk is flagged for today at all.',
            move: 'No change is needed from the current plan.',
            openQuestion: '',
          },
          morningFocus: 'Keep today steady, get the session in, and revisit the plan again at midday if anything changes materially.',
        }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
  t.after(() => { delete llm.generateText; });

  const res = await request(app).get('/api/briefing').set(authHeader()).timeout(20000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.chiefBrief.synthesis, REPAIRED, 'the invalid cached synthesis must be replaced by a fresh, contract-passing repair — not re-served as-is');
  assert.doesNotMatch(res.body.chiefBrief.synthesis, /rest day/i);
  const tcc = res.body.todayCommandCenter;
  assert.ok(tcc, 'expected a todayCommandCenter');
  assert.equal(tcc.now.evidence.trainingDayState, 'WORKOUT');
  assert.equal(tcc.now.evidence.planConflict, false, 'after the repair, the served state must no longer show a conflict');
});
