// Behavioral proof for item 4: neutralizing a contradiction must NEVER leave a
// REQUIRED Chief Brief field (synthesis/action/risk/move) blank — a blank card
// reads as broken, which is worse than the false claim it replaced. Drives the
// REAL neutralizeClaimViolations + ensureRequiredFieldsPresent functions
// end-to-end against a single-sentence field where the ENTIRE content is the
// violation (the worst case: stripping the sentence would leave nothing).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateChiefBriefClaims, neutralizeClaimViolations, ensureRequiredFieldsPresent,
  REQUIRED_BRIEF_FIELDS,
} = require('../src/brain/claimValidator');

const FACTS = {
  localDate: '2026-06-11',
  recoveryScore: 41,
  recoveryBand: 'red',
  effectiveWorkoutLabel: 'Mobility',
  effectiveWorkoutSource: 'auto_downgrade',
  scheduledWorkoutLabel: 'Push',
  goals: [], commitments: [], experiments: [],
};

for (const field of REQUIRED_BRIEF_FIELDS) {
  test(`a single-sentence contradiction that IS the entire "${field}" field never ships blank`, () => {
    // The whole field is ONE false claim — the worst case for stripping.
    const result = { chiefBrief: { [field]: 'Your recovery is green today.' } };
    const { violations } = validateChiefBriefClaims(result, FACTS);
    assert.ok(violations.length > 0, 'the fixture must actually trigger a violation');

    const neutralized = neutralizeClaimViolations(result, violations, FACTS);
    const finalized = ensureRequiredFieldsPresent(neutralized, FACTS);

    const value = finalized.chiefBrief[field];
    assert.equal(typeof value, 'string');
    assert.ok(value.trim().length > 0, `${field} must not be blank after neutralization`);
    // And the backstop text must not itself repeat the false claim.
    assert.doesNotMatch(value, /\bgreen\b/i);
  });
}

test('a multi-sentence field keeps its OTHER true sentences and only drops the false one', () => {
  const result = {
    chiefBrief: {
      synthesis: 'Your recovery is green today. The wealth reconciler is still open.',
    },
  };
  const { violations } = validateChiefBriefClaims(result, FACTS);
  const neutralized = neutralizeClaimViolations(result, violations, FACTS);
  const finalized = ensureRequiredFieldsPresent(neutralized, FACTS);
  assert.doesNotMatch(finalized.chiefBrief.synthesis, /green/i);
  assert.match(finalized.chiefBrief.synthesis, /wealth reconciler is still open/i);
});

test('ensureRequiredFieldsPresent is a no-op when every required field is already populated', () => {
  const result = {
    chiefBrief: { synthesis: 'a', action: 'b', risk: 'c', move: 'd', affirmation: '', openQuestion: null },
  };
  const out = ensureRequiredFieldsPresent(result, FACTS);
  assert.equal(out, result); // same reference — no unnecessary copy
});

test('a genuinely EMPTY LLM response for a required field is also backstopped (not just violation-stripped fields)', () => {
  // The model itself returned an empty string for `move` — not a contradiction,
  // just missing. The backstop must catch this class too, since "blank"
  // matters regardless of cause.
  const result = { chiefBrief: { synthesis: 'fine', action: 'fine', risk: 'fine', move: '' } };
  const out = ensureRequiredFieldsPresent(result, FACTS);
  assert.ok(out.chiefBrief.move.trim().length > 0);
});

test('grounded fallback for effective-workout-aware fields reflects the ACTUAL effective workout, never the scheduled one', () => {
  const result = { chiefBrief: { action: 'Crush your Push session today.' } };
  const { violations } = validateChiefBriefClaims(result, FACTS);
  const neutralized = neutralizeClaimViolations(result, violations, FACTS);
  const finalized = ensureRequiredFieldsPresent(neutralized, FACTS);
  // Whatever text ships must not still say Push (the scheduled, overridden session).
  assert.doesNotMatch(finalized.chiefBrief.action, /\bPush\b/);
});
