// The two false positives that degraded every morning brief for a week.
//
// Symptom: the Chief of Staff card showed "Simplified brief — today's numbers,
// briefly stated" above one-line stubs ("Recovery is yellow at 50 today.",
// "Today's plan: Recovery + Mobility.") instead of the real brief. Every build
// ended in semantic_correction_retry_contradicted: a high-severity claim
// violation forces a correction retry, the retry contradicts again, and
// finalizeSafe replaces the flagged fields with grounded fallbacks.
//
// Both violations were the validator's fault, not the model's — and both were
// STRUCTURAL, so they fired essentially every day rather than occasionally.
// These tests pin each false positive and, just as importantly, pin that the
// genuine catches each check exists for still fire.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateChiefBriefClaims } = require('../src/brain/claimValidator');

const facts = (over = {}) => ({
  recoveryScore: 50, recoveryBand: 'yellow', recoveryDrivers: [], ...over,
});
/** Violations of one check for a single synthesis sentence. */
function check(name, sentence, f = facts()) {
  const { violations } = validateChiefBriefClaims(
    { chiefBrief: { synthesis: sentence, action: 'x', risk: 'x', move: 'x' } }, f
  );
  return violations.filter((v) => v.check === name);
}

// --- recovery_score: a workout name plus a duration is not a score ---------

test('a recovery-type workout followed by a duration is not a recovery score', () => {
  // THE production sentence. "Recovery + Mobility (20-30 min)" was read as
  // "recovery score 20" — 30 points off the real 50 — because the old pattern
  // allowed any digits within 20 non-digit characters of the word "recovery".
  // The plan's own workout is literally called "Recovery + Mobility", so this
  // fired on essentially every recovery day.
  assert.deepEqual(
    check('recovery_score', "Lean into today's scheduled Recovery + Mobility (20–30 min) — nothing more is needed given the yellow reading."),
    []
  );
});

test('other durations near the word recovery are not scores either', () => {
  for (const s of [
    'Recovery + Mobility for 30 minutes is the plan.',
    'Keep the recovery work to 20 min today.',
    'Recovery ride, 45 mins, easy pace.',
    'Recovery + Mobility (2 sets) then done.',
  ]) {
    assert.deepEqual(check('recovery_score', s), [], `false positive on: ${s}`);
  }
});

test('a genuinely wrong cited score is still caught', () => {
  // The whole point of the check. Every one of these must still fire.
  for (const s of [
    'Your recovery score of 72 means you can push today.',
    'Recovery came in at 72/100 this morning.',
    'Recovery is at 20 today, deep in the red.',
    'Readiness score: 85 — green light.',
  ]) {
    const v = check('recovery_score', s);
    assert.equal(v.length, 1, `missed a real wrong score in: ${s}`);
    assert.equal(v[0].expected, 50);
  }
});

test('a correctly cited score is not flagged', () => {
  assert.deepEqual(check('recovery_score', 'Recovery score of 50 today.'), []);
  assert.deepEqual(check('recovery_score', 'Recovery came in at 52/100 — within tolerance.'), []);
});

// --- recovery_cause: saying "unknown" is compliance, not a violation ------

test('explicitly disclaiming a cause is not asserting one', () => {
  // THE production sentence. It trips CAUSAL_RE purely on the word "explain"
  // inside "rather than explain" — while saying exactly what this check's own
  // error message asks for ("should say the cause is unknown instead of
  // guessing"). Complying with the contract must never violate it.
  assert.deepEqual(
    check('recovery_cause', "HRV came in at 40ms this morning versus your 7-day average of 42.8ms — the dip is real but the cause is unknown, no eligible driver identified today, so it's one to watch rather than explain."),
    []
  );
});

test('the common ways of saying "we do not know why" all pass', () => {
  for (const s of [
    'Recovery dipped and there is no clear driver in the data today.',
    'The yellow reading is unexplained by anything eligible.',
    "Recovery is down but the cause isn't clear from today's context.",
    'Recovery dropped; no eligible driver was identified.',
    'HRV is low and the reason remains unknown.',
  ]) {
    assert.deepEqual(check('recovery_cause', s), [], `false positive on: ${s}`);
  }
});

test('a disclaimer cannot smuggle an ungrounded cause past the check', () => {
  // The guard is narrow on purpose: it only applies when the sentence names NO
  // recognized cause concept. Naming one is an attribution regardless of how
  // it is hedged, and must still be policed.
  const v = check('recovery_cause', 'Recovery dipped — the cause is unknown, though probably the wine last night drove it.');
  assert.equal(v.length, 1, 'a hedged but named cause must still be caught');
});

test('a cause that contradicts the eligible driver is still caught', () => {
  const v = check(
    'recovery_cause',
    'Recovery dipped; no clear driver, but the late meal is likely behind this.',
    facts({ recoveryDrivers: ['drank wine last night'] })
  );
  assert.equal(v.length, 1);
});

test('an invented cause with no drivers at all is still caught', () => {
  assert.equal(check('recovery_cause', 'Recovery dipped because of the wine last night.').length, 1);
});

test('a cause grounded in a real eligible driver is not flagged', () => {
  assert.deepEqual(
    check('recovery_cause', 'Recovery dipped because of the wine last night.', facts({ recoveryDrivers: ['drank wine last night'] })),
    []
  );
});

// --- the combination that actually shipped --------------------------------

test('a realistic recovery-day brief produces no high-severity violations', () => {
  // Both production sentences together, as they appeared in the real build,
  // plus a workout action. Before the fix this produced two high-severity
  // violations, which is what forced the correction retry and ultimately
  // replaced the card with stubs.
  const { violations, hasHighSeverity } = validateChiefBriefClaims({
    chiefBrief: {
      synthesis: "Recovery dropped to 50 (yellow band) with HRV at 40ms overnight, and the cause isn't clear from anything eligible today.",
      action: "Lean into today's scheduled Recovery + Mobility (20–30 min) — nothing more is needed given the yellow reading.",
      risk: 'Worth protecting rather than stacking a heavy evening on top of it.',
      move: "HRV came in at 40ms versus your 7-day average of 42.8ms — the dip is real but the cause is unknown, one to watch rather than explain.",
    },
  }, facts());
  assert.equal(hasHighSeverity, false, `unexpected: ${JSON.stringify(violations.map((v) => [v.check, v.sentence]))}`);
});

// --- the diagnostics must never carry the prose they describe -------------

test('stripQualityProse removes the violating sentences and nothing else', () => {
  // The quality verdict carries the model's actual sentences in-process, so an
  // admin dry-run can explain a degrade. That prose must never be persisted:
  // neutralization exists precisely so a contradicting sentence never ships,
  // and storing it inside the verdict would route it back into stored content
  // through the diagnostics. (An existing integration test — DEG 7 — enforces
  // the same contract end to end; this pins the helper itself.)
  const { stripQualityProse } = require('../src/brain/claimValidator');
  const quality = {
    status: 'degraded',
    reasonCodes: ['grounded_fallback_used'],
    violatedChecks: ['goal_completion'],
    neutralizedFields: ['synthesis'],
    fieldWordCounts: { synthesis: 8 },
    failedAttempt: 'semantic_correction_retry_contradicted',
    violationDetails: [{ check: 'goal_completion', field: 'synthesis', sentence: 'the Q3 report is done' }],
  };
  const stored = stripQualityProse(quality);
  assert.ok(!('violationDetails' in stored), 'prose must not survive into stored state');
  assert.ok(!JSON.stringify(stored).includes('Q3 report is done'));
  // Everything a consumer legitimately reads must be untouched.
  assert.equal(stored.status, 'degraded');
  assert.deepEqual(stored.violatedChecks, ['goal_completion']);
  assert.deepEqual(stored.neutralizedFields, ['synthesis']);
  assert.equal(stored.failedAttempt, 'semantic_correction_retry_contradicted');
  // And the original is not mutated — callers still need the details.
  assert.equal(quality.violationDetails.length, 1);
});

test('stripQualityProse is null/shape safe', () => {
  const { stripQualityProse } = require('../src/brain/claimValidator');
  assert.equal(stripQualityProse(null), null);
  assert.equal(stripQualityProse(undefined), null);
  assert.deepEqual(stripQualityProse({ status: 'fresh' }), { status: 'fresh' });
});
