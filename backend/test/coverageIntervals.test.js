'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, addInterval, isFullyCovered } = require('../src/services/coverageIntervals');

test('normalize merges overlapping intervals', () => {
  const merged = normalize([{ from: '2026-01-01', to: '2026-01-10' }, { from: '2026-01-05', to: '2026-01-15' }]);
  assert.deepEqual(merged, [{ from: '2026-01-01', to: '2026-01-15' }]);
});

test('normalize merges adjacent (touching) intervals', () => {
  const merged = normalize([{ from: '2026-01-01', to: '2026-01-10' }, { from: '2026-01-11', to: '2026-01-20' }]);
  assert.deepEqual(merged, [{ from: '2026-01-01', to: '2026-01-20' }]);
});

test('required: a real gap between two intervals is preserved, never silently bridged', () => {
  const merged = normalize([{ from: '2026-01-01', to: '2026-01-10' }, { from: '2026-01-15', to: '2026-01-20' }]);
  assert.deepEqual(merged, [{ from: '2026-01-01', to: '2026-01-10' }, { from: '2026-01-15', to: '2026-01-20' }]);
});

test('normalize handles unsorted, invalid, and empty input safely', () => {
  assert.deepEqual(normalize([]), []);
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize([{ from: '2026-01-10', to: '2026-01-01' }]), [], 'inverted from>to is dropped');
  const merged = normalize([{ from: '2026-02-01', to: '2026-02-05' }, { from: '2026-01-01', to: '2026-01-05' }]);
  assert.deepEqual(merged, [{ from: '2026-01-01', to: '2026-01-05' }, { from: '2026-02-01', to: '2026-02-05' }]);
});

test('addInterval merges a new interval into an existing set', () => {
  const existing = [{ from: '2026-01-01', to: '2026-01-10' }];
  assert.deepEqual(addInterval(existing, '2026-01-11', '2026-01-20'), [{ from: '2026-01-01', to: '2026-01-20' }]);
  assert.deepEqual(addInterval(existing, '2026-03-01', '2026-03-05'), [{ from: '2026-01-01', to: '2026-01-10' }, { from: '2026-03-01', to: '2026-03-05' }]);
});

test('required: isFullyCovered requires the ENTIRE window inside one merged interval', () => {
  const intervals = [{ from: '2026-01-01', to: '2026-01-31' }];
  assert.equal(isFullyCovered(intervals, '2026-01-05', '2026-01-20'), true);
  assert.equal(isFullyCovered(intervals, '2026-01-01', '2026-01-31'), true, 'exact boundary match');
  assert.equal(isFullyCovered(intervals, '2026-01-25', '2026-02-05'), false, 'window extends past the covered range');
});

test('required: a window straddling a real gap between two separate intervals is NOT covered, even though both edges individually have data', () => {
  const intervals = [{ from: '2026-01-01', to: '2026-01-10' }, { from: '2026-01-20', to: '2026-01-31' }];
  assert.equal(isFullyCovered(intervals, '2026-01-05', '2026-01-25'), false, 'the 01-11..01-19 gap is inside this window');
  assert.equal(isFullyCovered(intervals, '2026-01-01', '2026-01-10'), true, 'a window fully inside one segment is fine');
});

test('no coverage at all means nothing is ever eligible', () => {
  assert.equal(isFullyCovered([], '2026-01-01', '2026-01-31'), false);
  assert.equal(isFullyCovered(null, '2026-01-01', '2026-01-31'), false);
});
