const test = require('node:test');
const assert = require('node:assert/strict');
const stats = require('../src/intelligence/stats');

test('linearFit recovers slope/intercept of a clean line', () => {
  const fit = stats.linearFit([0, 2, 4, 6, 8]);
  assert.ok(fit);
  assert.equal(Math.round(fit.slope * 1000) / 1000, 2);
  assert.equal(Math.round(fit.intercept * 1000) / 1000, 0);
  assert.ok(fit.residualStd < 1e-9, 'no residual on a perfect line');
});

test('linearFit reports residual spread on noisy data', () => {
  const fit = stats.linearFit([0, 3, 3, 9, 8]);
  assert.ok(fit.residualStd > 0);
});

test('linearFit returns null when underdetermined', () => {
  assert.equal(stats.linearFit([5]), null);
});

test('normalCdf matches known quantiles', () => {
  assert.ok(Math.abs(stats.normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(stats.normalCdf(1.959964) - 0.975) < 1e-3);
  assert.ok(Math.abs(stats.normalCdf(-1.959964) - 0.025) < 1e-3);
  // Symmetry: Φ(z) + Φ(-z) = 1
  assert.ok(Math.abs(stats.normalCdf(0.7) + stats.normalCdf(-0.7) - 1) < 1e-6);
});

test('normalCdf saturates at the tails', () => {
  assert.ok(stats.normalCdf(40) > 0.9999);
  assert.ok(stats.normalCdf(-40) < 0.0001);
  assert.equal(stats.normalCdf(Infinity), 1);
  assert.equal(stats.normalCdf(-Infinity), 0);
});
