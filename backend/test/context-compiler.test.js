// Pure unit coverage for intelligence/context-compiler.js's deterministic
// validation/enrichment layer — the rules that VALIDATE and CONSTRAIN the
// LLM's structured extraction (never replace it). See
// test/integration/context-understanding.test.js for the end-to-end
// pipeline (real Postgres, real Structured Outputs call) and the 9 proof
// scenarios.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveTemporalWindow, reconcileEventStatus, dedupeAssertions, findSupersededAssertion,
  deriveRelations, normalizeTargetId, blendConfidence,
} = require('../src/intelligence/context-compiler');
const { EVIDENCE_TIER } = require('../src/intelligence/knowledge-registry');

const TZ = 'America/New_York';
const NOW = new Date('2026-07-17T15:00:00Z'); // 11am ET, Friday

// ── resolveTemporalWindow ────────────────────────────────────────────────

test('resolveTemporalWindow: "last_night" for a health-domain assertion anchors to the overnight window', () => {
  const w = resolveTemporalWindow({ temporalRef: 'last_night', explicitDate: '', domains: ['health'] }, { tz: TZ, now: NOW });
  assert.ok(w.effectiveStart instanceof Date && w.effectiveEnd instanceof Date);
  assert.ok(w.effectiveStart < w.effectiveEnd);
  // The night before NOW's local date (2026-07-17), starting in the evening.
  assert.equal(w.effectiveStart.toLocaleDateString('en-CA', { timeZone: TZ }), '2026-07-16');
});

test('resolveTemporalWindow: "yesterday" gives yesterday\'s full local day', () => {
  const w = resolveTemporalWindow({ temporalRef: 'yesterday', explicitDate: '', domains: ['other'] }, { tz: TZ, now: NOW });
  assert.equal(w.effectiveStart.toLocaleDateString('en-CA', { timeZone: TZ }), '2026-07-16');
  assert.equal(w.effectiveEnd.toLocaleDateString('en-CA', { timeZone: TZ }), '2026-07-16');
});

test('resolveTemporalWindow: "explicit_date" resolves to that exact local day, not "today"', () => {
  const w = resolveTemporalWindow({ temporalRef: 'explicit_date', explicitDate: '2026-07-15', domains: ['other'] }, { tz: TZ, now: NOW });
  assert.equal(w.effectiveStart.toLocaleDateString('en-CA', { timeZone: TZ }), '2026-07-15');
  assert.equal(w.effectiveEnd.toLocaleDateString('en-CA', { timeZone: TZ }), '2026-07-15');
});

test('resolveTemporalWindow: "unspecified" yields no window rather than guessing', () => {
  const w = resolveTemporalWindow({ temporalRef: 'unspecified', explicitDate: '', domains: ['other'] }, { tz: TZ, now: NOW });
  assert.equal(w.effectiveStart, null);
  assert.equal(w.effectiveEnd, null);
});

test('resolveTemporalWindow: "future" starts at now with an open end', () => {
  const w = resolveTemporalWindow({ temporalRef: 'future', explicitDate: '', domains: ['other'] }, { tz: TZ, now: NOW });
  assert.equal(w.effectiveStart.getTime(), NOW.getTime());
  assert.equal(w.effectiveEnd, null);
});

// ── reconcileEventStatus ─────────────────────────────────────────────────

test('reconcileEventStatus: forces "negated" when the raw text is an unambiguous negation the model missed', () => {
  const out = reconcileEventStatus({ eventStatus: 'occurred', assertionType: 'event' }, "I didn't drink last night");
  assert.equal(out.eventStatus, 'negated');
});

test('reconcileEventStatus: forces "retracted" + assertionType "correction" for an explicit retraction', () => {
  const out = reconcileEventStatus({ eventStatus: 'occurred', assertionType: 'event' }, 'forget what I said about the late meal');
  assert.equal(out.eventStatus, 'retracted');
  assert.equal(out.assertionType, 'correction');
});

test('reconcileEventStatus: leaves a correctly-classified assertion untouched', () => {
  const out = reconcileEventStatus({ eventStatus: 'occurred', assertionType: 'event' }, 'I had drinks last night');
  assert.equal(out.eventStatus, 'occurred');
});

// ── dedupeAssertions ─────────────────────────────────────────────────────

test('dedupeAssertions: drops exact duplicate (subject/predicate/objectValue/day) pairs', () => {
  const a = { subject: 'user', predicate: 'drank', objectValue: 'wine', effectiveStart: '2026-07-16T23:00:00.000Z' };
  const b = { ...a };
  const c = { subject: 'user', predicate: 'skipped', objectValue: 'workout', effectiveStart: '2026-07-16T23:00:00.000Z' };
  assert.equal(dedupeAssertions([a, b, c]).length, 2);
});

// ── findSupersededAssertion ──────────────────────────────────────────────

test('findSupersededAssertion: matches a correction against the ONE recent assertion it clearly walks back', () => {
  const candidate = { assertionType: 'correction', correctsPriorText: 'the late meal last night', eventStatus: 'occurred' };
  const recent = [
    { id: 'a1', subject: 'user', predicate: 'ate', objectValue: 'a late meal', rawText: 'ate a late meal last night' },
    { id: 'a2', subject: 'user', predicate: 'drank', objectValue: 'wine', rawText: 'drank wine last night' },
  ];
  const target = findSupersededAssertion(candidate, recent);
  assert.equal(target?.id, 'a1');
});

test('findSupersededAssertion: returns null when nothing plausibly matches (never guesses)', () => {
  const candidate = { assertionType: 'correction', correctsPriorText: 'a trip to the dentist', eventStatus: 'occurred' };
  const recent = [{ id: 'a1', subject: 'user', predicate: 'drank', objectValue: 'wine', rawText: 'drank wine last night' }];
  assert.equal(findSupersededAssertion(candidate, recent), null);
});

test('findSupersededAssertion: a non-correcting assertion never looks for a target at all', () => {
  const candidate = { assertionType: 'event', correctsPriorText: '', eventStatus: 'occurred' };
  const recent = [{ id: 'a1', subject: 'user', predicate: 'drank', objectValue: 'wine', rawText: 'drank wine last night' }];
  assert.equal(findSupersededAssertion(candidate, recent), null);
});

// ── normalizeTargetId ────────────────────────────────────────────────────

test('normalizeTargetId: collapses case/punctuation/whitespace to a stable key', () => {
  assert.equal(normalizeTargetId('The Valuation Conversation!'), 'the_valuation_conversation');
  assert.equal(normalizeTargetId('  extra   spaces  '), 'extra_spaces');
});

test('normalizeTargetId: empty/null input yields a stable sentinel, never throws', () => {
  assert.equal(normalizeTargetId(''), 'unspecified');
  assert.equal(normalizeTargetId(null), 'unspecified');
});

// ── blendConfidence ──────────────────────────────────────────────────────

test('blendConfidence: caps confidence for a model_hypothesis entry even with high assertion confidence', () => {
  const c = blendConfidence(0.99, { evidenceTier: EVIDENCE_TIER.MODEL_HYPOTHESIS });
  assert.ok(c <= 0.3, `expected a low cap for model_hypothesis, got ${c}`);
});

test('blendConfidence: an established entry can reach a meaningfully higher confidence', () => {
  const c = blendConfidence(0.9, { evidenceTier: EVIDENCE_TIER.ESTABLISHED });
  assert.ok(c > 0.5, `expected established-tier confidence to exceed 0.5, got ${c}`);
});

// ── deriveRelations ───────────────────────────────────────────────────────

test('deriveRelations: an occurred health event with a registry-matched concept becomes an established_knowledge metric relation', () => {
  const assertion = {
    assertionType: 'event', eventStatus: 'occurred', domains: ['health'], concepts: ['alcohol'],
    confidence: 0.9, effectiveStart: NOW.toISOString(), effectiveEnd: NOW.toISOString(),
    subject: 'user', predicate: 'drank', objectValue: 'wine', rawText: 'drank wine last night',
  };
  const rels = deriveRelations(assertion, {});
  assert.equal(rels.length, 1);
  assert.equal(rels[0].targetType, 'metric');
  assert.equal(rels[0].evidenceBasis, 'established_knowledge');
});

test('deriveRelations: a plain health event with NO recognized concept produces no relation at all (remains context, not causal)', () => {
  const assertion = {
    assertionType: 'event', eventStatus: 'occurred', domains: ['health'], concepts: [],
    confidence: 0.8, subject: 'user', predicate: 'went for', objectValue: 'a walk', rawText: 'went for a walk',
  };
  assert.deepEqual(deriveRelations(assertion, {}), []);
});

test('deriveRelations: an "explanation" for a health outcome with NO recognized concept becomes a visibly-uncertain model_hypothesis (scenario 9 — unknown concept)', () => {
  const assertion = {
    assertionType: 'explanation', eventStatus: 'occurred', domains: ['health'], concepts: ['box_breathing'],
    confidence: 0.8, subject: 'user', predicate: 'did', objectValue: 'box breathing before bed', rawText: 'box breathing before bed helped',
  };
  const rels = deriveRelations(assertion, {});
  assert.equal(rels.length, 1);
  assert.equal(rels[0].evidenceBasis, 'model_hypothesis');
  assert.ok(rels[0].confidence <= 0.3);
});

test('deriveRelations: a workout-skip DECISION with a constraint reason produces a "constrains" relation, never a "completes: true"', () => {
  const decision = {
    assertionType: 'decision', eventStatus: 'occurred', domains: ['workouts'], concepts: [],
    confidence: 0.9, subject: 'the workout', predicate: 'skipped', objectValue: '', rawText: 'skipped the hard workout because I was exhausted',
  };
  const rels = deriveRelations(decision, {});
  assert.ok(rels.some((r) => r.relationship === 'constrains' && r.targetType === 'workout'));
  assert.ok(!rels.some((r) => r.relationship === 'completes' && r.permittedLanguage === 'completed'));
});

test('deriveRelations: an explicit completion correction ("did not complete") never becomes a metric relation, only a "completes" relation', () => {
  const assertion = {
    assertionType: 'completion', eventStatus: 'negated', domains: ['goals'], concepts: [],
    confidence: 0.9, subject: 'the valuation conversation', predicate: 'is', objectValue: 'not complete', rawText: 'I did not complete the valuation conversation',
  };
  const rels = deriveRelations(assertion, {});
  assert.equal(rels.length, 1);
  assert.equal(rels[0].targetType, 'goal');
  assert.equal(rels[0].relationship, 'completes');
  assert.equal(rels[0].permittedLanguage, 'not completed');
});

test('deriveRelations: a calendar classification never targets a metric, only a calendar_event', () => {
  const assertion = {
    assertionType: 'classification', eventStatus: 'occurred', domains: ['calendar'], concepts: ['sabbath_block'],
    confidence: 0.9, subject: 'the 5-9pm block', predicate: 'is', objectValue: 'a Sabbath observance, not meetings', rawText: "that's a Sabbath block, not meetings",
  };
  const rels = deriveRelations(assertion, {});
  assert.equal(rels.length, 1);
  assert.equal(rels[0].targetType, 'calendar_event');
  assert.equal(rels[0].relationship, 'classifies');
  assert.equal(rels[0].evidenceBasis, 'user_explicit');
});

test('deriveRelations: a durable preference targets action_type with changes_priority, no expiration fields set', () => {
  const assertion = {
    assertionType: 'preference', eventStatus: 'occurred', domains: ['workouts'], concepts: [],
    confidence: 0.9, subject: 'user', predicate: 'prefers not to schedule', objectValue: 'evening workouts', rawText: "don't recommend evening workouts",
  };
  const rels = deriveRelations(assertion, {});
  assert.equal(rels.length, 1);
  assert.equal(rels[0].targetType, 'action_type');
  assert.equal(rels[0].relationship, 'changes_priority');
  assert.equal(rels[0].expiresAt, undefined);
});

test('deriveRelations: supersession produces an "invalidates" relation for a retraction, "supersedes" otherwise', () => {
  const retraction = { assertionType: 'correction', eventStatus: 'retracted', domains: ['health'], concepts: [], confidence: 0.9 };
  const retractedRels = deriveRelations(retraction, { supersedesAssertionId: 'prior-id' });
  assert.ok(retractedRels.some((r) => r.relationship === 'invalidates' && r.targetId === 'prior-id'));

  const correction = { assertionType: 'correction', eventStatus: 'occurred', domains: ['health'], concepts: [], confidence: 0.9 };
  const correctionRels = deriveRelations(correction, { supersedesAssertionId: 'prior-id-2' });
  assert.ok(correctionRels.some((r) => r.relationship === 'supersedes' && r.targetId === 'prior-id-2'));
});
