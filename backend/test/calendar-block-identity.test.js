// Unit coverage for intelligence/calendar-block-identity.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { calendarBlockId, blockDurationMinutes, pickBlockBinding } = require('../src/intelligence/calendar-block-identity');

test('calendarBlockId: builds a stable id from source + date + normalized clock range', () => {
  const id = calendarBlockId({ source: 'work_busy', date: '2026-07-24', start: '9:00 AM', end: '6:00 PM' });
  assert.equal(id, 'work_busy_2026-07-24_0540-1080');
});

test('calendarBlockId: same clock range on a DIFFERENT date produces a DIFFERENT id', () => {
  const a = calendarBlockId({ source: 'work_busy', date: '2026-07-24', start: '9:00 AM', end: '6:00 PM' });
  const b = calendarBlockId({ source: 'work_busy', date: '2026-07-31', start: '9:00 AM', end: '6:00 PM' });
  assert.notEqual(a, b);
});

test('calendarBlockId: missing/invalid date or unresolvable clock strings return null', () => {
  assert.equal(calendarBlockId({ source: 'work_busy', date: null, start: '9:00 AM', end: '6:00 PM' }), null);
  assert.equal(calendarBlockId({ source: 'work_busy', date: '2026-07-24', start: 'garbage', end: '6:00 PM' }), null);
});

test('blockDurationMinutes: computes minutes from clock start/end', () => {
  assert.equal(blockDurationMinutes({ start: '9:00 AM', end: '6:00 PM' }), 540);
});

test('blockDurationMinutes: null on missing/inverted/unresolvable times', () => {
  assert.equal(blockDurationMinutes({ start: null, end: '6:00 PM' }), null);
  assert.equal(blockDurationMinutes({ start: '6:00 PM', end: '9:00 AM' }), null); // end before start
});

test('pickBlockBinding: zero blocks -> nothing to bind, not ambiguous', () => {
  assert.deepEqual(pickBlockBinding([]), { blockIds: [], ambiguous: false });
});

test('pickBlockBinding: a single block is always unambiguous', () => {
  const out = pickBlockBinding([{ id: 'only', start: '9:00 AM', end: '10:00 AM' }]);
  assert.deepEqual(out, { blockIds: ['only'], ambiguous: false });
});

test('pickBlockBinding: a block covering >=60% of the combined duration is the dominant, unambiguous winner', () => {
  const out = pickBlockBinding([
    { id: 'big', start: '9:00 AM', end: '5:00 PM' }, // 8h
    { id: 'small', start: '5:00 PM', end: '5:15 PM' }, // 0.25h
  ]);
  assert.deepEqual(out, { blockIds: ['big'], ambiguous: false });
});

test('pickBlockBinding: comparably-sized blocks (no dominant one) are ambiguous — every candidate id returned', () => {
  const out = pickBlockBinding([
    { id: 'a', start: '9:00 AM', end: '1:00 PM' }, // 4h
    { id: 'b', start: '2:00 PM', end: '6:00 PM' }, // 4h
  ]);
  assert.equal(out.ambiguous, true);
  assert.deepEqual(out.blockIds.sort(), ['a', 'b']);
});

test('pickBlockBinding: blocks missing an id are dropped before dominance is evaluated', () => {
  const out = pickBlockBinding([
    { id: 'real', start: '9:00 AM', end: '10:00 AM' },
    { start: '10:00 AM', end: '11:00 AM' }, // no id
  ]);
  assert.deepEqual(out, { blockIds: ['real'], ambiguous: false });
});

test('pickBlockBinding: unresolvable durations (all zero) still resolve deterministically as ambiguous, never guessing', () => {
  const out = pickBlockBinding([
    { id: 'x', start: null, end: null },
    { id: 'y', start: null, end: null },
  ]);
  assert.equal(out.ambiguous, true);
  assert.deepEqual(out.blockIds.sort(), ['x', 'y']);
});
