// A retraction is never the target of another retraction.
//
// Found while chasing a test that passed on run 1 and failed on run 2 against
// the same database. The cause was not the test: a retraction annotation stays
// ACTIVE as an audit record, and it quotes the plan it withdrew ("I did not end
// up going for drinks with friends tonight"). So it scores almost identically
// to that plan against any later, similarly-worded retraction. Two near-equal
// candidates fail findRetractionTarget's ambiguity margin, which — correctly,
// given what it knows — refuses to guess and returns null.
//
// The consequence in production is the exact failure this whole path exists to
// prevent: the later retraction silently retires NOTHING, and the plan the user
// just explicitly withdrew stays eligible for Ask and the next brief. Nothing
// surfaces an error; the context simply never goes away.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findRetractionTarget, isRetraction } = require('../src/intelligence/context-semantics');

const plan = { id: 'plan', label: 'drinks with friends tonight', note: null, category: 'brief_context' };
const priorRetraction = {
  id: 'prior-retraction',
  label: 'I did not end up going for drinks with friends tonight. Please forget that context.',
  note: null, category: 'brief_context',
};
const RETRACTION = 'I did not end up going for drinks with friends tonight. Please forget that context.';

test('the fixture really is a retraction — otherwise this whole file is vacuous', () => {
  assert.equal(isRetraction(priorRetraction.label, { category: priorRetraction.category }), true);
  assert.equal(isRetraction(plan.label, { category: plan.category }), false);
});

test('a stale retraction cannot crowd out the real target', () => {
  // THE regression. Without the exclusion these two score within the margin of
  // each other, the matcher declines to choose, and the plan is never retired.
  const target = findRetractionTarget(RETRACTION, [plan, priorRetraction]);
  assert.ok(target, 'a retraction must still find its plan when an old retraction is lying around');
  assert.equal(target.id, 'plan');
});

test('order does not matter', () => {
  assert.equal(findRetractionTarget(RETRACTION, [priorRetraction, plan]).id, 'plan');
});

test('several stale retractions still cannot crowd out the real target', () => {
  const another = { ...priorRetraction, id: 'older-retraction' };
  assert.equal(findRetractionTarget(RETRACTION, [another, priorRetraction, plan]).id, 'plan');
});

test('with only retractions to choose from, nothing is retired', () => {
  // You cannot withdraw a withdrawal. Returning null is correct here — the
  // alternative would be retiring the user's own audit record of a correction.
  assert.equal(findRetractionTarget(RETRACTION, [priorRetraction]), null);
});

test('the ambiguity margin still protects genuinely ambiguous NON-retraction candidates', () => {
  // The fix must not become "always pick the top score". Two distinct plans
  // that both match closely are still ambiguous, and guessing between them
  // would retire the wrong one.
  const a = { id: 'a', label: 'drinks with friends tonight', note: null, category: 'brief_context' };
  const b = { id: 'b', label: 'drinks with friends tonight', note: null, category: 'brief_context' };
  assert.equal(findRetractionTarget(RETRACTION, [a, b]), null, 'two identical plans must stay ambiguous');
});

test('an unrelated plan is still never matched', () => {
  const unrelated = { id: 'u', label: 'dentist appointment at 3pm', note: null, category: 'brief_context' };
  assert.equal(findRetractionTarget(RETRACTION, [unrelated]), null);
});
