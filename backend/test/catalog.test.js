const test = require('node:test');
const assert = require('node:assert/strict');
const { wellbeingLevel, unit } = require('../src/intelligence/catalog');

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

test('unit: returns the registered display unit for a known metric', () => {
  assert.equal(unit('health', 'active_energy'), 'kcal');
  assert.equal(unit('health', 'hrv'), 'ms');
  assert.equal(unit('wealth', 'net_worth'), '$');
});

test('unit: null for a metric with no registered unit or an unknown metric — same graceful degradation as goodWhen', () => {
  assert.equal(unit('health', 'sleep_score'), null);
  assert.equal(unit('health', 'not_a_real_metric'), null);
  assert.equal(unit('not_a_real_domain', 'also_fake'), null);
});
