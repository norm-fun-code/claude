const test = require('node:test');
const assert = require('node:assert/strict');
const { wellbeingLevel } = require('../src/intelligence/catalog');

test('wellbeingLevel: bands a 1-5 self-rated value into low/ok/high, never a number', () => {
  assert.equal(wellbeingLevel(1), 'low');
  assert.equal(wellbeingLevel(2.9), 'low');
  assert.equal(wellbeingLevel(3), 'ok');
  assert.equal(wellbeingLevel(3.9), 'ok');
  assert.equal(wellbeingLevel(4), 'high');
  assert.equal(wellbeingLevel(5), 'high');
});

test('wellbeingLevel: null/undefined is safe', () => {
  assert.equal(wellbeingLevel(null), null);
  assert.equal(wellbeingLevel(undefined), null);
});
