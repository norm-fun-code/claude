// Unit coverage for brain/claimValidator.js's checkWeeklyEventCounts — the
// deterministic guard that fixes the Weekly Review bug where generated text
// claimed "two nights of alcohol + late meals (Wed/Thu)" when the canonical
// weekly event ledger (intelligence/weeklyLedger.js) supported only one
// episode. Fully general: driven by causeConceptTags (the same vocabulary
// checkRecoveryCause already uses) — nothing here is alcohol-specific.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkWeeklyEventCounts, validateClaims } = require('../src/brain/claimValidator');

function ledgerWith(episodes) {
  return { weeklyLedger: { periodStart: '2026-07-13', periodEnd: '2026-07-20', episodes } };
}

test('checkWeeklyEventCounts is a no-op when facts.weeklyLedger is absent (backward compatible)', () => {
  assert.deepEqual(checkWeeklyEventCounts([['narrative', 'Two nights of alcohol this week.']], {}), []);
  assert.deepEqual(checkWeeklyEventCounts([['narrative', 'Two nights of alcohol this week.']], { recoveryBand: 'red' }), []);
});

test('checkWeeklyEventCounts is silent on a sentence naming no recognized concept', () => {
  const facts = ledgerWith([{ nightOf: '2026-07-15', concepts: ['alcohol', 'late_meal'] }]);
  const violations = checkWeeklyEventCounts([['narrative', 'Two great meetings this week.']], facts);
  assert.deepEqual(violations, []);
});

// ── Required test 6: an evidence-backed association is valid ────────────

test('required test 6a: a correctly-supported single-night claim is VALID (no violation)', () => {
  const facts = ledgerWith([{ nightOf: '2026-07-15', concepts: ['alcohol', 'late_meal'] }]);
  const violations = checkWeeklyEventCounts(
    [['narrative', 'One night this week combined alcohol and a late meal — Wednesday.']],
    facts
  );
  assert.deepEqual(violations, []);
});

// ── Required test 6: unsupported causal/count language is rejected ──────

test('required test 6b: "two nights" claimed against a one-episode ledger is REJECTED', () => {
  const facts = ledgerWith([{ nightOf: '2026-07-15', concepts: ['alcohol', 'late_meal'] }]);
  const violations = checkWeeklyEventCounts(
    [['narrative', 'You had two nights of alcohol and late meals this week.']],
    facts
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].check, 'weekly_event_count');
  assert.equal(violations[0].expected, 1);
  assert.equal(violations[0].actual, 2);
});

test('required test 6c: naming two distinct weekdays for one concept ("Wed/Thu") is REJECTED against a one-episode ledger', () => {
  const facts = ledgerWith([{ nightOf: '2026-07-15', concepts: ['alcohol'] }]);
  const violations = checkWeeklyEventCounts(
    [['narrative', 'Alcohol showed up Wednesday and Thursday this week.']],
    facts
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].expected, 1);
  assert.equal(violations[0].actual, 2);
});

test('a correctly-supported two-night claim does NOT fire (genuinely two separate episodes)', () => {
  const facts = ledgerWith([
    { nightOf: '2026-07-15', concepts: ['alcohol'] },
    { nightOf: '2026-07-17', concepts: ['alcohol'] },
  ]);
  const violations = checkWeeklyEventCounts(
    [['narrative', 'Two nights of alcohol this week.']],
    facts
  );
  assert.deepEqual(violations, []);
});

test('checkWeeklyEventCounts generalizes to a non-alcohol concept (stress) — not alcohol-specific', () => {
  const facts = ledgerWith([{ nightOf: '2026-07-15', concepts: ['stress'] }]);
  const violations = checkWeeklyEventCounts(
    [['narrative', 'Three evenings of stress and an argument this week.']],
    facts
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].expected, 1);
  assert.equal(violations[0].actual, 3);
});

test('a claimed count of zero nights against a real episode still checks (numeric literal supported)', () => {
  const facts = ledgerWith([{ nightOf: '2026-07-15', concepts: ['alcohol'] }]);
  const violations = checkWeeklyEventCounts(
    [['narrative', '0 nights of alcohol this week — a clean week.']],
    facts
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].expected, 1);
  assert.equal(violations[0].actual, 0);
});

// ── Integration through validateClaims (the shared entrypoint) ──────────

test('validateClaims runs checkWeeklyEventCounts when facts.weeklyLedger is present', () => {
  const facts = ledgerWith([{ nightOf: '2026-07-15', concepts: ['alcohol', 'late_meal'] }]);
  const violations = validateClaims(
    [['narrative', 'Two nights of alcohol and late meals this week (Wed/Thu).']],
    facts
  );
  assert.ok(violations.some((v) => v.check === 'weekly_event_count'));
});

test('validateClaims does not run checkWeeklyEventCounts for a Chief-Brief-style facts object with no weeklyLedger', () => {
  const facts = { recoveryBand: 'green' };
  const violations = validateClaims(
    [['answer', 'Two nights of alcohol and late meals this week.']],
    facts
  );
  assert.deepEqual(violations, []);
});
