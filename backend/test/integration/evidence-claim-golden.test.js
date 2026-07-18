// EvidenceClaim v1 — golden cross-surface tests. Proves Chief Brief, Evening
// Brief, and Ask cannot contradict the SAME canonical fact: each scenario
// builds ONE shared facts/claims packet (from real DB state where the
// scenario needs it — commitments via the real store, a real workout
// override via getEffectiveWorkout — and via context-resolver.js's
// buildResolvedContext elsewhere, the same pure-construction pattern
// test/brain-claim-validator-resolved-context.test.js already uses for
// ResolvedContext scenarios), then feeds ONE deliberately-contradictory
// sentence through every surface whose content scope could plausibly state
// that kind of claim, and asserts they ALL catch/neutralize it identically.
//
// Evening Brief's content scope is intentionally narrower than Chief
// Brief/Ask (see notify/evening-brief.js's own SYSTEM prompt: it never
// discusses recovery scores, spending, forecasts, or training-pattern
// associations — only readiness/steps/plan-completion/tomorrow's wind-down).
// Scenarios outside that scope are proven consistent across Chief+Ask only,
// and say so explicitly — this is the surface's designed boundary, not a
// gap the audit asked to close (see the task's own scope: "migrate Evening
// Brief and typed Ask first... do not yet migrate every push").
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const claimValidator = require('../../src/brain/claimValidator');
const evb = require('../../src/notify/evening-brief-validator');
const { buildEvidenceClaims, isClaimStale } = require('../../src/brain/evidenceClaim');
const { canonicalFactsFrom } = require('../../src/brain/snapshot');
const { buildResolvedContext } = require('../../src/intelligence/context-resolver');
const commitmentsStore = require('../../src/store/commitments');

const NOW = new Date('2026-07-18T15:00:00Z');
const MARKER = `golden-${Date.now()}`;

after(async () => { await closeDb(); });

// Chief Brief wraps its checkable text in a chiefBrief-shaped result; the
// OTHER three required fields must be non-empty so briefFields() doesn't
// treat this as a shape failure — only `synthesis` carries the scenario's
// contradiction.
function chiefResult(synthesis) {
  return { chiefBrief: { synthesis, action: 'Stay the course today.', risk: 'Nothing flagged.', move: 'No change to note.' } };
}
function eveningResult(today) {
  return { today, plan: '', tomorrow: '', readiness: '' };
}

// ── Scenario 1: recovery + a corrected/retracted context item ─────────────
test('scenario 1 — a retracted context item cited as fact is caught on Chief, Evening, and Ask alike', () => {
  const resolvedContext = buildResolvedContext({
    assertions: [{ id: 'a1', predicate: 'went out for', objectValue: 'drinks with coworkers', rawText: 'went out for drinks with coworkers', eventStatus: 'retracted', domains: ['health'] }],
    relations: [],
    tz: 'America/New_York', now: NOW,
  });
  const facts = canonicalFactsFrom({ recovery: { band: 'yellow' }, resolvedContext });
  facts.claims = buildEvidenceClaims(facts);
  const sentence = 'Since you went out for drinks with coworkers last night, ease into today gently.';

  const chief = claimValidator.validateChiefBriefClaims(chiefResult(sentence), facts);
  const ask = claimValidator.validateClaims([['answer', sentence]], facts);
  const evening = evb.validateEveningBriefClaims(eveningResult(sentence), { evidenceGoals: [], commitments: {}, resolvedContext });

  assert.ok(chief.violations.some((v) => v.check === 'negated_event_cited'), 'Chief Brief catches the retracted event');
  assert.ok(ask.some((v) => v.check === 'negated_event_cited'), 'Ask catches the same retracted event');
  assert.ok(evening.some((v) => v.check === 'negated_event_cited'), 'Evening Brief catches the same retracted event');
});

// ── Scenario 2: rest-day / workout override ────────────────────────────────
test('scenario 2 — a workout overridden to rest is never described as the original hard session, on Chief/Ask; Evening Brief never claims a workout that did not happen', () => {
  const facts = canonicalFactsFrom({
    effectiveWorkout: { label: 'Mobility', source: 'override', scheduledLabel: 'Push', workoutId: 'mobility' },
  });
  facts.claims = buildEvidenceClaims(facts);
  const sentence = 'Time to crush today\'s Push session — go hard on it.';

  const chief = claimValidator.validateChiefBriefClaims(chiefResult(sentence), facts);
  const ask = claimValidator.validateClaims([['answer', sentence]], facts);
  assert.ok(chief.violations.some((v) => v.check === 'effective_workout'), 'Chief Brief catches the stale scheduled-session prescription');
  assert.ok(ask.some((v) => v.check === 'effective_workout'), 'Ask catches the same stale prescription');

  // Evening Brief's own version of "the workout override is the truth": it
  // never lets prose describe today's steps/movement as a completed hard
  // workout when no training session was actually logged (training.completed
  // is derived from the SAME override-aware effective-workout resolution
  // upstream in notify/evening-brief.js's runEveningHealthBrief).
  const eveningFacts = { training: { completed: false }, isRestDay: true, load: { steps: 9000, stepsBaseline: 7000 } };
  const eveningViolations = evb.validateEveningBriefClaims(
    eveningResult('You crushed a hard workout today — great structured training session.'),
    eveningFacts
  );
  assert.ok(eveningViolations.some((v) => v.check === 'steps_described_as_workout'), 'Evening Brief catches steps described as a completed hard workout');
});

// ── Scenario 3: incomplete vs completed commitment ─────────────────────────
test('scenario 3 — a still-open commitment described as done is caught on Chief, Evening, and Ask alike (real DB row)', async () => {
  const row = await commitmentsStore.create({ title: `${MARKER} call the accountant`, source: 'test' });
  try {
    const commitments = await commitmentsStore.listActive({ limit: 20 });
    const facts = canonicalFactsFrom({ commitments });
    facts.claims = buildEvidenceClaims(facts);
    const sentence = `${MARKER} call the accountant is done — great follow-through today.`;

    const chief = claimValidator.validateChiefBriefClaims(chiefResult(sentence), facts);
    const ask = claimValidator.validateClaims([['answer', sentence]], facts);
    const evening = evb.validateEveningBriefClaims(
      eveningResult(sentence),
      { evidenceGoals: [], commitments: { done: [], open: commitments.map((c) => ({ title: c.title })), skipped: [] }, resolvedContext: null }
    );

    assert.ok(chief.violations.some((v) => v.check === 'commitment_completion'), 'Chief Brief catches the false completion');
    assert.ok(ask.some((v) => v.check === 'commitment_completion'), 'Ask catches the same false completion');
    assert.ok(evening.some((v) => v.check === 'commitment_completion'), 'Evening Brief catches the same false completion');
  } finally {
    await db.query('DELETE FROM commitments WHERE id = $1', [row.id]);
  }
});

// ── Scenario 4: canonical MTD spending ─────────────────────────────────────
test('scenario 4 — a spending figure that disagrees with the canonical MTD total is caught on Chief and Ask (Evening Brief never discusses spending)', () => {
  const facts = canonicalFactsFrom({ wealth: { spendingMtd: 1500 } });
  facts.claims = buildEvidenceClaims(facts);
  const sentence = 'Heads up — you\'ve spent a total of $4,200 this month so far.';

  const chief = claimValidator.validateChiefBriefClaims(chiefResult(sentence), facts);
  const ask = claimValidator.validateClaims([['answer', sentence]], facts);
  assert.ok(chief.violations.some((v) => v.check === 'spending_total'), 'Chief Brief catches the wrong MTD total');
  assert.ok(ask.some((v) => v.check === 'spending_total'), 'Ask catches the same wrong MTD total');
});

// ── Scenario 5: calendar load / Sabbath-block reclassification ────────────
test('scenario 5 — a block the user reclassified as not-a-meeting is never counted as meeting load, on Chief and Ask (Evening Brief never discusses calendar load)', () => {
  const { normalizeTargetId } = require('../../src/intelligence/context-compiler');
  const subject = '6:00-7:30 PM block';
  const resolvedContext = buildResolvedContext({
    assertions: [{
      id: 'a1', assertionType: 'classification', subject, predicate: 'is',
      objectValue: 'a Sabbath observance, not meetings', rawText: "that's a Sabbath observance, not meetings",
      eventStatus: 'occurred', domains: ['calendar'],
    }],
    relations: [{
      id: 'r1', sourceAssertionId: 'a1', targetType: 'calendar_event', targetId: normalizeTargetId(subject),
      relationship: 'classifies', evidenceBasis: 'user_explicit', confidence: 0.9,
      permittedLanguage: 'a Sabbath observance, not meetings',
      unresolved: false, resolvedAt: null, retiredAt: null, createdAt: NOW.toISOString(),
    }],
    tz: 'America/New_York', now: NOW,
  });
  const facts = canonicalFactsFrom({ resolvedContext });
  facts.claims = buildEvidenceClaims(facts);
  const sentence = 'Today includes the 6:00-7:30 PM block as part of a packed schedule of back-to-back meetings.';

  const chief = claimValidator.validateChiefBriefClaims(chiefResult(sentence), facts);
  const ask = claimValidator.validateClaims([['answer', sentence]], facts);
  assert.ok(chief.violations.some((v) => v.check === 'calendar_classification'), 'Chief Brief catches the stale meeting-load framing');
  assert.ok(ask.some((v) => v.check === 'calendar_classification'), 'Ask catches the same stale meeting-load framing');
});

// ── Scenario 6: stale/expired context ──────────────────────────────────────
test('scenario 6 — an EvidenceClaim past its own expiresAt is flagged stale identically regardless of which surface asks', () => {
  const resolvedContext = buildResolvedContext({
    assertions: [{ id: 'a1', predicate: 'traveling for', objectValue: 'a work trip', rawText: 'traveling for a work trip', eventStatus: 'occurred', domains: ['other'],
      effectiveStart: '2026-07-01T00:00:00Z', effectiveEnd: '2026-07-03T00:00:00Z' }],
    relations: [],
    tz: 'America/New_York', now: new Date('2026-07-02T12:00:00Z'), // build it while still "current"...
  });
  const facts = canonicalFactsFrom({ resolvedContext });
  const claims = buildEvidenceClaims(facts);
  const travelClaim = claims.find((c) => c.subject === 'assertion:a1' && c.predicate === 'eventStatus');
  assert.ok(travelClaim, 'the assertion produced its own EvidenceClaim');
  assert.equal(travelClaim.expiresAt, '2026-07-03T00:00:00Z');

  // ...then ask "is this stale" from an asOf well after it expired (July 18,
  // this file's NOW) — Chief Brief, Evening Brief, and Ask would each
  // consult facts.claims via this SAME pure function, so there is only one
  // possible answer, not three independently-derived ones.
  assert.equal(isClaimStale(travelClaim, new Date('2026-07-01T00:00:00Z')), false, 'not yet stale mid-trip');
  assert.equal(isClaimStale(travelClaim, NOW), true, 'stale two weeks after the trip ended');
});

// ── Scenario 7: an observational pattern must not become a causal claim ───
test('scenario 7 — a supported-association recovery driver overclaimed as "proven"/"confirmed" is caught on Chief and Ask (Evening Brief never discusses recovery drivers)', () => {
  const facts = canonicalFactsFrom({ recoveryDrivers: ['drank wine last night'] });
  facts.claims = buildEvidenceClaims(facts);
  const sentence = 'It\'s now confirmed and proven that drank wine last night is the cause of every dip in your recovery.';

  const chief = claimValidator.validateChiefBriefClaims(chiefResult(sentence), facts);
  const ask = claimValidator.validateClaims([['answer', sentence]], facts);
  assert.ok(chief.violations.some((v) => v.check === 'association_overclaim'), 'Chief Brief catches the overclaimed association');
  assert.ok(ask.some((v) => v.check === 'association_overclaim'), 'Ask catches the same overclaimed association');
});
