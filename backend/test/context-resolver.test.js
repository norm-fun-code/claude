// Pure unit coverage for intelligence/context-resolver.js — buildResolvedContext
// and every canonical selector, including the driver engine's scoring and
// the "no eligible driver" result. See
// test/integration/context-understanding.test.js for the real-Postgres,
// end-to-end scenario proofs.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildResolvedContext, getDriversFor, getConstraintsFor, getPreferencesFor, getCompletionState,
  getCalendarClassification, matchCalendarClassifications, extractClockTimeRange, matchCompletionCorrections,
  getResolvedUncertainties, getUnresolvedUncertainties, getRelevantContext, summarizeResolvedContext,
  isTemporallyEligible, isDurableAssertion, temporalAnchorSuffix,
  scoreRelation,
} = require('../src/intelligence/context-resolver');

const NOW = new Date('2026-07-17T15:00:00Z');

function assertion(overrides = {}) {
  return { id: 'a1', predicate: 'drank', objectValue: 'wine', rawText: 'drank wine last night', eventStatus: 'occurred', domains: ['health'], retiredAt: null, ...overrides };
}
function relation(overrides = {}) {
  return {
    id: 'r1', sourceAssertionId: 'a1', targetType: 'metric', targetId: 'health:recovery_autonomic',
    relationship: 'contributes_to', evidenceBasis: 'established_knowledge', confidence: 0.75, strength: 0.7,
    windowStart: NOW.toISOString(), windowEnd: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString(),
    permittedLanguage: 'is a likely contributor to', unresolved: false, resolvedAt: null, retiredAt: null,
    createdAt: NOW.toISOString(), ...overrides,
  };
}

// ── getDriversFor / driver engine ───────────────────────────────────────

test('getDriversFor: returns the single eligible driver with justified language and evidence basis', () => {
  const resolved = buildResolvedContext({ assertions: [assertion()], relations: [relation()], tz: 'America/New_York', now: NOW });
  const result = getDriversFor(resolved, 'health:recovery_autonomic', { now: NOW });
  assert.equal(result.driver, 'drank wine');
  assert.equal(result.evidenceBasis, 'established_knowledge');
  assert.equal(result.justifiedLanguage, 'is a likely contributor to');
  assert.equal(result.competingDrivers.length, 0);
});

test('getDriversFor: "no eligible driver" is a valid, explicit result — never substitutes an unrelated relation', () => {
  const resolved = buildResolvedContext({ assertions: [assertion()], relations: [relation()], tz: 'America/New_York', now: NOW });
  const result = getDriversFor(resolved, 'health:sleep_quality', { now: NOW });
  assert.equal(result.driver, null);
  assert.equal(result.reason, 'no_eligible_driver');
  assert.deepEqual(result.competingDrivers, []);
});

test('getDriversFor: a relation past its expiresAt never counts as a candidate (decay)', () => {
  const expired = relation({ id: 'r-old', expiresAt: new Date(NOW.getTime() - 3600 * 1000).toISOString() });
  const resolved = buildResolvedContext({ assertions: [assertion()], relations: [expired], tz: 'America/New_York', now: NOW });
  const result = getDriversFor(resolved, 'health:recovery_autonomic', { now: NOW });
  assert.equal(result.driver, null);
  assert.equal(result.reason, 'no_eligible_driver');
});

test('getDriversFor: two competing candidates rank by evidence tier + confidence, weaker one listed as competing', () => {
  const strong = assertion({ id: 'a-strong' });
  const weak = assertion({ id: 'a-weak', predicate: 'felt', objectValue: 'a bit off', rawText: 'felt a bit off' });
  const strongRel = relation({ sourceAssertionId: 'a-strong', evidenceBasis: 'established_knowledge', confidence: 0.8 });
  const weakRel = relation({ id: 'r-weak', sourceAssertionId: 'a-weak', evidenceBasis: 'model_hypothesis', confidence: 0.3, strength: 0.2, permittedLanguage: 'may be worth watching' });
  const resolved = buildResolvedContext({ assertions: [strong, weak], relations: [strongRel, weakRel], tz: 'America/New_York', now: NOW });
  const result = getDriversFor(resolved, 'health:recovery_autonomic', { now: NOW });
  assert.equal(result.evidenceBasis, 'established_knowledge');
  assert.equal(result.competingDrivers.length, 1);
  assert.equal(result.competingDrivers[0].evidenceBasis, 'model_hypothesis');
});

test('scoreRelation: established_knowledge outranks model_hypothesis at equal confidence/strength', () => {
  const est = scoreRelation(relation({ evidenceBasis: 'established_knowledge', confidence: 0.7, strength: 0.7 }), { now: NOW });
  const hyp = scoreRelation(relation({ evidenceBasis: 'model_hypothesis', confidence: 0.7, strength: 0.7 }), { now: NOW });
  assert.ok(est > hyp);
});

test('scoreRelation: score decays as `now` moves past windowEnd toward expiresAt', () => {
  const r = relation({
    windowEnd: new Date(NOW.getTime() - 12 * 3600 * 1000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 12 * 3600 * 1000).toISOString(),
  });
  const early = scoreRelation(r, { now: new Date(NOW.getTime() - 11 * 3600 * 1000) });
  const late = scoreRelation(r, { now: NOW });
  assert.ok(late < early, `expected score to decay over time: early=${early} late=${late}`);
});

// ── getConstraintsFor ────────────────────────────────────────────────────

test('getConstraintsFor: returns constrains relations for a target, never a completes/contributes_to one', () => {
  const constraint = relation({ id: 'r-constraint', targetType: 'workout', targetId: 'push_day', relationship: 'constrains' });
  const completion = relation({ id: 'r-completion', targetType: 'workout', targetId: 'push_day', relationship: 'completes' });
  const resolved = buildResolvedContext({ assertions: [assertion()], relations: [constraint, completion], tz: 'America/New_York', now: NOW });
  const constraints = getConstraintsFor(resolved, 'workout', 'push_day');
  assert.equal(constraints.length, 1);
  assert.equal(constraints[0].relationship, 'constrains');
});

// ── getPreferencesFor ────────────────────────────────────────────────────

test('getPreferencesFor: matches by normalized target id and by word overlap', () => {
  const pref = relation({ id: 'r-pref', targetType: 'action_type', targetId: 'evening_workouts', relationship: 'changes_priority' });
  const resolved = buildResolvedContext({ assertions: [assertion()], relations: [pref], tz: 'America/New_York', now: NOW });
  assert.equal(getPreferencesFor(resolved, 'evening workouts').length, 1);
  assert.equal(getPreferencesFor(resolved, 'workouts in the evening').length, 1);
  assert.equal(getPreferencesFor(resolved, 'morning meetings').length, 0);
});

// ── getCompletionState ───────────────────────────────────────────────────

test('getCompletionState: null when the user never corrected completion for this entity', () => {
  const resolved = buildResolvedContext({ assertions: [assertion()], relations: [], tz: 'America/New_York', now: NOW });
  assert.equal(getCompletionState(resolved, 'goal', 'the_valuation_conversation'), null);
});

test('getCompletionState: reflects the user\'s explicit "not completed" correction', () => {
  const rel = relation({
    id: 'r-completion', targetType: 'goal', targetId: 'the_valuation_conversation',
    relationship: 'completes', permittedLanguage: 'not completed',
  });
  const resolved = buildResolvedContext({ assertions: [assertion()], relations: [rel], tz: 'America/New_York', now: NOW });
  const state = getCompletionState(resolved, 'goal', 'the_valuation_conversation');
  assert.equal(state.completed, false);
  assert.equal(state.source, 'user_correction');
});

test('getCompletionState: the MOST RECENT completes relation wins when there are multiple', () => {
  const older = relation({ id: 'r-old', targetType: 'goal', targetId: 'x', relationship: 'completes', permittedLanguage: 'completed', createdAt: new Date(NOW.getTime() - 3600000).toISOString() });
  const newer = relation({ id: 'r-new', targetType: 'goal', targetId: 'x', relationship: 'completes', permittedLanguage: 'not completed', createdAt: NOW.toISOString() });
  const resolved = buildResolvedContext({ assertions: [assertion()], relations: [older, newer], tz: 'America/New_York', now: NOW });
  assert.equal(getCompletionState(resolved, 'goal', 'x').completed, false);
});

// ── getCalendarClassification ────────────────────────────────────────────

test('getCalendarClassification: null when never reclassified', () => {
  const resolved = buildResolvedContext({ assertions: [], relations: [], tz: 'America/New_York', now: NOW });
  assert.equal(getCalendarClassification(resolved, '5-9pm block'), null);
});

test('getCalendarClassification: reflects the Sabbath-block reclassification', () => {
  const rel = relation({
    id: 'r-class', targetType: 'calendar_event', targetId: '5_9pm_block',
    relationship: 'classifies', permittedLanguage: 'a Sabbath observance, not meetings',
  });
  const resolved = buildResolvedContext({ assertions: [assertion()], relations: [rel], tz: 'America/New_York', now: NOW });
  const cls = getCalendarClassification(resolved, '5-9pm block');
  assert.equal(cls.classification, 'a Sabbath observance, not meetings');
});

// ── unresolved/resolved uncertainties ────────────────────────────────────

test('getUnresolvedUncertainties / getResolvedUncertainties partition correctly', () => {
  const open = relation({ id: 'r-open', unresolved: true, resolvedAt: null });
  const answered = relation({ id: 'r-answered', unresolved: false, resolvedAt: NOW.toISOString() });
  const ordinary = relation({ id: 'r-ordinary', unresolved: false, resolvedAt: null });
  const resolved = buildResolvedContext({ assertions: [assertion()], relations: [open, answered, ordinary], tz: 'America/New_York', now: NOW });
  assert.deepEqual(getUnresolvedUncertainties(resolved).map((r) => r.id), ['r-open']);
  assert.deepEqual(getResolvedUncertainties(resolved).map((r) => r.id), ['r-answered']);
});

// ── getRelevantContext ────────────────────────────────────────────────────

test('getRelevantContext: "health" purpose excludes negated assertions and non-health domains', () => {
  const negated = assertion({ id: 'a-negated', eventStatus: 'negated', domains: ['health'] });
  const other = assertion({ id: 'a-other', eventStatus: 'occurred', domains: ['wealth'] });
  const health = assertion({ id: 'a-health', eventStatus: 'occurred', domains: ['health'] });
  const resolved = buildResolvedContext({ assertions: [negated, other, health], relations: [], tz: 'America/New_York', now: NOW });
  const ctx = getRelevantContext(resolved, 'health');
  assert.deepEqual(ctx.map((a) => a.id), ['a-health']);
});

test('getRelevantContext: "general" purpose includes negated assertions (still worth showing verbatim)', () => {
  const negated = assertion({ id: 'a-negated', eventStatus: 'negated', domains: ['health'] });
  const resolved = buildResolvedContext({ assertions: [negated], relations: [], tz: 'America/New_York', now: NOW });
  assert.deepEqual(getRelevantContext(resolved, 'general').map((a) => a.id), ['a-negated']);
});

// ── summarizeResolvedContext ──────────────────────────────────────────────
// item 2: a compact, purpose-specific prompt projection — not the complete
// graph, not raw annotation text.

test('summarizeResolvedContext: formats a relevant assertion as a compact predicate/objectValue line', () => {
  const a = assertion({ id: 'a1', predicate: 'drank', objectValue: 'wine', domains: ['health'], recordedAt: NOW.toISOString() });
  const resolved = buildResolvedContext({ assertions: [a], relations: [], tz: 'America/New_York', now: NOW });
  const text = summarizeResolvedContext(resolved, { purpose: 'health' });
  assert.equal(text, '- drank wine');
});

test('summarizeResolvedContext: falls back to truncated rawText when predicate/objectValue are empty', () => {
  const a = assertion({ id: 'a1', predicate: null, objectValue: null, rawText: 'a plain observational note', domains: ['health'], recordedAt: NOW.toISOString() });
  const resolved = buildResolvedContext({ assertions: [a], relations: [], tz: 'America/New_York', now: NOW });
  assert.equal(summarizeResolvedContext(resolved, { purpose: 'health' }), '- a plain observational note');
});

test('summarizeResolvedContext: re-anchors a relative time word in a rawText note to today (a note entered last night reads "last night", not "tonight")', () => {
  // "context timing has been consistently off": a free-text note the compiler
  // couldn't structure keeps its raw wording. Entered the evening before,
  // surfaced the next day, its "tonight" must read as "last night".
  const entered = new Date('2026-07-16T23:00:00Z'); // Jul 16 evening ET (Jul 17 is "today")
  const a = assertion({
    id: 'a-fast', predicate: null, objectValue: null,
    rawText: '25 hour fast starting tonight', domains: ['health'],
    recordedAt: entered.toISOString(),
  });
  const resolved = buildResolvedContext({ assertions: [a], relations: [], tz: 'America/New_York', now: NOW });
  const text = summarizeResolvedContext(resolved, { purpose: 'health', asOf: NOW });
  assert.match(text, /starting last night/);
  assert.doesNotMatch(text, /tonight/);
});

test('summarizeResolvedContext: marks a negated/retracted assertion inline rather than silently dropping it (general purpose only)', () => {
  const a = assertion({ id: 'a1', predicate: 'drank', objectValue: 'wine', eventStatus: 'negated', domains: ['health'], recordedAt: NOW.toISOString() });
  const resolved = buildResolvedContext({ assertions: [a], relations: [], tz: 'America/New_York', now: NOW });
  assert.equal(summarizeResolvedContext(resolved, { purpose: 'general' }), '- drank wine [negated]');
});

test('summarizeResolvedContext: excludes out-of-domain assertions for a non-general purpose', () => {
  const a = assertion({ id: 'a1', predicate: 'spent', objectValue: '$50', domains: ['wealth'], recordedAt: NOW.toISOString() });
  const resolved = buildResolvedContext({ assertions: [a], relations: [], tz: 'America/New_York', now: NOW });
  assert.equal(summarizeResolvedContext(resolved, { purpose: 'health' }), '');
});

test('summarizeResolvedContext: most-recent-first, capped at maxItems', () => {
  const older = assertion({ id: 'a-old', predicate: 'did', objectValue: 'thing one', domains: ['health'], recordedAt: new Date(NOW.getTime() - 3600000).toISOString() });
  const newer = assertion({ id: 'a-new', predicate: 'did', objectValue: 'thing two', domains: ['health'], recordedAt: NOW.toISOString() });
  const resolved = buildResolvedContext({ assertions: [older, newer], relations: [], tz: 'America/New_York', now: NOW });
  const text = summarizeResolvedContext(resolved, { purpose: 'health', maxItems: 1 });
  assert.equal(text, '- did thing two');
});

test('summarizeResolvedContext: empty when nothing relevant — callers must treat this as "fall back to raw text," not "no context"', () => {
  const resolved = buildResolvedContext({ assertions: [], relations: [], tz: 'America/New_York', now: NOW });
  assert.equal(summarizeResolvedContext(resolved, { purpose: 'health' }), '');
});

// ── extractClockTimeRange ─────────────────────────────────────────────────

test('extractClockTimeRange: parses "5-9pm" with a single trailing meridiem applying to both ends', () => {
  const r = extractClockTimeRange("that's a Sabbath block, 5-9pm, not meetings");
  assert.deepEqual(r, { startMin: 17 * 60, endMin: 21 * 60 });
});

test('extractClockTimeRange: parses "5:00-9:00 PM" and "5 to 9pm"', () => {
  assert.deepEqual(extractClockTimeRange('5:00-9:00 PM'), { startMin: 17 * 60, endMin: 21 * 60 });
  assert.deepEqual(extractClockTimeRange('5 to 9pm'), { startMin: 17 * 60, endMin: 21 * 60 });
});

test('extractClockTimeRange: returns null when no range is present, or the range is backwards', () => {
  assert.equal(extractClockTimeRange('that meeting with the team'), null);
  assert.equal(extractClockTimeRange('9-5pm'), null); // end before start once normalized — not a sane forward interval
});

// ── matchCalendarClassifications ─────────────────────────────────────────
// item 3a: a calendar-classification correction ("that's a Sabbath block,
// not meetings") must change the ACTUAL computed calendar-load projection,
// matched against the real workBusy/calendar intervals — not just be
// queryable via getCalendarClassification's fixture-shaped return.

function classifyAssertion(overrides = {}) {
  return assertion({ id: 'a-class', subject: '5-9pm block', objectValue: 'a Sabbath observance', rawText: "that's a Sabbath block, 5-9pm, not meetings", ...overrides });
}
function classifyRelation(overrides = {}) {
  return relation({
    id: 'r-class', sourceAssertionId: 'a-class', targetType: 'calendar_event', targetId: '5_9pm_block',
    relationship: 'classifies', permittedLanguage: 'a Sabbath observance, not meetings', ...overrides,
  });
}

test('matchCalendarClassifications: matches a single overlapping work-busy block by explicit clock-time range', () => {
  const resolved = buildResolvedContext({ assertions: [classifyAssertion()], relations: [classifyRelation()], tz: 'America/New_York', now: NOW });
  const workBusy = [{ start: '5:00 PM', end: '9:00 PM' }, { start: '10:00 AM', end: '11:00 AM' }];
  const overrides = matchCalendarClassifications(resolved, { calendar: [], workBusy });
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].title, 'a Sabbath observance, not meetings');
  assert.equal(overrides[0].startTime, '5:00 PM');
  assert.equal(overrides[0].endTime, '9:00 PM');
  assert.equal(overrides[0].allDay, false);
});

test('matchCalendarClassifications: ambiguous time-range overlap (two candidate blocks) falls through to text match; no title match either -> not applied', () => {
  const resolved = buildResolvedContext({ assertions: [classifyAssertion()], relations: [classifyRelation()], tz: 'America/New_York', now: NOW });
  // Two work-busy blocks both overlap the extracted 5-9pm range, so the
  // time-range path is ambiguous — must fall through to text matching, which
  // also fails (no named calendar events at all) — the assertion stays
  // persisted/queryable but is applied to nothing.
  const workBusy = [{ start: '5:00 PM', end: '7:00 PM' }, { start: '6:00 PM', end: '9:00 PM' }];
  const overrides = matchCalendarClassifications(resolved, { calendar: [], workBusy });
  assert.deepEqual(overrides, []);
  // Still readable directly, per getCalendarClassification's contract.
  assert.ok(getCalendarClassification(resolved, '5_9pm_block'));
});

test('matchCalendarClassifications: text-only fallback matches a named calendar event title when no clock-time range is present', () => {
  const noRange = classifyAssertion({ subject: 'the Sabbath dinner block', objectValue: 'a Sabbath observance', rawText: "that's a Sabbath block, not meetings" });
  const rel = classifyRelation({ sourceAssertionId: 'a-class' });
  const resolved = buildResolvedContext({ assertions: [noRange], relations: [rel], tz: 'America/New_York', now: NOW });
  const calendar = [{ title: 'Sabbath dinner block', startTime: '5:00 PM', endTime: '9:00 PM', allDay: false }];
  const overrides = matchCalendarClassifications(resolved, { calendar, workBusy: [] });
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].startTime, '5:00 PM');
  assert.equal(overrides[0].endTime, '9:00 PM');
});

test('matchCalendarClassifications: no overlapping interval and no matching title -> not applied at all (fail closed, never guesses)', () => {
  const resolved = buildResolvedContext({ assertions: [classifyAssertion()], relations: [classifyRelation()], tz: 'America/New_York', now: NOW });
  const workBusy = [{ start: '10:00 AM', end: '11:00 AM' }];
  const calendar = [{ title: 'Unrelated dentist appointment', startTime: '2:00 PM', endTime: '3:00 PM', allDay: false }];
  const overrides = matchCalendarClassifications(resolved, { calendar, workBusy });
  assert.deepEqual(overrides, []);
});

test('matchCalendarClassifications: no classification relations at all -> empty array, no crash', () => {
  const resolved = buildResolvedContext({ assertions: [], relations: [], tz: 'America/New_York', now: NOW });
  assert.deepEqual(matchCalendarClassifications(resolved, { calendar: [], workBusy: [] }), []);
});

// ── matchCompletionCorrections ────────────────────────────────────────────
// item 3b: "I did not complete the valuation conversation" must change the
// canonical goal/commitment/workout projection every surface reads (see
// store/commitments.js's listActive, which is this function's real
// production caller) — not just be resolvable via getCompletionState.

function completionAssertion(overrides = {}) {
  return assertion({ id: 'a-completion', subject: 'user', objectValue: 'the valuation conversation', rawText: 'I did not complete the valuation conversation', ...overrides });
}
function completionRelation(overrides = {}) {
  return relation({
    id: 'r-completion', sourceAssertionId: 'a-completion', targetType: 'commitment', targetId: 'the_valuation_conversation',
    relationship: 'completes', permittedLanguage: 'not completed', createdAt: NOW.toISOString(), ...overrides,
  });
}

test('matchCompletionCorrections: unambiguous match against an item never explicitly completed -> override applies', () => {
  const resolved = buildResolvedContext({ assertions: [completionAssertion()], relations: [completionRelation()], tz: 'America/New_York', now: NOW });
  const items = [
    { id: 'c1', title: 'Have the valuation conversation with the broker', completedAt: null },
    { id: 'c2', title: 'Go for a run', completedAt: null },
  ];
  const overrides = matchCompletionCorrections(resolved, { items, targetType: 'commitment' });
  assert.equal(overrides.size, 1);
  assert.equal(overrides.get('c1').completed, false);
  assert.equal(overrides.has('c2'), false);
});

test('matchCompletionCorrections: a LATER authoritative completion supersedes the correction', () => {
  const resolved = buildResolvedContext({ assertions: [completionAssertion()], relations: [completionRelation()], tz: 'America/New_York', now: NOW });
  const items = [{ id: 'c1', title: 'Have the valuation conversation with the broker', completedAt: new Date(NOW.getTime() + 3600000).toISOString() }];
  const overrides = matchCompletionCorrections(resolved, { items, targetType: 'commitment' });
  assert.equal(overrides.size, 0, 'a completion recorded AFTER the correction must win — no override');
});

test('matchCompletionCorrections: a completion recorded BEFORE the correction does not supersede it', () => {
  const resolved = buildResolvedContext({ assertions: [completionAssertion()], relations: [completionRelation()], tz: 'America/New_York', now: NOW });
  const items = [{ id: 'c1', title: 'Have the valuation conversation with the broker', completedAt: new Date(NOW.getTime() - 3600000).toISOString() }];
  const overrides = matchCompletionCorrections(resolved, { items, targetType: 'commitment' });
  assert.equal(overrides.size, 1);
  assert.equal(overrides.get('c1').completed, false);
});

test('matchCompletionCorrections: ambiguous match (two equally-scoring candidates) -> no override for either, never guesses', () => {
  const resolved = buildResolvedContext({ assertions: [completionAssertion()], relations: [completionRelation()], tz: 'America/New_York', now: NOW });
  const items = [
    { id: 'c1', title: 'the valuation conversation', completedAt: null },
    { id: 'c2', title: 'the valuation conversation', completedAt: null },
  ];
  const overrides = matchCompletionCorrections(resolved, { items, targetType: 'commitment' });
  assert.equal(overrides.size, 0);
});

test('matchCompletionCorrections: no matching text at all -> empty map', () => {
  const resolved = buildResolvedContext({ assertions: [completionAssertion()], relations: [completionRelation()], tz: 'America/New_York', now: NOW });
  const items = [{ id: 'c1', title: 'Buy groceries', completedAt: null }];
  const overrides = matchCompletionCorrections(resolved, { items, targetType: 'commitment' });
  assert.equal(overrides.size, 0);
});

test('matchCompletionCorrections: wrong targetType never matches (a "goal" correction does not apply to commitment items)', () => {
  const resolved = buildResolvedContext({ assertions: [completionAssertion()], relations: [completionRelation({ targetType: 'goal' })], tz: 'America/New_York', now: NOW });
  const items = [{ id: 'c1', title: 'Have the valuation conversation with the broker', completedAt: null }];
  const overrides = matchCompletionCorrections(resolved, { items, targetType: 'commitment' });
  assert.equal(overrides.size, 0);
});

test('matchCompletionCorrections: no completion relations at all -> empty map, no crash', () => {
  const resolved = buildResolvedContext({ assertions: [], relations: [], tz: 'America/New_York', now: NOW });
  assert.equal(matchCompletionCorrections(resolved, { items: [{ id: 'c1', title: 'x' }], targetType: 'commitment' }).size, 0);
});

// ── Temporal eligibility (audit fix, item 1) ──────────────────────────────
// summarizeResolvedContext used to include EVERY non-retired assertion,
// reduced to an undated line — an event from days ago read exactly like one
// from last night. isTemporallyEligible/temporalAnchorSuffix are the fix:
// episodic assertions drop out once their OWN persisted effective window's
// calendar day has passed, durable statements (preferences) never expire,
// and eligible episodic lines carry an explicit date anchor.

const NIGHT_START = '2026-07-17T02:00:00Z'; // ~10pm ET July 16
const NIGHT_END = '2026-07-17T11:00:00Z'; // ~7am ET July 17 (wake)

function drankLastNight(overrides = {}) {
  return assertion({
    id: 'a-drink', predicate: 'drank', objectValue: 'wine', rawText: 'I drank last night',
    assertionType: 'event', temporalRef: 'last_night',
    effectiveStart: NIGHT_START, effectiveEnd: NIGHT_END,
    recordedAt: NIGHT_END, createdAt: NIGHT_END,
    ...overrides,
  });
}

test('temporal: "I drank last night" is eligible for the SAME day\'s recovery window (asOf later the same morning)', () => {
  const resolved = buildResolvedContext({ assertions: [drankLastNight()], relations: [], tz: 'America/New_York', now: NOW });
  assert.equal(isTemporallyEligible(resolved.assertions[0], { asOf: NOW, tz: 'America/New_York' }), true);
  const summary = summarizeResolvedContext(resolved, { purpose: 'general', asOf: NOW });
  assert.match(summary, /drank wine/);
  assert.match(summary, /applied to the night ending July 17\./, `expected a night anchor, got: ${summary}`);
});

test('temporal: the SAME assertion does NOT apply to the following night (asOf 24h later)', () => {
  const resolved = buildResolvedContext({ assertions: [drankLastNight()], relations: [], tz: 'America/New_York', now: NOW });
  const nextNightAsOf = new Date('2026-07-18T15:00:00Z'); // 11am ET the following day
  assert.equal(isTemporallyEligible(resolved.assertions[0], { asOf: nextNightAsOf, tz: 'America/New_York' }), false);
  const summary = summarizeResolvedContext(resolved, { purpose: 'general', asOf: nextNightAsOf });
  assert.doesNotMatch(summary, /drank wine/, 'a prior night\'s drinking must not silently apply to a later night');
});

test('temporal: context ENTERED the next morning but describing the prior night is anchored to the night, not the entry time', () => {
  // recordedAt/createdAt deliberately differ from effectiveStart/effectiveEnd
  // (the user typed this later in the morning) — eligibility and the anchor
  // must both be driven by effectiveEnd, never by when it was recorded.
  const a = drankLastNight({ recordedAt: '2026-07-17T13:30:00Z', createdAt: '2026-07-17T13:30:00Z' });
  const resolved = buildResolvedContext({ assertions: [a], relations: [], tz: 'America/New_York', now: NOW });
  assert.equal(isTemporallyEligible(resolved.assertions[0], { asOf: NOW, tz: 'America/New_York' }), true);
  const summary = summarizeResolvedContext(resolved, { purpose: 'general', asOf: NOW });
  assert.match(summary, /applied to the night ending July 17\./);
});

test('temporal: an expired episodic event disappears from the summary while a durable preference remains', () => {
  const expiredEvent = assertion({
    id: 'a-old', predicate: 'felt', objectValue: 'jet lagged', assertionType: 'event', temporalRef: 'explicit_date',
    effectiveStart: '2026-07-10T00:00:00Z', effectiveEnd: '2026-07-10T11:00:00Z',
    recordedAt: '2026-07-10T11:00:00Z', createdAt: '2026-07-10T11:00:00Z',
  });
  const durablePref = assertion({
    id: 'a-pref', predicate: 'prefers', objectValue: 'morning workouts', assertionType: 'preference',
    domains: ['wellbeing'], effectiveStart: null, effectiveEnd: null,
    recordedAt: '2026-07-01T09:00:00Z', createdAt: '2026-07-01T09:00:00Z',
  });
  assert.equal(isDurableAssertion(durablePref), true);
  assert.equal(isDurableAssertion(expiredEvent), false);
  const resolved = buildResolvedContext({ assertions: [expiredEvent, durablePref], relations: [], tz: 'America/New_York', now: NOW });
  const summary = summarizeResolvedContext(resolved, { purpose: 'general', asOf: NOW });
  assert.doesNotMatch(summary, /jet lagged/, 'an expired episodic event must drop out of the projection');
  assert.match(summary, /morning workouts/, 'a durable preference must never be excluded by the passage of time');
});

test('temporal: includeHistorical:true bypasses the window filter for a surface that explicitly wants past context', () => {
  const expiredEvent = assertion({
    id: 'a-old2', predicate: 'felt', objectValue: 'jet lagged', assertionType: 'event',
    effectiveStart: '2026-07-10T00:00:00Z', effectiveEnd: '2026-07-10T11:00:00Z',
  });
  const resolved = buildResolvedContext({ assertions: [expiredEvent], relations: [], tz: 'America/New_York', now: NOW });
  assert.doesNotMatch(summarizeResolvedContext(resolved, { asOf: NOW }), /jet lagged/);
  assert.match(summarizeResolvedContext(resolved, { asOf: NOW, includeHistorical: true }), /jet lagged/);
});

test('temporal: a negated event, even if temporally eligible and visible in the general summary, never becomes an active driver', () => {
  const negated = assertion({
    id: 'a-neg', predicate: 'drank', objectValue: 'wine', assertionType: 'event', eventStatus: 'negated',
    temporalRef: 'last_night', effectiveStart: NIGHT_START, effectiveEnd: NIGHT_END,
  });
  // No 'contributes_to' relation at all — matches real compiler behavior
  // (context-compiler.js's deriveRelations never derives a metric relation
  // for a negated/retracted event), which is WHY it can't become a driver;
  // temporal eligibility alone must never be mistaken for driver eligibility.
  const resolved = buildResolvedContext({ assertions: [negated], relations: [], tz: 'America/New_York', now: NOW });
  assert.equal(isTemporallyEligible(resolved.assertions[0], { asOf: NOW, tz: 'America/New_York' }), true);
  assert.match(summarizeResolvedContext(resolved, { purpose: 'general', asOf: NOW }), /drank wine \[negated\]/);
  const driver = getDriversFor(resolved, 'health:recovery_autonomic', { now: NOW });
  assert.equal(driver.driver, null, 'a negated event must never surface as an active driver, regardless of temporal eligibility');
});

test('temporal: eligibility and the date anchor are genuinely timezone-sensitive, not just "runs twice"', () => {
  // The SAME UTC instant falls on a DIFFERENT calendar day in each zone:
  // 10pm ET July 16 is already 11am JST July 17.
  const boundaryEnd = '2026-07-17T02:00:00Z';
  const a = () => assertion({ id: 'a-tz', predicate: 'felt', objectValue: 'off', assertionType: 'event', effectiveStart: boundaryEnd, effectiveEnd: boundaryEnd });
  const asOfBetween = new Date('2026-07-17T10:00:00Z');

  const resolvedNy = buildResolvedContext({ assertions: [a()], relations: [], tz: 'America/New_York', now: NOW });
  const resolvedTokyo = buildResolvedContext({ assertions: [a()], relations: [], tz: 'Asia/Tokyo', now: NOW });

  assert.equal(isTemporallyEligible(resolvedNy.assertions[0], { asOf: asOfBetween, tz: 'America/New_York' }), false,
    'in ET the event\'s own calendar day (July 16) has already ended by the asOf instant');
  assert.equal(isTemporallyEligible(resolvedTokyo.assertions[0], { asOf: asOfBetween, tz: 'Asia/Tokyo' }), true,
    'in JST the SAME instant falls on July 17, whose day has not ended yet at the asOf instant');

  assert.equal(temporalAnchorSuffix(resolvedNy.assertions[0], 'America/New_York'), ' — applied to July 16.');
  assert.equal(temporalAnchorSuffix(resolvedTokyo.assertions[0], 'Asia/Tokyo'), ' — applied to July 17.');

  // Determinism: repeated calls with identical inputs give identical output.
  const run1 = summarizeResolvedContext(resolvedTokyo, { asOf: asOfBetween });
  const run2 = summarizeResolvedContext(resolvedTokyo, { asOf: asOfBetween });
  assert.equal(run1, run2);
});

test('temporal: summarizeResolvedContext defaults asOf to resolved.generatedAt, not a fresh Date.now() each read', () => {
  const a = assertion({ id: 'a-fixed', predicate: 'felt', objectValue: 'off', assertionType: 'event', effectiveStart: NIGHT_START, effectiveEnd: NIGHT_END });
  const resolved = buildResolvedContext({ assertions: [a], relations: [], tz: 'America/New_York', now: NOW });
  // No asOf passed — must use resolved.generatedAt (NOW), not the real current time.
  assert.match(summarizeResolvedContext(resolved, { purpose: 'general' }), /felt off/);
});
