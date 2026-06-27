const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRecTitle } = require('../src/store/recommendations');

test('normalizeRecTitle collapses titles that differ only by numbers', () => {
  const a = normalizeRecTitle('Best sleep nights → 13% better HRV');
  const b = normalizeRecTitle('Best sleep nights → 12% better HRV');
  assert.equal(a, b, 'percentage-only differences must normalize to the same key');
});

test('normalizeRecTitle keeps semantically different recs distinct', () => {
  const sleep = normalizeRecTitle('Best sleep nights → 13% better HRV');
  const energy = normalizeRecTitle('High-energy days: your HRV is 14% better on those days');
  assert.notEqual(sleep, energy);
});

test('normalizeRecTitle strips units (ms/bpm/h), not words', () => {
  const a = normalizeRecTitle('Cold shower: HRV 62ms vs 49ms (+27%)');
  const b = normalizeRecTitle('Cold shower: HRV 58ms vs 47ms (+23%)');
  assert.equal(a, b);
  assert.match(a, /cold shower/);
  assert.match(a, /hrv/);
});
