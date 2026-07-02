const test = require('node:test');
const assert = require('node:assert/strict');
const { isRecentlyBuilt } = require('../src/notify/morning');

const now = new Date('2026-07-02T08:30:00Z').getTime();
const H = 60 * 60 * 1000;

test('a brief built 90 minutes ago is recent (suppress the auto push)', () => {
  assert.equal(isRecentlyBuilt(new Date(now - 1.5 * H).toISOString(), { now }), true);
});

test('a brief built 3.5 hours ago is NOT recent (auto push proceeds)', () => {
  assert.equal(isRecentlyBuilt(new Date(now - 3.5 * H).toISOString(), { now }), false);
});

test('right at the 2h boundary is no longer recent (window is exclusive)', () => {
  assert.equal(isRecentlyBuilt(new Date(now - 2 * H).toISOString(), { now }), false);
  assert.equal(isRecentlyBuilt(new Date(now - (2 * H - 1)).toISOString(), { now }), true);
});

test('no prior brief → not recent (never suppress the first brief of the day)', () => {
  assert.equal(isRecentlyBuilt(null, { now }), false);
  assert.equal(isRecentlyBuilt(undefined, { now }), false);
});

test('a garbage timestamp is treated as not-recent (fail open, build the brief)', () => {
  assert.equal(isRecentlyBuilt('not-a-date', { now }), false);
});

test('windowMs = 0 disables the guard entirely', () => {
  assert.equal(isRecentlyBuilt(new Date(now - 60000).toISOString(), { now, windowMs: 0 }), false);
});

test('a custom window is honored', () => {
  const built = new Date(now - 20 * 60000).toISOString(); // 20m ago
  assert.equal(isRecentlyBuilt(built, { now, windowMs: 30 * 60000 }), true);  // 30m window
  assert.equal(isRecentlyBuilt(built, { now, windowMs: 10 * 60000 }), false); // 10m window
});
