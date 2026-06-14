const test = require('node:test');
const assert = require('node:assert/strict');
const { qualifies, WATCHED, THRESHOLD } = require('../src/intelligence/watch');

test('down-metric (HRV) fires only on a sharp DROP', () => {
  assert.equal(qualifies('down', -2.5), true);   // HRV cratered → ping
  assert.equal(qualifies('down', -2.2), true);   // exactly at the bar
  assert.equal(qualifies('down', -1.9), false);  // a wobble, not worth it
  assert.equal(qualifies('down', 3.0), false);   // HRV way UP is great news, not urgent
});

test('up-metric (resting HR) fires only on a sharp RISE', () => {
  assert.equal(qualifies('up', 2.5), true);      // RHR elevated → ping
  assert.equal(qualifies('up', -3.0), false);    // RHR unusually low is fine
  assert.equal(qualifies('up', 1.0), false);
});

test('threshold is configurable and inclusive at the boundary', () => {
  assert.equal(qualifies('down', -2.0, 2.0), true);
  assert.equal(qualifies('down', -1.99, 2.0), false);
});

test('non-finite z never qualifies', () => {
  assert.equal(qualifies('down', null), false);
  assert.equal(qualifies('down', NaN), false);
  assert.equal(qualifies('up', undefined), false);
});

test('every watched metric declares a valid bad direction and guidance', () => {
  assert.ok(WATCHED.length > 0);
  for (const cfg of WATCHED) {
    assert.ok(['up', 'down'].includes(cfg.bad), `${cfg.metric} has a bad direction`);
    assert.ok(cfg.title && cfg.guidance, `${cfg.metric} has title + guidance`);
    assert.ok(Array.isArray(cfg.sources) && cfg.sources.length, `${cfg.metric} has sources`);
  }
  assert.ok(THRESHOLD >= 2, 'interruption bar is at least 2 sigma');
});
