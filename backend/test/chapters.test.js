const test = require('node:test');
const assert = require('node:assert/strict');
const { describeChapter, composeChapterContext } = require('../src/intelligence/chapters');

const asOf = new Date('2026-07-02T12:00:00Z');

test('pregnancy chapter auto-derives the current week from the due date', () => {
  // Due Jan 6 2027 → 188 days out on Jul 2 → week ceil((280-188)/7) = ceil(13.1) = 14.
  const line = describeChapter(
    { kind: 'pregnancy', label: 'Nancy pregnant', key_date: '2027-01-06', key_date_label: 'due' },
    asOf
  );
  assert.match(line, /week 14 of 40/);
  assert.match(line, /due Jan 6/);
  assert.match(line, /188 days out/);
});

test('pregnancy week advances on its own as time passes', () => {
  const ch = { kind: 'pregnancy', label: 'Nancy pregnant', key_date: '2027-01-06' };
  const later = describeChapter(ch, new Date('2026-08-02T12:00:00Z'));
  assert.match(later, /week 18 of 40/);
});

test('countdown chapter renders days remaining, today, and past', () => {
  const ch = { kind: 'countdown', label: 'Q3 board deck', key_date: '2026-07-10', key_date_label: 'deadline' };
  assert.match(describeChapter(ch, asOf), /8 days out/);
  assert.match(describeChapter({ ...ch, key_date: '2026-07-02' }, asOf), /TODAY/);
  assert.match(describeChapter({ ...ch, key_date: '2026-06-30' }, asOf), /2 days ago/);
});

test('note chapter without a date falls back to label + notes', () => {
  assert.equal(describeChapter({ kind: 'note', label: 'Training for spring half' }, asOf), 'Training for spring half');
  assert.match(describeChapter({ kind: 'note', label: 'New role', notes: 'ramping at Acme' }, asOf), /ramping at Acme/);
});

test('composeChapterContext joins lines and returns empty for nothing', () => {
  assert.equal(composeChapterContext([], asOf), '');
  const ctx = composeChapterContext([
    { kind: 'pregnancy', label: 'Nancy pregnant', key_date: '2027-01-06' },
    { kind: 'countdown', label: 'Lease renewal', key_date: '2026-09-01' },
  ], asOf);
  assert.match(ctx, /week 14/);
  assert.match(ctx, /Lease renewal — 61 days out/);
  assert.equal(ctx.split('\n').length, 2);
});
