// Negation blindness — the recurring class of false positive.
//
// Three separate mornings have now been degraded by the same shape of bug: a
// check matches a phrase and infers a claim from it without noticing the
// sentence says the OPPOSITE. First "rather than explain" was read as asserting
// a cause. Now, on a RED morning, three correct descriptions of red recovery
// were each read as claiming GREEN:
//
//   "you are not fully recovered"      -> matched "fully recovered"
//   "this is not a green light"        -> matched "green"
//   "nowhere near fully rested"        -> matched "fully rested"
//
// Because the synthesis is usually a single sentence, flagging it destroys the
// whole headline and the card collapses to a six-word stub — which is exactly
// the "one-line brief" reported from the phone.
//
// The guard must be narrow: it looks back only to the nearest CLAUSE boundary,
// so a negation belonging to a different clause cannot launder a real
// contradiction. That loophole test is the most important one here.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateChiefBriefClaims, isNegatedAt } = require('../src/brain/claimValidator');

const red = { recoveryScore: 35, recoveryBand: 'red', recoveryDrivers: [] };
const green = { recoveryScore: 90, recoveryBand: 'green', recoveryDrivers: [] };

function bandViolations(sentence, facts = red) {
  const { violations } = validateChiefBriefClaims(
    { chiefBrief: { synthesis: sentence, action: 'x', risk: 'x', move: 'x' } }, facts
  );
  return violations.filter((v) => v.check === 'recovery_band');
}

// --- the production sentences that broke it -------------------------------

test('a correct RED morning described with a negated green phrase is not flagged', () => {
  for (const s of [
    'Recovery is red at 35 — you are not fully recovered, so today is about protecting the floor.',
    'Recovery came in red at 35; this is not a green light for intensity.',
    'Recovery is red at 35 today — nowhere near fully rested.',
    'Recovery is red at 35 and you are far from fully recovered.',
    'Recovery is red at 35, so this is hardly a full send day.',
    'Recovery sits red at 35 — never mistake this for green.',
  ]) {
    assert.deepEqual(bandViolations(s), [], `false positive on: ${s}`);
  }
});

// --- the guard must not become a loophole ---------------------------------

test('a negation in a DIFFERENT clause cannot launder a real contradiction', () => {
  // THE test that keeps this honest. The negation attaches to "bad", not to
  // "green", so the green claim is genuine and must still be caught. A
  // whole-sentence negation search would wrongly swallow it.
  const v = bandViolations('Recovery is not bad — it is green at 90 and you are fully recovered.');
  assert.equal(v.length, 1, 'a genuine green claim in a later clause must still be flagged');
  assert.equal(v[0].actual, 'green');
});

test('an unhedged wrong-band claim is still caught', () => {
  assert.equal(bandViolations('Recovery is green at 90 today.').length, 1);
  assert.equal(bandViolations('You are fully recovered and ready to send it.').length, 1);
  assert.equal(bandViolations('Recovery is yellow — a moderate recovery day.').length, 1);
});

test('the correct band is never flagged as contradicting itself', () => {
  assert.deepEqual(bandViolations('Recovery is red at 35 and you are under-recovered.'), []);
  assert.deepEqual(bandViolations('Recovery is green at 90 — fully recovered.', green), []);
});

// --- the primitive ---------------------------------------------------------

test('isNegatedAt looks back only to the nearest clause boundary', () => {
  const s = 'not bad — it is green';
  assert.equal(isNegatedAt(s, s.indexOf('green')), false, 'the em dash ends the negated clause');
  const t = 'this is not a green light';
  assert.equal(isNegatedAt(t, t.indexOf('green')), true);
});

test('isNegatedAt recognizes contractions and multi-word cues', () => {
  for (const s of ["you aren't fully recovered", 'you are nowhere near fully recovered',
                   'this is far from fully recovered', "we can't call this fully recovered"]) {
    assert.equal(isNegatedAt(s, s.indexOf('fully recovered')), true, `missed the negation in: ${s}`);
  }
});

test('isNegatedAt does not fire on an unnegated clause', () => {
  const s = 'recovery is green at 90';
  assert.equal(isNegatedAt(s, s.indexOf('green')), false);
});
