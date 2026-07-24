// Two linked production bugs, one structural fix — see the module headers
// in intelligence/context-compiler.js (resolveTemporalWindow),
// intelligence/context-resolver.js (isForwardEpisodic/isTemporallyEligible,
// matchCalendarClassifications date-scoping + stable-identity priority 0),
// intelligence/calendar-block-identity.js, and routes/annotations.js
// (question-time provenance + fail-closed identity-bearing answers).
//
//   1. "A 25-hour fast starting tonight through tomorrow" kept reading as
//      CURRENT after it ended — an episodic (future/ongoing) assertion with
//      no establishable end resolved to effectiveEnd: null, which the old
//      isTemporallyEligible treated as "always current."
//   2. "It's a Sabbath block, not meetings" never durably reclassified the
//      titleless work-busy block it described — matchCalendarClassifications
//      had no reliable way to bind a classification to a block with no
//      title and no clock range restated in the answer, and no date gate at
//      all (a stale classification could silently reapply to a DIFFERENT
//      day's block at the same clock time).
//
// Real Postgres throughout; the LLM extraction call is mocked with the exact
// structured output a real Structured-Outputs call would plausibly return
// (same established pattern as context-understanding-scenarios.test.js) —
// no real Anthropic API access in this environment. Fixed clocks,
// America/New_York, for every date-sensitive assertion.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const { withTransaction } = require('../../src/db');
const contextAssertionsStore = require('../../src/store/contextAssertions');
const dayJournalStore = require('../../src/store/dayJournal');
const { compileUserContext, persistCompiledContext } = require('../../src/intelligence/context-compiler');
const { recordUserContext } = require('../../src/intelligence/context-input');
const {
  resolveContext, buildResolvedContext, isTemporallyEligible, summarizeResolvedContext, matchCalendarClassifications,
} = require('../../src/intelligence/context-resolver');
const { computeCalendarLoad } = require('../../src/intelligence/calendar-load');
const { calendarBlockId } = require('../../src/intelligence/calendar-block-identity');
const { validateClaims } = require('../../src/brain/claimValidator');
const { reconstructEffectiveEnd } = require('../../src/intelligence/episodic-repair');
const preBriefSignals = require('../../src/intelligence/pre-brief-signals');

const app = buildTestApp();
const TZ = 'America/New_York';
const ORIGINAL_GENERATE_TEXT = llm.generateText;
const TEST_MARKER = `ctx-lifecycle-${Date.now()}`;

function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
}
function mockCompile(assertions) {
  llm.generateText = async () => chiefMeta(JSON.stringify({ assertions }));
}
function mockCompileThrows(message = 'simulated compiler outage') {
  llm.generateText = async () => { throw new Error(message); };
}

afterEach(async () => {
  llm.generateText = ORIGINAL_GENERATE_TEXT;
  await db.query(`DELETE FROM context_relations WHERE source_assertion_id IN (SELECT id FROM context_assertions WHERE raw_text LIKE $1)`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM context_assertions WHERE raw_text LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM annotations WHERE label LIKE $1 OR note LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM day_journal WHERE text LIKE $1`, [`%${TEST_MARKER}%`]);
});
after(async () => { await closeDb(); });

// ── Scenario 1 — fixed-clock episodic lifecycle ─────────────────────────────
test('scenario 1 — a 25-hour fast submitted Wednesday evening is current before/through its window and gone by Friday', async () => {
  const WED_EVENING = new Date('2026-07-22T23:00:00Z'); // 7pm ET Wed
  const rawText = `${TEST_MARKER} 25 hour fast starting tonight through tomorrow`;

  mockCompile([{
    assertionType: 'plan', subject: 'user', predicate: 'is fasting', objectValue: 'for 25 hours',
    concepts: ['fasting'], domains: ['health'], eventStatus: 'planned', temporalRef: 'future',
    explicitDate: '', correctsPriorText: '', evidenceSpan: rawText, confidence: 0.9,
    durationHours: 25, explicitEndDate: '', polarity: 'neutral',
  }]);

  const compiled = await compileUserContext({ rawText, source: 'briefing_context', tz: TZ, now: WED_EVENING, recentActiveAssertions: [] });
  assert.equal(compiled.failed, false);
  assert.equal(compiled.assertions.length, 1);
  const fastAssertion = compiled.assertions[0];
  assert.ok(fastAssertion.effectiveEnd, 'a stated 25h duration must resolve to a REAL bounded end, not null');
  const spanHours = (new Date(fastAssertion.effectiveEnd).getTime() - new Date(fastAssertion.effectiveStart).getTime()) / 3600000;
  assert.equal(spanHours, 25, 'the bounded window must match the stated duration exactly');

  const persisted = await withTransaction((client) => persistCompiledContext(compiled, { db: (t, p) => client.query(t, p) }));
  assert.equal(persisted.assertionIds.length, 1);
  const stored = await contextAssertionsStore.getById(persisted.assertionIds[0]);
  assert.ok(stored, 'must be queryable back from real Postgres');

  // Wednesday evening (just submitted) — planned/current.
  assert.equal(isTemporallyEligible(stored, { asOf: WED_EVENING, tz: TZ }), true, 'Wednesday: current (just started)');

  // Thursday, during the fast — currently fasting.
  const THU_AFTERNOON = new Date('2026-07-23T18:00:00Z'); // 2pm ET Thu
  assert.equal(isTemporallyEligible(stored, { asOf: THU_AFTERNOON, tz: TZ }), true, 'Thursday: currently fasting');
  const resolvedThu = buildResolvedContext({ assertions: [stored], relations: [], tz: TZ, now: THU_AFTERNOON });
  const summaryThu = summarizeResolvedContext(resolvedThu, { asOf: THU_AFTERNOON });
  assert.match(summaryThu, /fast/i, 'Thursday: the fast is still part of current context');
  assert.doesNotMatch(summaryThu, /starting tonight/i, 'Thursday wording must not restate it as starting Thursday night — it already started Wednesday');

  // Friday, after the fast ended — no current fasting claim at all.
  const FRI_MORNING = new Date('2026-07-24T15:00:00Z'); // 11am ET Fri
  assert.equal(isTemporallyEligible(stored, { asOf: FRI_MORNING, tz: TZ }), false, 'Friday: the fast has ended, no longer current');
  const resolvedFri = buildResolvedContext({ assertions: [stored], relations: [], tz: TZ, now: FRI_MORNING });
  assert.equal(summarizeResolvedContext(resolvedFri, { asOf: FRI_MORNING }), '', 'Friday: nothing in the compiled context claims the fast is current');

  // Downstream enforcement: a brief that STILL claims "you're fasting" on
  // Friday (e.g. from stale prompt context elsewhere) must be caught by the
  // shared claim validator using this SAME resolved context.
  const violations = validateClaims(
    [['synthesis', "You're fasting for 25 hours through a busy day, so keep it light."]],
    { resolvedContext: resolvedFri }
  );
  assert.ok(violations.some((v) => v.check === 'episodic_state_overclaim'),
    `expected episodic_state_overclaim, got: ${violations.map((v) => v.check).join(', ')}`);
  // Correctly-framed past tense is NOT flagged.
  const noViolation = validateClaims(
    [['synthesis', 'You were fasting for 25 hours yesterday into last night.']],
    { resolvedContext: resolvedFri }
  );
  assert.ok(!noViolation.some((v) => v.check === 'episodic_state_overclaim'));
});

// ── Scenario 2 — voice/push-to-talk path uses the identical compiler ───────
test('scenario 2 — the same fast submitted through the voice log_day_context path follows the identical compiler and lifecycle', async () => {
  const WED_EVENING = new Date('2026-07-22T23:05:00Z');
  const rawText = `${TEST_MARKER} voice: 25 hour fast starting tonight through tomorrow`;

  mockCompile([{
    assertionType: 'plan', subject: 'user', predicate: 'is fasting', objectValue: 'for 25 hours',
    concepts: ['fasting'], domains: ['health'], eventStatus: 'planned', temporalRef: 'future',
    explicitDate: '', correctsPriorText: '', evidenceSpan: rawText, confidence: 0.9,
    durationHours: 25, explicitEndDate: '', polarity: 'neutral',
  }]);

  const entryDate = WED_EVENING.toLocaleDateString('en-CA', { timeZone: TZ });
  // The EXACT same production entrypoint chat/executeAction.js's
  // log_day_context voice action calls — proves voice reaches the identical
  // compileUserContext -> resolveTemporalWindow pipeline as the typed
  // POST /briefing/context path in scenario 1, not a separate reimplementation.
  await recordUserContext({
    rawText, source: 'voice_day_context', tz: TZ, now: WED_EVENING,
    writeInTransaction: (client, dbFn) => dayJournalStore.create({ text: rawText, entryDate, source: 'voice' }, dbFn),
  });

  const active = await contextAssertionsStore.getActive({ recordedFrom: new Date(WED_EVENING.getTime() - 60000) });
  const stored = active.find((a) => (a.rawText || '').includes(TEST_MARKER) && a.source === 'voice_day_context');
  assert.ok(stored, 'the voice-sourced assertion must be persisted identically to the typed path');
  const spanHours = (new Date(stored.effectiveEnd).getTime() - new Date(stored.effectiveStart).getTime()) / 3600000;
  assert.equal(spanHours, 25, 'voice path must apply the SAME bounded-duration lifecycle resolution');

  const FRI_MORNING = new Date('2026-07-24T15:05:00Z');
  assert.equal(isTemporallyEligible(stored, { asOf: FRI_MORNING, tz: TZ }), false, 'Friday: the voice-sourced fast is also no longer current');
});

// ── Scenarios 3, 5 — titleless block classified via stable identity, no title/clock range ──
test('scenario 3 & 5 — a titleless Friday work-busy block is durably classified as Sabbath via stable identity alone (no title, no clock range in the answer), and only after a real semantic write', async () => {
  const FRI = '2026-07-31'; // arbitrary but fixed Friday
  const start = '9:00 AM', end = '6:00 PM';
  const id = calendarBlockId({ source: 'work_busy', date: FRI, start, end });
  const workBusy = [{ start, end, date: FRI, id }];

  mockCompile([{
    assertionType: 'classification', subject: `${TEST_MARKER} Friday's work block`, predicate: 'is',
    objectValue: 'a Sabbath observance, not meetings', concepts: ['sabbath_block'], domains: ['calendar'],
    eventStatus: 'occurred', temporalRef: 'unspecified', explicitDate: '', correctsPriorText: '',
    evidenceSpan: `${TEST_MARKER} it's a Sabbath block, not meetings`, confidence: 0.9,
    durationHours: 0, explicitEndDate: '', polarity: 'neutral',
  }]);

  // The answer text itself carries NEITHER a title NOR a clock range — only
  // the block metadata (echoed by the client, per the question-time
  // provenance contract) identifies which block this describes.
  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: "Friday's work calendar is heavily blocked (9.0h) — anything specific driving it?",
    answer: `${TEST_MARKER} it's a Sabbath block, not meetings`,
    signalKey: `calendar_load:${FRI}`,
    fingerprint: '9.00',
    subjectLocalDate: FRI,
    blocks: [{ id, source: 'work_busy', date: FRI, start, end }],
  });
  assert.equal(res.status, 200, `expected a durable semantic write to succeed: ${JSON.stringify(res.body)}`);

  // "Must not resolve successfully until the semantic write is durable" — a
  // completely FRESH read from Postgres (no process-local cache anywhere in
  // this path) proves it, exactly as a rebuild/restart/fresh client would see.
  const resolved = await resolveContext({ tz: TZ });
  const overrides = matchCalendarClassifications(resolved, { calendar: [], workBusy, targetLocalDate: FRI });
  assert.equal(overrides.length, 1, 'the classification must resolve to exactly the described block via stable identity');

  const load = computeCalendarLoad({ workBusy, calendar: [], classifiedOverrides: overrides });
  assert.equal(load.meetingHours, 0, "Friday's canonical meeting load must exclude the classified block entirely");
});

// ── Scenario 4 — identical semantic state through the pre-brief-signal path ──
test('scenario 4 — the pre-brief signal question path produces the identical semantic state as scenario 3', async () => {
  const FRI = '2026-08-14';
  const start = '10:00 AM', end = '7:00 PM'; // 9h, titleless
  const workBusy = [{ start, end, date: FRI, id: calendarBlockId({ source: 'work_busy', date: FRI, start, end }) }];

  // Generate the REAL signal (server-computed block provenance) rather than
  // hand-crafting it — proves the signal-generation and answer-handling
  // sides of the contract actually agree with each other.
  const now = new Date(`${FRI}T12:00:00Z`);
  const dayBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const signals = preBriefSignals.buildSignals({
    recovery: null, calendar: [], workBusy: [], tomorrowWorkBusy: workBusy, tomorrowCalendar: [],
    tz: TZ, now: dayBefore,
  });
  const signal = signals.find((s) => s.key === `calendar_load:${FRI}`);
  assert.ok(signal, 'the tomorrow-look-ahead signal must fire for a 9h titleless block');
  assert.equal(signal.subjectLocalDate, FRI);
  assert.equal(signal.blocks.length, 1);
  assert.equal(signal.blocks[0].id, workBusy[0].id);

  mockCompile([{
    assertionType: 'classification', subject: `${TEST_MARKER} the block ${signal.blocks[0].id}`, predicate: 'is',
    objectValue: 'a Sabbath observance, not meetings', concepts: ['sabbath_block'], domains: ['calendar'],
    eventStatus: 'occurred', temporalRef: 'unspecified', explicitDate: '', correctsPriorText: '',
    evidenceSpan: `${TEST_MARKER} it's a Sabbath block, not meetings`, confidence: 0.9,
    durationHours: 0, explicitEndDate: '', polarity: 'neutral',
  }]);

  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: signal.question, answer: `${TEST_MARKER} it's a Sabbath block, not meetings`,
    signalKey: signal.key, fingerprint: signal.fingerprint,
    subjectLocalDate: signal.subjectLocalDate, blocks: signal.blocks,
  });
  assert.equal(res.status, 200);

  const resolved = await resolveContext({ tz: TZ });
  const overrides = matchCalendarClassifications(resolved, { calendar: [], workBusy, targetLocalDate: FRI });
  assert.equal(overrides.length, 1, 'the pre-brief-signal path must resolve to the same excluded-block state as the direct route call');
  const load = computeCalendarLoad({ workBusy, calendar: [], classifiedOverrides: overrides });
  assert.equal(load.meetingHours, 0);
});

// ── Scenario 6 — the same clock window next week is unaffected ─────────────
test('scenario 6 — a block at the same clock time the FOLLOWING week is not classified by this week\'s correction', async () => {
  const THIS_FRI = '2026-09-04';
  const NEXT_FRI = '2026-09-11';
  const start = '9:00 AM', end = '6:00 PM';
  const thisWeekBlock = { start, end, date: THIS_FRI, id: calendarBlockId({ source: 'work_busy', date: THIS_FRI, start, end }) };
  const nextWeekBlock = { start, end, date: NEXT_FRI, id: calendarBlockId({ source: 'work_busy', date: NEXT_FRI, start, end }) };
  assert.notEqual(thisWeekBlock.id, nextWeekBlock.id, 'sanity: different dates must produce different stable ids');

  mockCompile([{
    assertionType: 'classification', subject: `${TEST_MARKER} this week's Friday block`, predicate: 'is',
    objectValue: 'a Sabbath observance, not meetings', concepts: ['sabbath_block'], domains: ['calendar'],
    eventStatus: 'occurred', temporalRef: 'unspecified', explicitDate: '', correctsPriorText: '',
    evidenceSpan: `${TEST_MARKER} it's a Sabbath block, not meetings`, confidence: 0.9,
    durationHours: 0, explicitEndDate: '', polarity: 'neutral',
  }]);
  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: "This Friday's work calendar is heavily blocked (9.0h) — anything specific driving it?",
    answer: `${TEST_MARKER} it's a Sabbath block, not meetings`,
    signalKey: `calendar_load:${THIS_FRI}`, fingerprint: '9.00',
    subjectLocalDate: THIS_FRI, blocks: [thisWeekBlock],
  });
  assert.equal(res.status, 200);

  const resolved = await resolveContext({ tz: TZ });

  // THIS week's Friday: excluded, as expected.
  const overridesThisWeek = matchCalendarClassifications(resolved, { calendar: [], workBusy: [thisWeekBlock], targetLocalDate: THIS_FRI });
  assert.equal(overridesThisWeek.length, 1);

  // NEXT week's Friday, same clock window, different date: must NOT inherit
  // the classification — this is the exact cross-week leakage the date gate
  // (and the stable identity's own encoded date) both close.
  const overridesNextWeek = matchCalendarClassifications(resolved, { calendar: [], workBusy: [nextWeekBlock], targetLocalDate: NEXT_FRI });
  assert.equal(overridesNextWeek.length, 0, 'next week\'s block at the same clock time must remain unclassified');
  const loadNextWeek = computeCalendarLoad({ workBusy: [nextWeekBlock], calendar: [], classifiedOverrides: overridesNextWeek });
  assert.equal(loadNextWeek.meetingHours, 9, 'next week\'s genuinely real 9h block must still count as meeting load');
});

// ── Scenario 7 — compiler failure must not report false success ────────────
test('scenario 7 — a context-compiler outage on an identity-bearing calendar-load answer returns a recoverable error, never a false 200', async () => {
  const FRI = '2026-10-02';
  const start = '9:00 AM', end = '6:00 PM';
  const block = { id: calendarBlockId({ source: 'work_busy', date: FRI, start, end }), source: 'work_busy', date: FRI, start, end };

  mockCompileThrows('simulated Anthropic outage');

  const before = await db.query(`SELECT count(*)::int AS n FROM context_assertions WHERE raw_text LIKE $1`, [`%${TEST_MARKER}%`]);
  const beforeAnnotations = await db.query(`SELECT count(*)::int AS n FROM annotations WHERE label LIKE $1`, [`%${TEST_MARKER}%`]);

  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: "Friday's work calendar is heavily blocked (9.0h) — anything specific driving it?",
    answer: `${TEST_MARKER} it's a Sabbath block, not meetings`,
    signalKey: `calendar_load:${FRI}`, fingerprint: '9.00',
    subjectLocalDate: FRI, blocks: [block],
  });

  assert.notEqual(res.status, 200, 'must never report success while the semantic write was never understood');
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'context_compilation_failed');

  // Nothing partial was persisted — no orphaned annotation with no
  // structured assertion behind it, satisfying "either persist a valid
  // subject-bound semantic result, or return a recoverable error."
  const after = await db.query(`SELECT count(*)::int AS n FROM context_assertions WHERE raw_text LIKE $1`, [`%${TEST_MARKER}%`]);
  const afterAnnotations = await db.query(`SELECT count(*)::int AS n FROM annotations WHERE label LIKE $1`, [`%${TEST_MARKER}%`]);
  assert.equal(after.rows[0].n, before.rows[0].n, 'no context_assertions row was left behind');
  assert.equal(afterAnnotations.rows[0].n, beforeAnnotations.rows[0].n, 'no annotation row was left behind either — nothing partial');
});

// A plain, non-identity-bearing note must be COMPLETELY unaffected by the
// fail-closed behavior above — the raw note is never lost just because
// structured extraction didn't fire (the original, pre-existing contract).
test('scenario 7b — a compiler outage on an ORDINARY note still saves the raw annotation (fail-closed is scoped to identity-bearing questions only)', async () => {
  mockCompileThrows('simulated Anthropic outage');
  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({
    answer: `${TEST_MARKER} just a plain day-context note with no signal at all`,
  });
  assert.equal(res.status, 200, 'an ordinary note must still save even when structured extraction fails');
  const row = await db.query(`SELECT count(*)::int AS n FROM annotations WHERE label LIKE $1`, [`%${TEST_MARKER}%`]);
  assert.equal(row.rows[0].n, 1);
});

// ── Scenario 8 — unrelated meetings remain counted ──────────────────────────
test('scenario 8 — reclassifying the Sabbath block leaves a genuinely separate real meeting fully counted', async () => {
  const FRI = '2026-10-09';
  const sabbathStart = '5:00 PM', sabbathEnd = '9:00 PM';
  const realStart = '9:00 AM', realEnd = '11:00 AM'; // a genuinely separate 2h meeting
  const sabbathBlock = { start: sabbathStart, end: sabbathEnd, date: FRI, id: calendarBlockId({ source: 'work_busy', date: FRI, start: sabbathStart, end: sabbathEnd }) };
  const realMeetingBlock = { start: realStart, end: realEnd, date: FRI, id: calendarBlockId({ source: 'work_busy', date: FRI, start: realStart, end: realEnd }) };

  mockCompile([{
    assertionType: 'classification', subject: `${TEST_MARKER} Friday evening block`, predicate: 'is',
    objectValue: 'a Sabbath observance, not meetings', concepts: ['sabbath_block'], domains: ['calendar'],
    eventStatus: 'occurred', temporalRef: 'unspecified', explicitDate: '', correctsPriorText: '',
    evidenceSpan: `${TEST_MARKER} it's a Sabbath block, not meetings`, confidence: 0.9,
    durationHours: 0, explicitEndDate: '', polarity: 'neutral',
  }]);
  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: "Friday's work calendar is heavily blocked (6.0h) — anything specific driving it?",
    answer: `${TEST_MARKER} it's a Sabbath block, not meetings`,
    signalKey: `calendar_load:${FRI}`, fingerprint: '6.00',
    subjectLocalDate: FRI, blocks: [sabbathBlock],
  });
  assert.equal(res.status, 200);

  const resolved = await resolveContext({ tz: TZ });
  const workBusy = [sabbathBlock, realMeetingBlock];
  const overrides = matchCalendarClassifications(resolved, { calendar: [], workBusy, targetLocalDate: FRI });
  assert.equal(overrides.length, 1, 'only the classified block resolves, not both');
  const load = computeCalendarLoad({ workBusy, calendar: [], classifiedOverrides: overrides });
  assert.equal(load.meetingHours, 2, 'the unrelated real 2h meeting must remain fully counted, neither dropped nor double-subtracted');
});

// ── Scenario 9 — production-data repair ─────────────────────────────────────
test('scenario 9 — an existing pre-fix unbounded fast assertion no longer appears current once repaired from its own text', async () => {
  const RECORDED = new Date('2026-11-04T23:00:00Z'); // 7pm ET Wed — simulates a row compiled BEFORE the lifecycle fix
  const rawText = `${TEST_MARKER} 25 hour fast starting tonight`;

  // Simulate a genuine pre-fix row: a forward-episodic assertion with a real
  // effectiveStart but NO effectiveEnd (exactly what the old
  // resolveTemporalWindow produced for temporalRef 'future' with a stated
  // duration the OLD code never extracted).
  const id = await contextAssertionsStore.create({
    source: 'briefing_context', rawText, assertionType: 'plan', subject: 'user',
    predicate: 'is fasting', objectValue: 'for 25 hours', domains: ['health'], concepts: ['fasting'],
    eventStatus: 'planned', effectiveStart: RECORDED, effectiveEnd: null,
    confidence: 0.9, sourceAuthority: 'user', compilerVersion: '0.9.0-pre-fix',
  });
  const before = await contextAssertionsStore.getById(id);
  assert.equal(before.effectiveEnd, null, 'sanity: reproduces the pre-fix unbounded row');
  // Even before repair, the runtime lifecycle fix ALREADY excludes it from
  // "current" days later — the repair only recovers a real bound, it is not
  // what makes exclusion safe.
  const FRI_MUCH_LATER = new Date('2026-11-07T15:00:00Z');
  assert.equal(isTemporallyEligible(before, { asOf: FRI_MUCH_LATER, tz: TZ }), false, 'even unrepaired, an unbounded forward-episodic row is excluded from current projections');

  // Run the SAME reconstruction the one-time repair script applies.
  const reconstructedEnd = reconstructEffectiveEnd({ rawText: before.rawText, effectiveStart: before.effectiveStart, recordedAt: before.recordedAt, tz: TZ });
  assert.ok(reconstructedEnd, 'the stated 25-hour duration must be reconstructable from raw_text + recorded_at alone');
  await db.query(`UPDATE context_assertions SET effective_end = $1 WHERE id = $2`, [reconstructedEnd.toISOString(), id]);

  const after = await contextAssertionsStore.getById(id);
  assert.ok(after.effectiveEnd, 'effective_end is now set');
  const spanHours = (new Date(after.effectiveEnd).getTime() - new Date(after.effectiveStart).getTime()) / 3600000;
  assert.equal(spanHours, 25);

  // During the reconstructed window: still current.
  const THU_DURING = new Date('2026-11-05T18:00:00Z');
  assert.equal(isTemporallyEligible(after, { asOf: THU_DURING, tz: TZ }), true, 'during the reconstructed window: current');
  // After the reconstructed window: no longer current — the repair recovered
  // a REAL bound instead of the row staying excluded forever with no chance
  // of ever having been shown as current during its true window.
  assert.equal(isTemporallyEligible(after, { asOf: FRI_MUCH_LATER, tz: TZ }), false, 'after the reconstructed window: excluded again, correctly this time');
});
