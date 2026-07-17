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

// ── Compound negation/retraction is ASSERTION-LOCAL (harden pass, item 6) ──
// reconcileEventStatus must classify each assertion's OWN evidenceSpan, not
// the whole message — a compound statement bundles a negated clause with an
// unrelated occurred clause, and only the matching assertion may be negated.
test('reconcileEventStatus: "I didn\'t drink, but I ate a late meal" negates ONLY the alcohol assertion, not the late-meal one', () => {
  const fullText = "I didn't drink, but I ate a late meal";
  const alcohol = reconcileEventStatus({ eventStatus: 'occurred', assertionType: 'event', evidenceSpan: "I didn't drink" }, fullText);
  const lateMeal = reconcileEventStatus({ eventStatus: 'occurred', assertionType: 'event', evidenceSpan: 'I ate a late meal' }, fullText);
  assert.equal(alcohol.eventStatus, 'negated');
  assert.equal(lateMeal.eventStatus, 'occurred', 'the sibling assertion\'s own span has no negation cue and must stay occurred');
});

test('reconcileEventStatus: "I drank, but I didn\'t eat late" negates ONLY the late-meal assertion', () => {
  const fullText = "I drank, but I didn't eat late";
  const alcohol = reconcileEventStatus({ eventStatus: 'occurred', assertionType: 'event', evidenceSpan: 'I drank' }, fullText);
  const lateMeal = reconcileEventStatus({ eventStatus: 'occurred', assertionType: 'event', evidenceSpan: "I didn't eat late" }, fullText);
  assert.equal(alcohol.eventStatus, 'occurred');
  assert.equal(lateMeal.eventStatus, 'negated');
});

test('reconcileEventStatus: "Forget the late meal; the drinks still happened" retracts ONLY the late-meal assertion', () => {
  const fullText = 'Please forget the late meal; the drinks still happened';
  const lateMeal = reconcileEventStatus({ eventStatus: 'occurred', assertionType: 'event', evidenceSpan: 'Please forget the late meal' }, fullText);
  const alcohol = reconcileEventStatus({ eventStatus: 'occurred', assertionType: 'event', evidenceSpan: 'the drinks still happened' }, fullText);
  assert.equal(lateMeal.eventStatus, 'retracted');
  assert.equal(lateMeal.assertionType, 'correction');
  assert.equal(alcohol.eventStatus, 'occurred', 'a sibling clause reporting the drinks DID happen must not be retracted just because the message also retracts something else');
});

test('reconcileEventStatus: "I planned drinks but didn\'t go, and I still ate late" negates the plan, leaves the late meal occurred', () => {
  const fullText = "I planned drinks but didn't go, and I still ate late";
  const plan = reconcileEventStatus({ eventStatus: 'planned', assertionType: 'plan', evidenceSpan: "I planned drinks but didn't go" }, fullText);
  const lateMeal = reconcileEventStatus({ eventStatus: 'occurred', assertionType: 'event', evidenceSpan: 'I still ate late' }, fullText);
  assert.equal(plan.eventStatus, 'negated');
  assert.equal(lateMeal.eventStatus, 'occurred');
});

test('reconcileEventStatus: missing evidenceSpan falls back to the full message (backward-safe, not the normal path)', () => {
  // The schema REQUIRES evidenceSpan on every real compiled assertion; this
  // only covers a malformed/older response reaching this function directly.
  const out = reconcileEventStatus({ eventStatus: 'occurred', assertionType: 'event', evidenceSpan: '' }, "I didn't drink last night");
  assert.equal(out.eventStatus, 'negated');
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
  // A realistic compiled assertion always carries a bounded window from
  // resolveTemporalWindow (e.g. temporalRef 'last_night') — metric relations
  // require one (see the fail-closed temporal test below), so this fixture
  // includes one rather than testing an incomplete/unrealistic shape.
  const assertion = {
    assertionType: 'explanation', eventStatus: 'occurred', domains: ['health'], concepts: ['box_breathing'],
    confidence: 0.8, subject: 'user', predicate: 'did', objectValue: 'box breathing before bed', rawText: 'box breathing before bed helped',
    effectiveStart: NOW.toISOString(), effectiveEnd: NOW.toISOString(),
  };
  const rels = deriveRelations(assertion, {});
  assert.equal(rels.length, 1);
  assert.equal(rels[0].evidenceBasis, 'model_hypothesis');
  assert.ok(rels[0].confidence <= 0.3);
  assert.ok(rels[0].expiresAt, 'a metric relation must always carry a real, finite expiresAt');
});

// ── Fail-closed temporal handling (harden pass, item 5) ──────────────────
// A health event whose timing could NOT be resolved (temporalRef
// 'unspecified' -> resolveTemporalWindow returns effectiveEnd: null) must
// never become a permanent recovery/health driver just because timing was
// unknown. It still compiles as context (the assertion itself is
// unconditional); it just gets NO metric-targeting relation.
test('deriveRelations: a health event/concept match with UNKNOWN timing (effectiveEnd null) produces NO metric relation at all', () => {
  const assertion = {
    assertionType: 'event', eventStatus: 'occurred', domains: ['health'], concepts: ['alcohol'],
    confidence: 0.9, subject: 'user', predicate: 'drank', objectValue: 'wine', rawText: 'drank wine at some point',
    effectiveStart: null, effectiveEnd: null,
  };
  assert.deepEqual(deriveRelations(assertion, {}), []);
});

test('deriveRelations: an unrecognized-concept "explanation" with UNKNOWN timing also produces NO hypothesis relation', () => {
  const assertion = {
    assertionType: 'explanation', eventStatus: 'occurred', domains: ['health'], concepts: ['box_breathing'],
    confidence: 0.8, subject: 'user', predicate: 'did', objectValue: 'box breathing', rawText: 'box breathing seems to help',
    effectiveStart: null, effectiveEnd: null,
  };
  assert.deepEqual(deriveRelations(assertion, {}), []);
});

test('deriveRelations: every metric relation created gets a finite expiresAt, never null/undefined (no undecaying driver)', () => {
  const assertion = {
    assertionType: 'event', eventStatus: 'occurred', domains: ['health'], concepts: ['alcohol'],
    confidence: 0.9, subject: 'user', predicate: 'drank', objectValue: 'wine', rawText: 'drank wine last night',
    effectiveStart: NOW.toISOString(), effectiveEnd: NOW.toISOString(),
  };
  const rels = deriveRelations(assertion, {});
  assert.equal(rels.length, 1);
  assert.ok(rels[0].expiresAt, 'expiresAt must be set');
  assert.ok(new Date(rels[0].expiresAt).getTime() > new Date(assertion.effectiveEnd).getTime(), 'expiresAt must be strictly after the effective window');
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

test('deriveRelations: a durable "avoid" preference targets action_type with changes_priority, no expiration fields set', () => {
  const assertion = {
    assertionType: 'preference', eventStatus: 'occurred', domains: ['workouts'], concepts: [],
    confidence: 0.9, subject: 'user', predicate: 'prefers not to schedule', objectValue: 'evening workouts', rawText: "don't recommend evening workouts",
    polarity: 'avoid',
  };
  const rels = deriveRelations(assertion, {});
  assert.equal(rels.length, 1);
  assert.equal(rels[0].targetType, 'action_type');
  assert.equal(rels[0].relationship, 'changes_priority');
  assert.equal(rels[0].direction, 'avoid');
  assert.equal(rels[0].expiresAt, undefined);
});

test('deriveRelations: a "prefer" polarity carries through to the relation\'s direction (harden pass, item 4)', () => {
  const assertion = {
    assertionType: 'preference', eventStatus: 'occurred', domains: ['workouts'], concepts: [],
    confidence: 0.9, subject: 'user', predicate: 'prefers', objectValue: 'morning workouts', rawText: 'I prefer morning workouts',
    polarity: 'prefer',
  };
  const rels = deriveRelations(assertion, {});
  assert.equal(rels.length, 1);
  assert.equal(rels[0].direction, 'prefer', 'a "prefer" statement must carry prefer polarity, never default to avoid');
});

test('deriveRelations: a missing/invalid polarity defaults to "neutral" (fail-safe: never guesses "avoid")', () => {
  const assertion = {
    assertionType: 'preference', eventStatus: 'occurred', domains: ['workouts'], concepts: [],
    confidence: 0.9, subject: 'user', predicate: 'mentioned', objectValue: 'workouts', rawText: 'workouts came up',
    // polarity intentionally omitted
  };
  const rels = deriveRelations(assertion, {});
  assert.equal(rels[0].direction, 'neutral');
});

test('deriveRelations: supersession produces an "invalidates" relation for a retraction, "supersedes" otherwise', () => {
  const retraction = { assertionType: 'correction', eventStatus: 'retracted', domains: ['health'], concepts: [], confidence: 0.9 };
  const retractedRels = deriveRelations(retraction, { supersedesAssertionId: 'prior-id' });
  assert.ok(retractedRels.some((r) => r.relationship === 'invalidates' && r.targetId === 'prior-id'));

  const correction = { assertionType: 'correction', eventStatus: 'occurred', domains: ['health'], concepts: [], confidence: 0.9 };
  const correctionRels = deriveRelations(correction, { supersedesAssertionId: 'prior-id-2' });
  assert.ok(correctionRels.some((r) => r.relationship === 'supersedes' && r.targetId === 'prior-id-2'));
});
