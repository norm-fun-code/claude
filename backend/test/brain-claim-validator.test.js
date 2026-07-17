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

// ── Recovery causation (Bug 2: bind context to the night it describes) ──────
const FACTS_WITH_DRIVER = { ...FACTS, recoveryDrivers: ['Drank wine'] };
const FACTS_NO_DRIVER = { ...FACTS, recoveryDrivers: [] };

test('general context cannot become a recovery cause: no eligible driver, but the brief guesses one anyway', () => {
  const { violations, hasHighSeverity } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery dipped to 41 because of the big presentation you have today.' }),
    FACTS_NO_DRIVER
  );
  assert.ok(violations.some((v) => v.check === 'recovery_cause'));
  assert.ok(hasHighSeverity);
});

test('a genuinely eligible recovery driver may explain recovery without being flagged', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery dipped to 41 because of the wine last night — HRV took the hit.' }),
    FACTS_WITH_DRIVER
  );
  assert.ok(!violations.some((v) => v.check === 'recovery_cause'));
});

test('an eligible driver exists, but the brief cites something else entirely — still flagged', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ risk: 'Your recovery is down today, likely driven by the stressful week at work.' }),
    FACTS_WITH_DRIVER
  );
  assert.ok(violations.some((v) => v.check === 'recovery_cause'));
});

test('a non-causal recovery sentence (no cause asserted) is never flagged', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery is 41/100 today, in the red band.' }),
    FACTS_NO_DRIVER
  );
  assert.ok(!violations.some((v) => v.check === 'recovery_cause'));
});

test('neutralizing a recovery_cause violation removes the fabricated cause, not the whole field', () => {
  const { neutralizeClaimViolations } = require('../src/brain/claimValidator');
  const result = brief({ synthesis: 'Recovery is 41 today. Recovery dipped because of the big presentation today.' });
  const { violations } = validateChiefBriefClaims(result, FACTS_NO_DRIVER);
  const cleaned = neutralizeClaimViolations(result, violations, FACTS_NO_DRIVER);
  assert.match(cleaned.chiefBrief.synthesis, /Recovery is 41 today/);
  assert.doesNotMatch(cleaned.chiefBrief.synthesis, /big presentation/);
});

test('absent facts.recoveryDrivers (older/partial facts object) never triggers recovery_cause', () => {
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery dipped because of a rough week.' }),
    FACTS // no recoveryDrivers key at all
  );
  assert.ok(!violations.some((v) => v.check === 'recovery_cause'));
});

// ── Audit fix: lexical-overlap alone could be satisfied by generic/temporal
// words ("last night") even when the actual CAUSE differs from the eligible
// driver's. checkRecoveryCause now primarily matches on canonical cause-
// concept tags (context-semantics.js's causeConceptTags), not raw shared
// vocabulary. ─────────────────────────────────────────────────────────────

test('reproduction: eligible driver "drank wine last night" does NOT ground a claim of "a late meal last night" — different causes, same generic wording', () => {
  const facts = { ...FACTS, recoveryDrivers: ['drank wine last night'] };
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery dipped because of a late meal last night.' }),
    facts
  );
  assert.ok(violations.some((v) => v.check === 'recovery_cause'),
    'a different cause concept (late_meal) must be rejected even though it shares "last night" with the eligible driver (alcohol)');
});

test('a claim correctly citing the SAME cause concept as the eligible driver is grounded', () => {
  const facts = { ...FACTS, recoveryDrivers: ['drank wine last night'] };
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery dipped because of the wine last night.' }),
    facts
  );
  assert.ok(!violations.some((v) => v.check === 'recovery_cause'));
});

test('a claim citing the same cause concept in different words (still matching the concept regex) is grounded', () => {
  const facts = { ...FACTS, recoveryDrivers: ['a couple of drinks last night'] };
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery is down, likely driven by the alcohol last night.' }),
    facts
  );
  assert.ok(!violations.some((v) => v.check === 'recovery_cause'));
});

// ── Audit3 fix 3: recognized-but-conflicting cause concepts must NOT be
// rescued by lexical fallback. "a stressful deadline at work" (stress) and
// "an intense training session at work" (hard_training) share the word
// "work" — the old lexical-overlap fallback (which ran whenever tag matching
// merely FAILED, not only when the claim had zero tags) could let that
// shared vocabulary paper over two genuinely different, both-recognized
// cause concepts. ────────────────────────────────────────────────────────

test('a recognized stress driver does NOT ground a recognized hard-training claim, even sharing the word "work"', () => {
  const facts = { ...FACTS, recoveryDrivers: ['a stressful deadline at work'] };
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery dipped because of an intense training session at work.' }),
    facts
  );
  assert.ok(violations.some((v) => v.check === 'recovery_cause'),
    'stress and hard_training are both recognized concepts and do not overlap — must be rejected deterministically, not rescued by shared incidental vocabulary ("work")');
});

test('a recognized hard-training driver does NOT ground a recognized stress claim, even sharing incidental words', () => {
  const facts = { ...FACTS, recoveryDrivers: ['an unusual training session at the office'] };
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery dipped because of a stressful deadline at the office.' }),
    facts
  );
  assert.ok(violations.some((v) => v.check === 'recovery_cause'));
});

test('the wine-versus-late-meal protection still holds (both recognized, non-overlapping concepts)', () => {
  const facts = { ...FACTS, recoveryDrivers: ['drank wine last night'] };
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery dipped because of a late meal last night.' }),
    facts
  );
  assert.ok(violations.some((v) => v.check === 'recovery_cause'));
});

test('two different eligible drivers: a claim naming EITHER concept is grounded, a third concept is not', () => {
  const facts = { ...FACTS, recoveryDrivers: ['drank wine last night', 'stressful argument before bed'] };
  const stressClaim = brief({ synthesis: 'Recovery dipped because of the argument last night.' });
  assert.ok(!validateChiefBriefClaims(stressClaim, facts).violations.some((v) => v.check === 'recovery_cause'));

  const travelClaim = brief({ synthesis: 'Recovery dipped because of the flight last night.' });
  assert.ok(validateChiefBriefClaims(travelClaim, facts).violations.some((v) => v.check === 'recovery_cause'),
    'travel was never an eligible driver — must still be rejected');
});
