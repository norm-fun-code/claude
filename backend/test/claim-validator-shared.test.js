// Unit coverage for the EvidenceClaim v1 additions to brain/claimValidator.js
// that Evening Brief and Ask (not just Chief Brief) use directly:
// validateClaims (the shared, field-array entrypoint), neutralizeClaimsGeneric
// (the flat-object sentence-stripping neutralizer), and checkAssociationOverclaim
// (overclaiming a weak-evidence association/observation as "confirmed"/"proven").
// See test/brain-claim-validator*.test.js for the pre-existing Chief-Brief-
// specific coverage (unchanged by this refactor — see EC2's zero-behavior-
// change verification) and test/integration/evidence-claim-golden.test.js for
// cross-surface proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateClaims, neutralizeClaimsGeneric, checkAssociationOverclaim,
} = require('../src/brain/claimValidator');
const { buildEvidenceClaims } = require('../src/brain/evidenceClaim');

test('validateClaims returns [] when fields or facts is missing', () => {
  assert.deepEqual(validateClaims(null, { recoveryBand: 'red' }), []);
  assert.deepEqual(validateClaims([['answer', 'text']], null), []);
});

test('validateClaims runs every check against an arbitrary field list (not just chiefBrief-shaped input)', () => {
  const facts = { recoveryBand: 'red' };
  const violations = validateClaims([['answer', 'Great news — recovery is green today, go crush it.']], facts);
  assert.ok(violations.some((v) => v.check === 'recovery_band'));
  assert.equal(violations[0].field, 'answer');
});

test('validateClaims is silent on a clean field list', () => {
  const facts = { recoveryBand: 'green' };
  const violations = validateClaims([['answer', 'Recovery is green today — good day to push a bit harder.']], facts);
  assert.deepEqual(violations, []);
});

test('checkAssociationOverclaim fires only when BOTH an overclaim verb AND a weak-evidence claim subject appear together', () => {
  const facts = { claims: buildEvidenceClaims({ recoveryDrivers: ['a late meal last night'] }) };
  const overclaimed = checkAssociationOverclaim(
    [['answer', 'It is proven that a late meal last night tanks your recovery every time.']], facts
  );
  assert.equal(overclaimed.length, 1);
  assert.equal(overclaimed[0].check, 'association_overclaim');

  // The overclaim verb alone, about something else entirely, is not flagged.
  const unrelated = checkAssociationOverclaim(
    [['answer', 'It is proven that the earth orbits the sun.']], facts
  );
  assert.deepEqual(unrelated, []);

  // The weak claim named WITHOUT overclaiming language is not flagged either
  // — hedged/observational language is exactly what's licensed.
  const hedged = checkAssociationOverclaim(
    [['answer', 'A late meal last night may be a contributing factor worth watching.']], facts
  );
  assert.deepEqual(hedged, []);
});

test('checkAssociationOverclaim never flags a claim whose allowedLanguage is already assertive (e.g. a confirmed experiment)', () => {
  const facts = { claims: buildEvidenceClaims({ experiments: [{ hypothesis: 'Zone2 boosts next-day recovery', verdict: 'confirmed' }] }) };
  const violations = checkAssociationOverclaim(
    [['answer', 'It is now confirmed that Zone2 boosts next-day recovery.']], facts
  );
  assert.deepEqual(violations, [], 'a genuinely confirmed experiment may be stated as settled — that is what checkExperiments (not this check) already permits');
});

test('checkAssociationOverclaim is a no-op when facts.claims is absent (backward compatible)', () => {
  assert.deepEqual(checkAssociationOverclaim([['answer', 'It is proven that X causes Y.']], {}), []);
});

test('neutralizeClaimsGeneric strips exactly the offending sentence(s), leaving the rest of the field intact', () => {
  const fieldsObj = { answer: 'Good morning. That commitment is done. Have a great day.' };
  const violations = [{ field: 'answer', sentence: 'That commitment is done.' }];
  const out = neutralizeClaimsGeneric(fieldsObj, violations);
  assert.equal(out.answer, 'Good morning. Have a great day.');
});

test('neutralizeClaimsGeneric never mutates the input object', () => {
  const fieldsObj = { answer: 'That commitment is done.' };
  const violations = [{ field: 'answer', sentence: 'That commitment is done.' }];
  neutralizeClaimsGeneric(fieldsObj, violations, { requiredFields: new Set(['answer']), fallbackFor: () => 'fallback text' });
  assert.equal(fieldsObj.answer, 'That commitment is done.', 'original object untouched');
});

test('neutralizeClaimsGeneric falls back for a required field that would otherwise go blank, and leaves a non-required field blank', () => {
  const fieldsObj = { answer: 'That commitment is done.', aside: 'That commitment is done.' };
  const violations = [
    { field: 'answer', sentence: 'That commitment is done.' },
    { field: 'aside', sentence: 'That commitment is done.' },
  ];
  const out = neutralizeClaimsGeneric(fieldsObj, violations, {
    requiredFields: new Set(['answer']),
    fallbackFor: (field) => `[${field} fallback]`,
  });
  assert.equal(out.answer, '[answer fallback]');
  assert.equal(out.aside, '', 'a non-required field is simply left blank once its only sentence is stripped');
});

test('neutralizeClaimsGeneric returns the input unchanged when there are no violations', () => {
  const fieldsObj = { answer: 'All good here.' };
  assert.equal(neutralizeClaimsGeneric(fieldsObj, []), fieldsObj);
});
