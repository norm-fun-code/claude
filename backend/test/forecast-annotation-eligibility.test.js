// Forecast annotation eligibility — requirement #4: a retraction or a negation
// ("I did NOT drink last night", "forget that") must NEVER move tomorrow's
// forecast. predict.js used to read annotations directly; it now routes them
// through this shared 'forecast' purpose, so the same eligibility rule that
// protects every other surface protects the forecast. These are pure unit
// tests on the classification layer the forecast depends on.
const test = require('node:test');
const assert = require('node:assert/strict');
const cs = require('../src/intelligence/context-semantics');

const ann = (over = {}) => ({
  label: '', note: '', category: null, start_ts: '2026-06-11T02:00:00.000Z',
  end_ts: null, retired_at: null, ...over,
});
const eligible = (a) => cs.isEligibleContext(a, { purpose: 'forecast' }).eligible;

test("a NEGATED note ('I did not drink last night') is NOT eligible for the forecast", () => {
  assert.equal(eligible(ann({ note: "I didn't drink last night" })), false);
  assert.equal(eligible(ann({ note: 'I did not drink or eat late last night' })), false);
});

test("a RETRACTION ('forget that context') is NOT eligible for the forecast", () => {
  assert.equal(eligible(ann({ note: 'I didn’t end up going for drinks. Please forget that context.' })), false);
});

test('a RETIRED annotation is NOT eligible for the forecast', () => {
  assert.equal(eligible(ann({ note: 'big stressful launch tomorrow', retired_at: '2026-06-11T09:00:00.000Z' })), false);
});

test('a financial note is NOT eligible for the forecast (irrelevant to recovery capacity)', () => {
  assert.equal(eligible(ann({ label: 'Spent $340 on dinner', category: 'spend' })), false);
});

test('a genuine forward-looking PLANNED stressor IS eligible (it may legitimately adjust the lean)', () => {
  assert.equal(eligible(ann({ note: 'stressful product launch tomorrow' })), true);
});

test('an OCCURRED event that can carry into tomorrow IS eligible', () => {
  assert.equal(eligible(ann({ note: 'hard interval session and drinks last night' })), true);
});

test('filterEligible drops the retraction/negation but keeps the real stressor', () => {
  const annotations = [
    ann({ note: "I didn't drink last night" }),          // negated → drop
    ann({ note: 'forget that, never mind' }),             // retraction → drop
    ann({ note: 'stressful launch tomorrow' }),           // planned → keep
  ];
  const kept = cs.filterEligible(annotations, { purpose: 'forecast' });
  assert.equal(kept.length, 1);
  assert.match(kept[0].note, /stressful launch/);
});
