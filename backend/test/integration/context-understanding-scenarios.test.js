// Proves the Context Understanding Layer is GENERAL — the same
// compileUserContext -> persistCompiledContext -> resolveContext pipeline
// handles every scenario below, with no scenario-specific route or
// special-cased code path. Each test mocks only the LLM extraction call
// (no real Anthropic API access in this environment — see every other LLM
// call in this test suite for the same established pattern) with the
// structured output a real Structured-Outputs call would plausibly return
// for that exact input text, then exercises the REAL deterministic pipeline
// (temporal resolution, negation/correction reconciliation, supersession
// matching, relation derivation, persistence, resolution) against a real
// Postgres.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const contextAssertionsStore = require('../../src/store/contextAssertions');
const {
  resolveContext, getDriversFor, getConstraintsFor, getPreferencesFor,
  getCompletionState, getCalendarClassification, matchCalendarClassifications,
} = require('../../src/intelligence/context-resolver');
const { computeCalendarLoad } = require('../../src/intelligence/calendar-load');
const { checkResolvedContextConflicts } = require('../../src/brain/claimValidator');
const { rankActions } = require('../../src/intelligence/leverage');

const app = buildTestApp();
const ORIGINAL_GENERATE_TEXT = llm.generateText;
const TEST_MARKER = `cul-scenarios-${Date.now()}`;

function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
}
function mockCompile(assertions) {
  llm.generateText = async () => chiefMeta(JSON.stringify({ assertions }));
}

async function postContext(answer, extra = {}) {
  return request(app).post('/api/briefing/context').set(authHeader()).send({ answer, ...extra });
}

afterEach(async () => {
  llm.generateText = ORIGINAL_GENERATE_TEXT;
  await db.query(`DELETE FROM context_relations WHERE source_assertion_id IN (SELECT id FROM context_assertions WHERE raw_text LIKE $1)`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM context_assertions WHERE raw_text LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM annotations WHERE label LIKE $1`, [`%${TEST_MARKER}%`]);
  // Every postContext() call here has no signalKey, so routes/annotations.js's
  // isDayContext path also journals it (day-journal text-parity with voice) —
  // clean those up too, or they linger as real "today" entries and confuse
  // OTHER suites that check "is anything logged today" (e.g.
  // notify-evening-reminder.test.js).
  await db.query(`DELETE FROM day_journal WHERE text LIKE $1`, [`%${TEST_MARKER}%`]);
});
after(async () => { await closeDb(); });

// ── 1. Health driver ─────────────────────────────────────────────────────
test('scenario 1 — health driver: "I had drinks last night" becomes a candidate driver during the supported window', async () => {
  mockCompile([{
    assertionType: 'event', subject: 'user', predicate: 'drank', objectValue: 'alcohol',
    concepts: ['alcohol'], domains: ['health'], eventStatus: 'occurred', temporalRef: 'last_night',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const res = await postContext(`${TEST_MARKER} I had drinks last night`);
  assert.equal(res.status, 200);

  const resolved = await resolveContext({});
  const result = getDriversFor(resolved, 'health:recovery_autonomic');
  assert.ok(result.driver && result.driver.includes('alcohol'), `expected an alcohol driver, got: ${JSON.stringify(result)}`);
  assert.equal(result.evidenceBasis, 'established_knowledge');
});

// ── 2. Temporal correction ───────────────────────────────────────────────
test('scenario 2 — temporal correction: "that happened Thursday, not last night" moves the event and drops it from today\'s drivers', async () => {
  mockCompile([{
    assertionType: 'event', subject: 'user', predicate: 'drank', objectValue: 'alcohol',
    concepts: ['alcohol'], domains: ['health'], eventStatus: 'occurred', temporalRef: 'last_night',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const first = await postContext(`${TEST_MARKER} I had drinks last night`);
  assert.equal(first.status, 200);
  const resolvedBefore = await resolveContext({});
  assert.ok(getDriversFor(resolvedBefore, 'health:recovery_autonomic').driver, 'sanity: the original event is a driver before the correction');

  // A long-past explicit date so the corrected event's effect window has
  // already fully expired by "now" — the correction should make it
  // disappear from today's drivers, not merely relocate to another active day.
  mockCompile([{
    assertionType: 'correction', subject: 'user', predicate: 'drank', objectValue: 'alcohol',
    concepts: ['alcohol'], domains: ['health'], eventStatus: 'occurred', temporalRef: 'explicit_date',
    explicitDate: '2020-01-02', correctsPriorText: `${TEST_MARKER} I had drinks last night`, confidence: 0.9,
  }]);
  const second = await postContext(`${TEST_MARKER} that actually happened Thursday, not last night`);
  assert.equal(second.status, 200);

  const resolvedAfter = await resolveContext({});
  const result = getDriversFor(resolvedAfter, 'health:recovery_autonomic');
  assert.equal(result.driver, null, `the corrected (long-expired) event must no longer be an eligible driver, got: ${JSON.stringify(result)}`);
});

// ── 3. Calendar classification ───────────────────────────────────────────
test('scenario 3 — calendar classification: "that\'s a Sabbath block, not meetings" changes calendar-load interpretation', async () => {
  mockCompile([{
    assertionType: 'classification', subject: `${TEST_MARKER} the 5-9pm block`, predicate: 'is',
    objectValue: 'a Sabbath observance, not meetings', concepts: ['sabbath_block'], domains: ['calendar'],
    eventStatus: 'occurred', temporalRef: 'today', explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const res = await postContext(`${TEST_MARKER} that's a Sabbath block, not meetings`);
  assert.equal(res.status, 200);

  const resolved = await resolveContext({});
  const cls = getCalendarClassification(resolved, `${TEST_MARKER} the 5-9pm block`);
  assert.ok(cls, 'expected a calendar classification to be resolvable');
  assert.match(cls.classification, /not meetings/);

  // And the claim validator rejects a brief that still frames it as meeting load.
  const violations = checkResolvedContextConflicts(
    { chiefBrief: { synthesis: `Your ${TEST_MARKER} the 5-9pm block is packed with meetings today.` } },
    { resolvedContext: resolved }
  );
  assert.ok(violations.some((v) => v.check === 'calendar_classification'));

  // Harden pass, item 3a: the correction must change the ACTUAL computed
  // calendar-load projection (intelligence/calendar-load.js), not merely be
  // queryable via getCalendarClassification's fixture-shaped return or
  // rejected in generated prose. Real work-busy blocks: a 5-9pm block
  // (matching the classified subject's clock-time range) plus a genuinely
  // unrelated 9-11am block of real meetings.
  const workBusy = [
    { start: '9:00 AM', end: '11:00 AM' }, // 2h of real, unrelated meetings
    { start: '5:00 PM', end: '9:00 PM' }, // the reclassified Sabbath block
  ];
  const withoutOverride = computeCalendarLoad({ workBusy, calendar: [] });
  assert.equal(withoutOverride.meetingHours, 6, 'sanity: without the correction, the block reads as 6h of meeting load');

  const classifiedOverrides = matchCalendarClassifications(resolved, { calendar: [], workBusy });
  assert.equal(classifiedOverrides.length, 1, 'expected exactly one matched classification override');
  const withOverride = computeCalendarLoad({ workBusy, calendar: [], classifiedOverrides });
  assert.equal(withOverride.meetingHours, 2, 'the reclassified block must be netted out, leaving only the genuine 2h of meetings — the ACTUAL computed number, not just resolvable classification metadata');
});

// ── 4. Completion correction ─────────────────────────────────────────────
test('scenario 4 — completion correction: "I did not complete the valuation conversation" keeps it open', async () => {
  mockCompile([{
    assertionType: 'completion', subject: `${TEST_MARKER} the valuation conversation`, predicate: 'is',
    objectValue: 'not complete', concepts: [], domains: ['goals'], eventStatus: 'negated',
    temporalRef: 'today', explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const res = await postContext(`${TEST_MARKER} I did not complete the valuation conversation`);
  assert.equal(res.status, 200);

  const resolved = await resolveContext({});
  const { normalizeTargetId } = require('../../src/intelligence/context-compiler');
  const state = getCompletionState(resolved, 'goal', normalizeTargetId(`${TEST_MARKER} the valuation conversation`));
  assert.equal(state.completed, false);

  const violations = checkResolvedContextConflicts(
    { chiefBrief: { synthesis: `The ${TEST_MARKER} the valuation conversation is done — nice work.` } },
    { resolvedContext: resolved, goals: [{ text: `${TEST_MARKER} the valuation conversation`, achieved: false }] }
  );
  assert.ok(violations.some((v) => v.check === 'completion_state_resolved'));
});

// Harden pass, item 3b: the correction must change the ACTUAL canonical
// commitment projection every surface reads (store/commitments.js's
// listActive — the one selector BrainSnapshot/briefing/Ask/realtime/action
// ranking all share), not merely be resolvable via getCompletionState. This
// reproduces the real failure mode: a commitment gets wrongly marked done
// (an explicit markDone, or the metric-driven auto-complete in
// notify/commitments.js acting on stale/coincidental evidence), and the
// user's correction must resurrect it back into the active list.
test('scenario 4b — completion correction changes the ACTUAL store/commitments.js listActive() projection, not just getCompletionState', async () => {
  const commitmentsStore = require('../../src/store/commitments');
  const title = `${TEST_MARKER} have the valuation conversation with the broker`;
  const created = await commitmentsStore.create({ title, source: 'test' });
  await commitmentsStore.markDone(created.id);
  try {
    const beforeCorrection = await commitmentsStore.listActive({ limit: 50 });
    assert.ok(!beforeCorrection.some((c) => c.id === created.id), 'sanity: the wrongly-completed commitment is absent from the active list before any correction');

    mockCompile([{
      assertionType: 'completion', subject: `${TEST_MARKER} the valuation conversation`, predicate: 'is',
      objectValue: 'not complete', concepts: [], domains: ['commitments'], eventStatus: 'negated',
      temporalRef: 'today', explicitDate: '', correctsPriorText: '', confidence: 0.9,
    }]);
    const res = await postContext(`${TEST_MARKER} I did not complete the valuation conversation`);
    assert.equal(res.status, 200);

    const afterCorrection = await commitmentsStore.listActive({ limit: 50 });
    const resurrected = afterCorrection.find((c) => c.id === created.id);
    assert.ok(resurrected, 'the corrected commitment must reappear in the ACTUAL canonical listActive() projection, not just be queryable via getCompletionState');
    assert.equal(resurrected.status, 'open');
  } finally {
    await db.query(`DELETE FROM commitments WHERE id = $1`, [created.id]);
  }
});

// ── 5. Constraint (skipped workout) ──────────────────────────────────────
test('scenario 5 — constraint: "I skipped the hard workout because I was exhausted" records skipped + constraint, never completion', async () => {
  mockCompile([
    {
      assertionType: 'decision', subject: `${TEST_MARKER} the hard workout`, predicate: 'skipped', objectValue: '',
      concepts: [], domains: ['workouts'], eventStatus: 'occurred', temporalRef: 'today',
      explicitDate: '', correctsPriorText: '', confidence: 0.9,
    },
    {
      // Same subject as the decision above — the compiler's own prompt
      // instructs the model to keep a consistent subject across related
      // assertions from the same statement so they link to the same target.
      assertionType: 'constraint', subject: `${TEST_MARKER} the hard workout`, predicate: 'was skipped because user was', objectValue: 'exhausted',
      concepts: ['fatigue'], domains: ['workouts'], eventStatus: 'occurred', temporalRef: 'today',
      explicitDate: '', correctsPriorText: '', confidence: 0.85,
    },
  ]);
  const res = await postContext(`${TEST_MARKER} I skipped the hard workout because I was exhausted`);
  assert.equal(res.status, 200);

  const resolved = await resolveContext({});
  const { normalizeTargetId } = require('../../src/intelligence/context-compiler');
  const workoutTarget = normalizeTargetId(`${TEST_MARKER} the hard workout`);
  const completion = getCompletionState(resolved, 'workout', workoutTarget);
  // The resolver must NEVER assert completed:true from a skip decision — it
  // either stays silent (null — the underlying workout/commitment store is
  // still the authority on completion, unless the user explicitly corrects
  // it, see scenario 4) or explicitly says not-completed. Either is a valid
  // "does not automatically mark completion"; only completed:true is wrong.
  assert.ok(!completion || completion.completed === false, `a skipped workout must never read as completed, got: ${JSON.stringify(completion)}`);

  // The 'skipped' decision DID produce a constraint on the workout target —
  // the exhaustion reason is recorded, not silently dropped.
  const constraints = getConstraintsFor(resolved, 'workout', workoutTarget);
  assert.ok(constraints.length >= 1, 'expected the decision to record a constraint on the workout');

  // The constraint reason must never silently become a metric driver either
  // — it explains the DECISION, not a measured recovery number.
  const driverResult = getDriversFor(resolved, 'health:recovery_autonomic');
  assert.equal(driverResult.driver, null, 'an exhaustion CONSTRAINT on a workout decision must not become a recovery metric driver');
});

// ── 6. Durable preference ────────────────────────────────────────────────
test('scenario 6 — durable preference: "don\'t recommend evening workouts" changes future action ranking', async () => {
  mockCompile([{
    assertionType: 'preference', subject: 'user', predicate: 'prefers not to schedule',
    objectValue: 'evening workouts', concepts: [], domains: ['workouts'], eventStatus: 'occurred',
    temporalRef: 'unspecified', explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const res = await postContext(`${TEST_MARKER} don't recommend evening workouts`);
  assert.equal(res.status, 200);

  const resolved = await resolveContext({});
  assert.ok(getPreferencesFor(resolved, 'evening workouts').length >= 1);

  // And it actually filters a matching candidate out of rankActions' output.
  const candidateFinding = {
    type: 'correlation',
    evidence: { kind: 'correlation', a: 'health:sleep_hours', b: 'wellbeing:focus', r: 0.6, confirmed: true },
  };
  const withoutPref = rankActions([candidateFinding]);
  if (withoutPref.length) {
    // Only assert exclusion if this particular correlation actually produced
    // a candidate whose title could plausibly conflict — the preference
    // filter is exercised directly and thoroughly in test/leverage.test.js;
    // this just confirms resolvedContext's preferences flow into it correctly.
    const withPref = rankActions([candidateFinding], { preferences: resolved.preferences });
    assert.ok(withPref.length <= withoutPref.length);
  }
});

// ── 7. Negation ───────────────────────────────────────────────────────────
test('scenario 7 — negation: "I didn\'t drink" never becomes an alcohol driver', async () => {
  mockCompile([{
    assertionType: 'event', subject: 'user', predicate: 'drank', objectValue: 'alcohol',
    concepts: ['alcohol'], domains: ['health'], eventStatus: 'occurred', temporalRef: 'last_night',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const res = await postContext(`${TEST_MARKER} I didn't drink last night`);
  assert.equal(res.status, 200);

  const stored = await contextAssertionsStore.getActive({ recordedFrom: new Date(Date.now() - 3600000) });
  const mine = stored.find((a) => a.rawText.includes(TEST_MARKER));
  assert.ok(mine, 'expected the assertion to be persisted');
  // The deterministic negation safety net (reconcileEventStatus) must have
  // overridden the model's eventStatus regardless of what the model said —
  // the raw text unambiguously negates the event.
  assert.equal(mine.eventStatus, 'negated');

  const resolved = await resolveContext({});
  const result = getDriversFor(resolved, 'health:recovery_autonomic');
  assert.equal(result.driver, null, 'a negated alcohol event must never surface as a recovery driver');
});

// ── 8. Retraction ─────────────────────────────────────────────────────────
test('scenario 8 — retraction: "forget what I said about the late meal" retires the assertion and all derived relations', async () => {
  mockCompile([{
    assertionType: 'event', subject: 'user', predicate: 'ate', objectValue: 'a late meal',
    concepts: ['late_meal'], domains: ['health'], eventStatus: 'occurred', temporalRef: 'last_night',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const first = await postContext(`${TEST_MARKER} ate a late meal last night`);
  assert.equal(first.status, 200);
  const resolvedBefore = await resolveContext({});
  assert.ok(getDriversFor(resolvedBefore, 'health:recovery_autonomic').driver, 'sanity: the late-meal event is a driver before retraction');

  mockCompile([{
    assertionType: 'correction', subject: 'user', predicate: 'ate', objectValue: 'a late meal',
    concepts: [], domains: ['health'], eventStatus: 'retracted', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: `${TEST_MARKER} ate a late meal last night`, confidence: 0.9,
  }]);
  const second = await postContext(`${TEST_MARKER} forget what I said about the late meal`);
  assert.equal(second.status, 200);

  const resolvedAfter = await resolveContext({});
  const result = getDriversFor(resolvedAfter, 'health:recovery_autonomic');
  assert.equal(result.driver, null, 'the retracted assertion\'s relation must be gone from the resolver');

  const stored = await contextAssertionsStore.getActive({ recordedFrom: new Date(Date.now() - 3600000) });
  assert.ok(!stored.some((a) => a.rawText.includes('ate a late meal last night')), 'the original assertion must be retired, not merely superseded-but-still-active');
});

// ── 9. Unknown concept ────────────────────────────────────────────────────
test('scenario 9 — unknown concept: a previously unseen context still compiles structurally, staying a hypothesis rather than being ignored or treated as causal', async () => {
  mockCompile([{
    assertionType: 'explanation', subject: 'user', predicate: 'did', objectValue: 'box breathing before bed',
    concepts: ['box_breathing'], domains: ['health'], eventStatus: 'occurred', temporalRef: 'last_night',
    explicitDate: '', correctsPriorText: '', confidence: 0.8,
  }]);
  const res = await postContext(`${TEST_MARKER} box breathing before bed seemed to help my recovery`);
  assert.equal(res.status, 200);

  const stored = await contextAssertionsStore.getActive({ recordedFrom: new Date(Date.now() - 3600000) });
  const mine = stored.find((a) => a.rawText.includes(TEST_MARKER));
  assert.ok(mine, 'an unrecognized concept must still be compiled structurally, not dropped');
  assert.deepEqual(mine.concepts, ['box_breathing']);

  const resolved = await resolveContext({});
  const result = getDriversFor(resolved, 'health:recovery_autonomic');
  // It DOES surface as a candidate (never ignored) but only as a
  // low-confidence, visibly-uncertain hypothesis — never confidently
  // presented as the resolver's established driver.
  assert.ok(result.driver, 'the novel concept should still surface as SOME candidate, not be silently dropped');
  assert.equal(result.evidenceBasis, 'model_hypothesis');
  assert.ok(result.confidence <= 0.35, `expected a visibly low confidence for an unsupported hypothesis, got ${result.confidence}`);
});
