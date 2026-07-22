// checkTemporalFraming — the deterministic backstop for the production
// temporal-grounding bug: "the late-meal flag tonight can dent sleep" / "with
// a late meal on deck tonight" were generated from a historical (2-nights-ago)
// context tag with no validator to catch the "historical observation
// rewritten as an invented future plan" error. Generic by design: works for
// ANY concept intelligence/context-semantics.js's causeConceptTags
// recognizes, never hardcodes late_meal.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkTemporalFraming, validateClaims, checkRecoveryCause } = require('../src/brain/claimValidator');

const FACTS = { localDate: '2026-07-22', resolvedContext: null };

function violationsFor(sentence, facts = FACTS) {
  return checkTemporalFraming([['synthesis', sentence]], facts);
}

// Required test 10 / "include the exact production phrases as fixtures":
// the two verbatim sentences from the real production incident.
test('the exact production phrase "the late-meal flag tonight can dent sleep" is rejected', () => {
  const v = violationsFor('The late-meal flag tonight can dent sleep quality.');
  assert.equal(v.length, 1);
  assert.equal(v[0].check, 'temporal_framing');
  assert.equal(v[0].severity, 'high');
  assert.ok(v[0].message.includes('late_meal'));
});

test('the exact production phrase "with a late meal on deck tonight" is rejected', () => {
  const v = violationsFor('With a late meal on deck tonight, sleep may run shorter.');
  assert.equal(v.length, 1);
  assert.equal(v[0].check, 'temporal_framing');
});

test('"you have drinks tonight" (alcohol) is rejected with no supporting evidence', () => {
  const v = violationsFor('You have drinks tonight with friends.');
  assert.equal(v.length, 1);
  assert.ok(v[0].message.includes('alcohol'));
});

test('"travel is planned tonight" is rejected with no supporting evidence', () => {
  const v = violationsFor('Travel is planned tonight, so pack early.');
  assert.equal(v.length, 1);
  assert.ok(v[0].message.includes('travel'));
});

// Required test 4: advisory language is allowed.
test('required test 4: "Avoid a late meal tonight." is allowed', () => {
  assert.deepEqual(violationsFor('Avoid a late meal tonight.'), []);
});

test('other non-assertive framings around a future+concept sentence are allowed', () => {
  for (const sentence of [
    'If you eat late tonight, expect worse sleep tomorrow.',
    'No late meal planned tonight.',
    "Skip drinks tonight to protect tomorrow's recovery.",
    "Try not to eat a heavy dinner tonight.",
  ]) {
    assert.deepEqual(violationsFor(sentence), [], `expected "${sentence}" to be allowed`);
  }
});

// A purely historical mention (no future marker at all) never fires — this
// is the exact kind of sentence RECENT CONTEXT TAGS is supposed to license.
test('a purely historical mention, even naming a concept, never fires (no future marker present)', () => {
  assert.deepEqual(violationsFor('A late meal two nights ago likely hurt your sleep score.'), []);
  assert.deepEqual(violationsFor('You drank last night, which may explain the dip.'), []);
});

// Required test 3: a REAL future assertion — a compiled planned
// ContextAssertion whose effective window overlaps today — permits the claim.
test('required test 3: a genuine planned ContextAssertion overlapping today permits the future claim', () => {
  const facts = {
    localDate: '2026-07-22',
    resolvedContext: {
      assertions: [
        { eventStatus: 'planned', concepts: ['late_meal'], effectiveStart: '2026-07-22T22:00:00Z', effectiveEnd: '2026-07-23T02:00:00Z' },
      ],
    },
  };
  assert.deepEqual(violationsFor("I'm planning a late dinner tonight.", facts), []);
});

test('a planned assertion for a DIFFERENT concept does not license an unrelated future claim', () => {
  const facts = {
    localDate: '2026-07-22',
    resolvedContext: {
      assertions: [
        { eventStatus: 'planned', concepts: ['travel'], effectiveStart: '2026-07-22T08:00:00Z', effectiveEnd: '2026-07-22T20:00:00Z' },
      ],
    },
  };
  const v = violationsFor('You have drinks tonight.', facts);
  assert.equal(v.length, 1, 'a travel plan must not license an alcohol claim');
});

test('a planned assertion for the right concept but NOT overlapping today does not license the claim', () => {
  const facts = {
    localDate: '2026-07-22',
    resolvedContext: {
      assertions: [
        { eventStatus: 'planned', concepts: ['late_meal'], effectiveStart: '2026-07-25T22:00:00Z', effectiveEnd: '2026-07-26T02:00:00Z' },
      ],
    },
  };
  const v = violationsFor('A late meal is on deck tonight.', facts);
  assert.equal(v.length, 1, 'a plan for a different day must not license a "tonight" claim today');
});

test('an OCCURRED (not planned) assertion never licenses a future claim, even same-concept same-day', () => {
  const facts = {
    localDate: '2026-07-22',
    resolvedContext: {
      assertions: [
        { eventStatus: 'occurred', concepts: ['late_meal'], effectiveStart: '2026-07-22T20:00:00Z', effectiveEnd: '2026-07-22T23:00:00Z' },
      ],
    },
  };
  const v = violationsFor('A late meal is on deck tonight.', facts);
  assert.equal(v.length, 1);
});

test('no facts at all -> no violations (backward-compatible no-op, same pattern as every other check)', () => {
  assert.deepEqual(checkTemporalFraming([['synthesis', 'You have drinks tonight.']], null), []);
});

test('checkTemporalFraming is wired into validateClaims (the shared surface-agnostic entrypoint)', () => {
  const violations = validateClaims([['synthesis', 'The late-meal flag tonight can dent sleep.']], FACTS);
  assert.ok(violations.some((v) => v.check === 'temporal_framing'));
});

// A concept mentioned with NO future framing at all (e.g. just naming the
// habit) is never flagged — the check only engages when BOTH a concept and a
// future marker are present in the same sentence.
test('a concept with no future/current framing at all is never flagged', () => {
  assert.deepEqual(violationsFor('Alcohol tends to lower your HRV the next morning.'), []);
});

// Required test 6: expired historical tags cannot drive current recovery.
// nightlyContextHistory (self-report tags) and recoveryDrivers (annotations,
// already filtered to the exact overnight window that produced TODAY's
// reading — see intelligence/recovery-drivers.js) are deliberately SEPARATE
// data sources. A context tag logged two nights ago living on in
// nightlyContextHistory must never leak into being treated as an eligible
// driver for today's recovery score merely because it's still in analytical
// history — checkRecoveryCause only ever consults facts.recoveryDrivers.
test('required test 6: a nightlyContextHistory occurrence from 2 nights ago cannot ground TODAY\'s recovery-cause claim', () => {
  const facts = {
    localDate: '2026-07-22',
    recoveryDrivers: [], // the overnight-window-filtered driver list is genuinely empty for TODAY
    nightlyContextHistory: [{
      tag: 'late_meal', label: 'Late meal', occurrences: [
        { concept: 'late_meal', status: 'occurred', nightEndingLocalDate: '2026-07-20', ageNights: 2, provenance: 'self_report', isCurrentOrFuturePlan: false },
      ],
    }],
  };
  const violations = checkRecoveryCause(
    [['synthesis', 'Recovery dipped today because of a late meal.']],
    facts
  );
  assert.ok(violations.some((v) => v.check === 'recovery_cause'),
    'a 2-night-old context tag must not be accepted as an eligible driver for today\'s recovery, even though it remains in nightlyContextHistory');
});
