// BrainSnapshot composition + thin projections. The whole point of the layer:
// one fixture of domain state → identical canonical facts on every surface
// (briefing, Ask, realtime voice, evening review), and a realtime session that
// refuses to narrate a stale brief as "today". These run WITHOUT a database:
// buildBrainSnapshot's authorities are stubbed on their module singletons so
// the composition itself is what's under test, deterministically and with an
// injected timezone (requirement #9: never depend on the process TZ).
const test = require('node:test');
const assert = require('node:assert/strict');

const snapshotMod = require('../src/brain/snapshot');
const { buildBrainSnapshot, realtimeTodayContext, canonicalFacts, canonicalFactsFrom, fact } = snapshotMod;

// ── Deterministic fixture ────────────────────────────────────────────────────
const ASOF = new Date('2026-06-11T14:30:00.000Z'); // a fixed instant
const TZ = 'America/New_York';                       // injected, not process.env.TZ
const RECOVERY = { score: 41, band: 'red', proxy: false, rawHrv: 39, rawRhr: 57, parts: {}, detail: {} };
const EFFECTIVE_WORKOUT = {
  source: 'auto_downgrade', workoutId: 'mobility', label: 'Mobility',
  isHard: false, scheduledWorkoutId: 'push', scheduledLabel: 'Push', recoveryBand: 'red',
};
const FORECAST = { capacity: { grade: 'B-', band: 'yellow', proxy: false }, tomorrow: { band: 'green' } };
const TRAINING_OUTCOME = {
  exerciseHabitDone: false, plannedWorkoutCompleted: false, actualActivities: [],
  hardSessionCompleted: false, status: 'planned_only',
  plannedWorkoutId: 'mobility', plannedWorkoutLabel: 'Mobility',
  completionSource: null, completedAt: null,
};
const GOALS = [{ title: 'Ship the wealth reconciler', achieved: false }];
const COMMITMENTS = [{ title: 'Call the accountant', status: 'open' }];
const EXPERIMENTS = [{ hypothesis: 'Magnesium improves deep sleep', status: 'running', verdict: null }];
// Display insight cards (what buildWealthInsights returns) + the canonical MTD
// discretionary spend the snapshot computes separately from the metric spine.
const WEALTH_INSIGHTS = [{ type: 'spending_pattern', title: 'Dining up 20%' }];
const SPENDING_MTD = 2450; // sum of stubbed spending_discretionary rows
// A fixed, deterministic ResolvedContext (see intelligence/context-resolver.js)
// — stubbed like every other authority below so this file keeps its "runs
// WITHOUT a database" guarantee; resolveContext's real implementation calls
// store/contextAssertions + store/contextRelations, both real DB reads.
const RESOLVED_CONTEXT = {
  generatedAt: ASOF.toISOString(), tz: TZ, assertions: [], assertionById: new Map(),
  relations: [], relationsByTarget: new Map(), preferences: [],
  unresolvedUncertainties: [], resolvedUncertainties: [], resolvedCorrections: [],
};

// Stub each authority on its module singleton (buildBrainSnapshot require()s
// these lazily, so mutating the cached exports is enough). Save + restore.
const stubs = [];
function stub(modPath, name, fn) {
  const mod = require(modPath);
  stubs.push([mod, name, mod[name]]);
  mod[name] = fn;
}
test.before(() => {
  stub('../src/services/workout', 'getEffectiveWorkout', async () => EFFECTIVE_WORKOUT);
  stub('../src/services/workout', 'resolveTrainingOutcome', async () => TRAINING_OUTCOME);
  stub('../src/intelligence/predict', 'computeTodayForecast', async () => FORECAST);
  stub('../src/store/goals', 'listGoals', async () => GOALS);
  stub('../src/store/intentions', 'currentIntention', async () => ({ context: 'Focus week' }));
  stub('../src/store/commitments', 'listActive', async () => COMMITMENTS);
  stub('../src/services/wealth-insights', 'buildWealthInsights', async () => WEALTH_INSIGHTS);
  // Canonical MTD spend is summed from spending_discretionary daily rows.
  stub('../src/store/metrics', 'dailyAggregate', async ({ metric }) =>
    metric === 'spending_discretionary' ? [{ day: '2026-06-01', value: SPENDING_MTD }] : []);
  stub('../src/store/findings', 'listFindings', async () => []);
  stub('../src/store/experiments', 'listExperiments', async () => EXPERIMENTS);
  stub('../src/store/annotations', 'overlapping', async () => []);
  stub('../src/store/sources', 'listSources', async () => []);
  stub('../src/intelligence/source-health', 'describeDataGaps', async () => []);
  stub('../src/intelligence/context-resolver', 'resolveContext', async () => RESOLVED_CONTEXT);
});
test.after(() => { for (const [mod, name, orig] of stubs) mod[name] = orig; });

async function buildFixtureSnapshot() {
  // recovery passed in → no liveRecovery lookup needed.
  return buildBrainSnapshot({ asOf: ASOF, tz: TZ, recovery: RECOVERY });
}

// ── Requirement #5: one fixture → identical facts across every surface ───────
test('a single snapshot yields identical recovery/workout/goal/commitment/spending/forecast facts on every surface', async () => {
  const snap = await buildFixtureSnapshot();

  // The briefing/Ask hot path builds facts from raw parts via canonicalFactsFrom;
  // the snapshot path projects via canonicalFacts. They MUST agree — that's the
  // single-source-of-truth guarantee.
  const fromParts = canonicalFactsFrom({
    recovery: RECOVERY, effectiveWorkout: EFFECTIVE_WORKOUT, trainingOutcome: TRAINING_OUTCOME, forecast: FORECAST,
    goals: GOALS, commitments: COMMITMENTS, experiments: EXPERIMENTS,
    wealth: { insights: WEALTH_INSIGHTS, spendingMtd: SPENDING_MTD },
    localDate: snap.localDate,
    resolvedContext: RESOLVED_CONTEXT,
  });
  const fromSnap = canonicalFacts(snap);
  assert.deepEqual(fromSnap, fromParts);
  assert.equal(fromSnap.spendingTotalMonth, SPENDING_MTD);

  // Spot the canonical values themselves.
  assert.equal(fromSnap.recoveryBand, 'red');
  assert.equal(fromSnap.recoveryScore, 41);
  assert.deepEqual(fromSnap.observedMetrics.map((m) => [m.metric, m.value, m.unit]), [
    ['hrv', 39, 'ms'],
    ['resting_hr', 57, 'bpm'],
  ]);
  assert.equal(fromSnap.effectiveWorkoutLabel, 'Mobility');
  assert.equal(fromSnap.effectiveWorkoutSource, 'auto_downgrade');
  assert.equal(fromSnap.forecastGrade, 'B-');
  assert.equal(fromSnap.tomorrowBand, 'green');
  // Workout-identity fix: trainingOutcome facts flow through the same
  // single-source-of-truth projection as everything else.
  assert.equal(fromSnap.plannedWorkoutCompleted, false);
  assert.equal(fromSnap.hardSessionCompleted, false);
  assert.equal(fromSnap.trainingOutcomeStatus, 'planned_only');

  // The realtime voice projection reads the SAME effective workout + recovery —
  // not a re-derivation. (Requirement: realtime + briefing describe one session.)
  const rt = realtimeTodayContext(snap, null);
  assert.equal(rt.workout.type, snap.effectiveWorkout.value.label);
  assert.equal(rt.workout.type, fromSnap.effectiveWorkoutLabel);
  assert.equal(rt.recovery.band, snap.recovery.value.band);
  assert.equal(rt.recovery.band, fromSnap.recoveryBand);
});

// ── Requirement #2: realtime rejects yesterday's brief as "current" ──────────
test("realtime projection treats a brief generated yesterday as NOT current (no stale 'this morning')", async () => {
  const snap = await buildFixtureSnapshot(); // localDate = 2026-06-11 in ET
  const yesterdayBrief = {
    generated_at: '2026-06-10T13:00:00.000Z', // the day before, ET
    content: { chiefBrief: { synthesis: 'Yesterday synthesis', action: 'Yesterday action', risk: 'Yesterday risk' } },
  };
  const rt = realtimeTodayContext(snap, yesterdayBrief);
  assert.equal(rt.briefIsCurrent, false);
  assert.equal(rt.synthesis, null, 'must NOT surface a stale brief as today');
  assert.equal(rt.action, null);
  assert.equal(rt.risk, null);
  // But the effective workout + recovery ARE current (recomputed live), so they
  // still come through.
  assert.equal(rt.workout.type, 'Mobility');
  assert.equal(rt.recovery.band, 'red');
});

test("realtime projection DOES surface a brief generated today", async () => {
  const snap = await buildFixtureSnapshot();
  const todayBrief = {
    generated_at: '2026-06-11T11:00:00.000Z', // same ET day as ASOF
    content: { chiefBrief: { synthesis: 'Today synthesis', action: 'Today action', risk: 'Today risk' } },
  };
  const rt = realtimeTodayContext(snap, todayBrief);
  assert.equal(rt.briefIsCurrent, true);
  assert.equal(rt.synthesis, 'Today synthesis');
});

// Harden pass, item 2: realtime voice previously explicitly disabled
// resolvedContext (buildBrainSnapshot's include.resolvedContext: false) —
// this proves the compact projection now reaches the SAME voice-facing
// realtimeTodayContext() every other field above comes from.
test('realtime projection includes a compact resolvedContext summary when the snapshot carries one', async () => {
  const { buildResolvedContext } = require('../src/intelligence/context-resolver');
  const withContext = buildResolvedContext({
    assertions: [{ id: 'a1', predicate: 'drank', objectValue: 'wine', rawText: 'drank wine', eventStatus: 'occurred', domains: ['health'], retiredAt: null, recordedAt: ASOF.toISOString() }],
    relations: [], tz: TZ, now: ASOF,
  });
  const snap = await buildFixtureSnapshot();
  const rt = realtimeTodayContext({ ...snap, resolvedContext: { value: withContext } }, null);
  assert.equal(rt.resolvedContext, '- drank wine');
});

test('realtime projection resolvedContext is null (not a crash) when the snapshot has nothing relevant', async () => {
  const snap = await buildFixtureSnapshot(); // stubbed RESOLVED_CONTEXT has no assertions
  const rt = realtimeTodayContext(snap, null);
  assert.equal(rt.resolvedContext, null);
});

// ── Requirement #9: deterministic under an injected TZ ≠ process TZ ───────────
test('snapshot localDate is computed from the injected timezone, not process.env.TZ', async () => {
  const savedTz = process.env.TZ;
  try {
    // Force a wildly different process TZ; the injected `tz` must still win.
    process.env.TZ = 'Asia/Tokyo';
    const snap = await buildBrainSnapshot({ asOf: ASOF, tz: TZ, recovery: RECOVERY });
    // 2026-06-11T14:30Z is still June 11 in America/New_York (10:30 EDT) —
    // and would be June 11 in Tokyo too, so use a boundary instant to prove it.
    assert.equal(snap.localDate, '2026-06-11');
    assert.equal(snap.timezone, TZ);

    // A late-ET-evening instant that is ALREADY the next day in UTC/Tokyo:
    const lateEt = new Date('2026-06-12T03:30:00.000Z'); // 11:30pm ET Jun 11; 12:30pm Tokyo Jun 12
    const snap2 = await buildBrainSnapshot({ asOf: lateEt, tz: TZ, recovery: RECOVERY });
    assert.equal(snap2.localDate, '2026-06-11', 'must bucket on the ET local day, not the Tokyo/UTC day');
  } finally {
    process.env.TZ = savedTz;
  }
});

test('fact() wrapper marks present values fresh and absent values unavailable', () => {
  assert.equal(fact('x', { source: 's' }).freshness, 'fresh');
  assert.equal(fact(null, { source: 's' }).freshness, 'unavailable');
  assert.equal(fact([], { source: 's' }).freshness, 'unavailable');
});
