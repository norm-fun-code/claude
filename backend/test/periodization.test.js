const test = require('node:test');
const assert = require('node:assert/strict');
const { computePeriodizationNote } = require('../src/intelligence/periodization');

test('no note when ACWR is not high, even with adjacent hard days', () => {
  const upcoming = [{ day: 'Wed', type: '4×4 Intervals' }, { day: 'Thu', type: 'Push' }];
  assert.equal(computePeriodizationNote({ upcoming, acwrBand: 'optimal' }), null);
  assert.equal(computePeriodizationNote({ upcoming, acwrBand: 'low' }), null);
  assert.equal(computePeriodizationNote({ upcoming, acwrBand: null }), null);
});

test('no note when ACWR is high but no two hard days are adjacent', () => {
  const upcoming = [{ day: 'Mon', type: 'Zone 2' }, { day: 'Tue', type: 'Recovery + Mobility' }, { day: 'Wed', type: 'Push' }];
  assert.equal(computePeriodizationNote({ upcoming, acwrBand: 'high' }), null);
});

test('flags adjacent hard days when ACWR is high', () => {
  const upcoming = [{ day: 'Wed', type: '4×4 Intervals' }, { day: 'Thu', type: 'Push' }];
  const note = computePeriodizationNote({ upcoming, acwrBand: 'high' });
  assert.match(note, /Wed/);
  assert.match(note, /Thu/);
  assert.match(note, /elevated/);
});

test('finds a non-adjacent-to-today pair further out in the window', () => {
  const upcoming = [{ day: 'Mon', type: 'Zone 2' }, { day: 'Tue', type: 'Pull' }, { day: 'Wed', type: 'Push' }];
  const note = computePeriodizationNote({ upcoming, acwrBand: 'high' });
  assert.match(note, /Tue/);
  assert.match(note, /Wed/);
});

test('fewer than 2 upcoming days never produces a note', () => {
  assert.equal(computePeriodizationNote({ upcoming: [{ day: 'Wed', type: 'Push' }], acwrBand: 'high' }), null);
  assert.equal(computePeriodizationNote({ upcoming: [], acwrBand: 'high' }), null);
});
