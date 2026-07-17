// Pure unit coverage for intelligence/context-resolver.js — buildResolvedContext
// and every canonical selector, including the driver engine's scoring and
// the "no eligible driver" result. See
// test/integration/context-understanding.test.js for the real-Postgres,
// end-to-end scenario proofs.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildResolvedContext, getDriversFor, getConstraintsFor, getPreferencesFor, getCompletionState,
  getCalendarClassification, getResolvedUncertainties, getUnresolvedUncertainties, getRelevantContext,
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
