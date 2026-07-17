// Audit3 fix 1: pure unit coverage for crossContext.js's classifyCausalLanguage
// classifier — the task's own adversarial examples of unsupported causal/
// prescriptive language that a flat "causes|boosts" regex would miss, plus
// the observational phrasings that must keep passing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCausalLanguage } = require('../src/intelligence/crossContext');

test('rejects "improves" as an unhedged causal claim', () => {
  assert.equal(classifyCausalLanguage('Magnesium improves your energy.'), true);
});

test('rejects the causative "makes X higher" resultative construction', () => {
  assert.equal(classifyCausalLanguage('Magnesium makes your energy higher.'), true);
});

test('rejects "has a positive effect on" as an unhedged effect claim', () => {
  assert.equal(classifyCausalLanguage('Magnesium has a positive effect on energy.'), true);
});

test('rejects an indirect imperative paired with a stated purpose', () => {
  assert.equal(classifyCausalLanguage('Take magnesium; it improves energy.'), true);
});

test('rejects "keep taking it to boost energy" (imperative + purpose)', () => {
  assert.equal(classifyCausalLanguage('Keep taking it to boost energy.'), true);
});

test('rejects "leads to" / "results in" causal connectives', () => {
  assert.equal(classifyCausalLanguage('Magnesium before bed leads to better sleep.'), true);
  assert.equal(classifyCausalLanguage('Poor sleep results in lower energy the next day.'), true);
});

test('allows "is associated with" observational phrasing', () => {
  assert.equal(classifyCausalLanguage('Magnesium nights are associated with higher energy.'), false);
});

test('allows "coincides with" observational phrasing', () => {
  assert.equal(classifyCausalLanguage('Higher energy coincides with magnesium nights.'), false);
});

test('allows "is worth testing" observational/suggestive phrasing', () => {
  assert.equal(classifyCausalLanguage('Magnesium nights tend to track with more energy — worth testing.'), false);
});

test('allows a bare comparative adjective outside the causative-make structure', () => {
  assert.equal(classifyCausalLanguage('Energy runs 38% higher after your best nights of sleep.'), false);
});

test('allows a hedged/negated causal word ("not a proven effect")', () => {
  assert.equal(classifyCausalLanguage('An association worth testing, not a proven effect.'), false);
});

test('allows a purpose-free imperative ("log your sleep tonight")', () => {
  assert.equal(classifyCausalLanguage('Log your sleep tonight.'), false);
});
