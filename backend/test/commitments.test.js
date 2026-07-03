const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveReminderTime } = require('../src/store/commitments');
const { selectReminderActions } = require('../src/notify/commitments');
const { parseAction } = require('../src/chat/ask');

// ── resolveReminderTime ──────────────────────────────────────────────────────

const NOW = new Date('2026-07-03T12:00:00');

test('resolveReminderTime accepts a future local datetime', () => {
  const { dueAt } = resolveReminderTime('2026-07-03T18:00', NOW);
  assert.ok(dueAt instanceof Date);
  assert.equal(dueAt.getTime(), new Date('2026-07-03T18:00').getTime());
});

test('resolveReminderTime treats a past time as untimed (no instant nudge)', () => {
  const { dueAt } = resolveReminderTime('2026-07-03T09:00', NOW);
  assert.equal(dueAt, null);
});

test('resolveReminderTime treats null / empty / garbage as untimed', () => {
  assert.equal(resolveReminderTime(null, NOW).dueAt, null);
  assert.equal(resolveReminderTime('', NOW).dueAt, null);
  assert.equal(resolveReminderTime('whenever', NOW).dueAt, null);
});

test('resolveReminderTime rejects an absurd far-future date (fat-fingered year)', () => {
  const { dueAt } = resolveReminderTime('2999-01-01T10:00', NOW);
  assert.equal(dueAt, null);
});

test('resolveReminderTime keeps a within-grace near-now time', () => {
  // 1 minute ago is inside the 2-minute grace — still schedulable (fires ~now).
  const { dueAt } = resolveReminderTime('2026-07-03T11:59', NOW);
  assert.ok(dueAt instanceof Date);
});

// ── selectReminderActions (restraint logic) ──────────────────────────────────

const commit = (id, extra = {}) => ({ id, title: `c${id}`, metric_key: null, ...extra });

test('quiet hours suppress pushes but still auto-complete satisfied ones', () => {
  const due = [commit(1), commit(2, { metric_key: 'habits:cold_shower' })];
  const { toFire, toAutoComplete } = selectReminderActions(due, {
    satisfiedIds: new Set([2]), quiet: true, maxPerDay: 2, sentToday: 0,
  });
  assert.equal(toFire.length, 0, 'no pushes during quiet hours');
  assert.deepEqual(toAutoComplete.map((c) => c.id), [2], 'satisfied ones still close silently');
});

test('daily cap limits how many pushes fire', () => {
  const due = [commit(1), commit(2), commit(3)];
  const { toFire } = selectReminderActions(due, { maxPerDay: 2, sentToday: 1, quiet: false });
  assert.equal(toFire.length, 1, 'only 1 of the remaining budget fires');
});

test('never nudges about something the data already shows done', () => {
  const due = [commit(1, { metric_key: 'habits:gratitude' }), commit(2)];
  const { toFire, toAutoComplete } = selectReminderActions(due, {
    satisfiedIds: new Set([1]), maxPerDay: 5, sentToday: 0, quiet: false,
  });
  assert.deepEqual(toFire.map((c) => c.id), [2], 'satisfied one is not pushed');
  assert.deepEqual(toAutoComplete.map((c) => c.id), [1], 'it is auto-completed instead');
});

test('cap already spent → no pushes at all', () => {
  const due = [commit(1), commit(2)];
  const { toFire } = selectReminderActions(due, { maxPerDay: 2, sentToday: 2, quiet: false });
  assert.equal(toFire.length, 0);
});

// ── parseAction: set_reminder ────────────────────────────────────────────────

test('parseAction extracts a set_reminder with a time', () => {
  const a = parseAction('Reminder set. <action>{"type":"set_reminder","text":"call mom","at":"2026-07-03T18:00"}</action>');
  assert.deepEqual(a, { action: 'set_reminder', text: 'call mom', at: '2026-07-03T18:00' });
});

test('parseAction allows an untimed set_reminder (at:null)', () => {
  const a = parseAction('<action>{"type":"set_reminder","text":"book the doctor","at":null}</action>');
  assert.deepEqual(a, { action: 'set_reminder', text: 'book the doctor', at: null });
});

test('parseAction rejects a set_reminder with no text', () => {
  const a = parseAction('<action>{"type":"set_reminder","at":"2026-07-03T18:00"}</action>');
  assert.equal(a, null);
});

// ── parseAction: log_checkin ─────────────────────────────────────────────────

test('parseAction extracts a full log_checkin', () => {
  const a = parseAction('Logged. <action>{"type":"log_checkin","mood":5,"energy":5,"focus":4}</action>');
  assert.deepEqual(a, { action: 'log_checkin', mood: 5, energy: 5, focus: 4 });
});

test('parseAction allows a partial log_checkin (only fields given)', () => {
  const a = parseAction('<action>{"type":"log_checkin","energy":3}</action>');
  assert.deepEqual(a, { action: 'log_checkin', mood: null, energy: 3, focus: null });
});

test('parseAction rejects out-of-range and empty log_checkin', () => {
  assert.equal(parseAction('<action>{"type":"log_checkin","mood":9}</action>'), null);
  assert.equal(parseAction('<action>{"type":"log_checkin"}</action>'), null);
});
