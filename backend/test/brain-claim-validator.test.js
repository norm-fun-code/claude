// Semantic claim validator — the generalization of the goal-completion guard.
// The LLM picks wording; it may NOT invent or recompute canonical facts. These
// tests prove the validator catches each contradiction class against known
// facts AND — just as important — stays silent on a brief that describes the
// same facts correctly (a false positive would corrupt good output).
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateChiefBriefClaims } = require('../src/brain/claimValidator');

const FACTS = {
  localDate: '2026-06-11',
  recoveryScore: 41,
  recoveryBand: 'red',
  recoveryProxy: false,
  effectiveWorkoutLabel: 'Mobility',
  effectiveWorkoutSource: 'auto_downgrade',
  scheduledWorkoutLabel: 'Push',
  forecastGrade: 'B-',
  goals: [{ text: 'Ship the wealth reconciler', achieved: false }],
  commitments: [{ title: 'Call the accountant', status: 'open' }],
  experiments: [{ hypothesis: 'Magnesium improves deep sleep', status: 'running', verdict: null }],
  spendingTotalMonth: 2450,
};
const brief = (fields) => ({ chiefBrief: fields });

test('catches a recovery band contradiction (says green when band is red)', () => {
  const { violations, hasHighSeverity } = validateChiefBriefClaims(
    brief({ synthesis: 'Your recovery is green today — full send on training.' }), FACTS);
  assert.ok(violations.some((v) => v.check === 'recovery_band'));
  assert.ok(hasHighSeverity);
});

test('catches a recovery score contradiction (cites 78 when it is 41)', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ action: 'With a recovery score of 78 you can push hard.' }), FACTS);
  assert.ok(violations.some((v) => v.check === 'recovery_score'));
});

test('catches prescribing the scheduled hard session after an auto-downgrade', () => {
  const { violations, hasHighSeverity } = validateChiefBriefClaims(
    brief({ action: 'Crush your Push session today.' }), FACTS);
  assert.ok(violations.some((v) => v.check === 'effective_workout'));
  assert.ok(hasHighSeverity);
});

test('catches claiming a still-open goal is done', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Nice — the wealth reconciler is shipped and done.' }), FACTS);
  assert.ok(violations.some((v) => v.check === 'goal_completion'));
});

test('catches claiming a still-open commitment is complete', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ risk: 'Now that the accountant call is finished, move on.' }), FACTS);
  assert.ok(violations.some((v) => v.check === 'commitment_completion'));
});

test('catches calling a not-yet-confirmed experiment confirmed', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'The magnesium improves deep sleep hypothesis is confirmed.' }), FACTS);
  assert.ok(violations.some((v) => v.check === 'experiment_verdict'));
});

test('catches a wildly wrong monthly spend total', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'You have spent $9,900 total this month.' }), FACTS);
  assert.ok(violations.some((v) => v.check === 'spending_total'));
});

// The critical no-false-positive guarantee: a brief that acknowledges the
// downgrade, the red band, and the OPEN goal must pass clean.
test('a brief that states every fact correctly produces ZERO violations', () => {
  const good = brief({
    synthesis: 'Recovery is in the red at 41 — last night was rough.',
    action: "Your Push got eased down to Mobility today; keep it gentle and walk.",
    risk: 'The wealth reconciler is still open; protect a focus block for it.',
    move: 'Call the accountant is still on your plate — knock it out before noon.',
  });
  const { violations, hasHighSeverity } = validateChiefBriefClaims(good, FACTS);
  assert.deepEqual(violations, []);
  assert.equal(hasHighSeverity, false);
});

// Backward compatibility: no facts → no-op (existing callers keep working).
test('null facts is a no-op (backward compatible)', () => {
  const { violations, hasHighSeverity } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery is green.' }), null);
  assert.deepEqual(violations, []);
  assert.equal(hasHighSeverity, false);
});

// ── Added checks (audit follow-up) ───────────────────────────────────────────

test('catches a forecast day-grade contradiction (calls it an A day when grade is B-)', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: "Today's an A day per the forecast — capitalize on it." }),
    { ...FACTS, forecastGrade: 'B-' });
  assert.ok(violations.some((v) => v.check === 'forecast_grade'));
});

test('catches a tomorrow-lean contradiction (says tomorrow looks red when forecast leans green)', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ risk: 'The forecast says tomorrow looks red, so bank rest tonight.' }),
    { ...FACTS, tomorrowBand: 'green' });
  assert.ok(violations.some((v) => v.check === 'forecast_tomorrow'));
});

test('catches an explicit wrong-weekday claim (2026-06-11 is Thursday)', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Happy Monday — big week ahead.' }), FACTS);
  assert.ok(violations.some((v) => v.check === 'current_date'));
});

test('does NOT flag an incidental reference to another day ("by Friday")', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ action: 'Aim to close the reconciler by Friday.' }), FACTS);
  assert.ok(!violations.some((v) => v.check === 'current_date'));
});

test('flags a spend total off by ~18% (old 20% tolerance would have waved it through)', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'You have spent $2,900 total this month.' }), FACTS); // truth 2450, +18%
  assert.ok(violations.some((v) => v.check === 'spending_total'));
});

test('tolerates display rounding within 2% ($2,450 → "$2,460")', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'You have spent about $2,460 total this month.' }), FACTS);
  assert.ok(!violations.some((v) => v.check === 'spending_total'));
});

test('catches prescribing the scheduled session after a MANUAL override (scheduled baseline present)', () => {
  const overrideFacts = {
    ...FACTS,
    effectiveWorkoutLabel: 'Rest', effectiveWorkoutSource: 'override', scheduledWorkoutLabel: 'Push',
  };
  const { violations } = validateChiefBriefClaims(
    brief({ action: 'Crush your Push session today.' }), overrideFacts);
  assert.ok(violations.some((v) => v.check === 'effective_workout'));
});

test('neutralizeClaimViolations strips the offending sentence, keeping the rest', () => {
  const { neutralizeClaimViolations } = require('../src/brain/claimValidator');
  const result = brief({ synthesis: 'Recovery is red at 41. Your recovery is green today.' });
  const { violations } = validateChiefBriefClaims(result, FACTS);
  const cleaned = neutralizeClaimViolations(result, violations);
  assert.match(cleaned.chiefBrief.synthesis, /Recovery is red at 41/);
  assert.doesNotMatch(cleaned.chiefBrief.synthesis, /green/);
  // Original is not mutated.
  assert.match(result.chiefBrief.synthesis, /green/);
});
