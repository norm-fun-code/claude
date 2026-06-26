const test = require('node:test');
const assert = require('node:assert/strict');
const { verdict } = require('../src/intelligence/experiments');

test('verdict: a clear, significant improvement is confirmed', () => {
  const baseline = [45, 47, 44, 46, 45, 43, 46];
  const test_ = [55, 57, 54, 56, 58, 55, 56]; // ~+10ms, tight, expected up
  const r = verdict(baseline, test_, 'up');
  assert.equal(r.verdict, 'confirmed');
  assert.ok(r.p < 0.05, `should be significant, got p=${r.p}`);
  assert.ok(r.effectSize > 0.3);
  assert.ok(Array.isArray(r.ci) && r.ci.length === 2);
  assert.match(r.caveat, /regression to the mean/);
});

test('verdict: a noisy "improvement" is inconclusive, not confirmed', () => {
  // Means drift up ~8% but the spread is huge — old code (Cohen d only) could
  // call this confirmed; with a real two-sample test it must be inconclusive.
  const baseline = [40, 60, 38, 62, 41, 59, 37];
  const test_ = [44, 64, 41, 66, 45, 63, 40];
  const r = verdict(baseline, test_, 'up');
  assert.equal(r.verdict, 'inconclusive', `got ${r.verdict} at p=${r.p}`);
});

test('verdict: a significant move the WRONG way is refuted', () => {
  const baseline = [55, 57, 54, 56, 58, 55, 56];
  const test_ = [45, 47, 44, 46, 45, 43, 46]; // dropped sharply, but we expected up
  const r = verdict(baseline, test_, 'up');
  assert.equal(r.verdict, 'refuted');
  assert.ok(r.p < 0.05);
});

test('verdict: too little data is inconclusive', () => {
  const r = verdict([45, 46], [55, 56], 'up');
  assert.equal(r.verdict, 'inconclusive');
  assert.match(r.reason, /insufficient/);
});
