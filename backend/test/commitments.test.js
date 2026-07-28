const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveReminderTime, isReminderDue, deriveActionTitle } = require('../src/store/commitments');
const { selectReminderActions } = require('../src/notify/commitments');
const { parseAction, parseActions } = require('../src/chat/ask');

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

// ── deriveActionTitle ─────────────────────────────────────────────────────────
// Bug: POST /briefing/action/commit stored the FULL brief action paragraph as
// the commitment's title, silently truncated at 200 chars with no detail at
// all — the tail of a long action was just gone, not readable anywhere.

test('deriveActionTitle returns short text unchanged', () => {
  assert.equal(deriveActionTitle('Do the Zone 2 incline walk at an easy pace.'), 'Do the Zone 2 incline walk at an easy pace.');
});

test('deriveActionTitle prefers the first sentence when it is short enough', () => {
  const text = 'Do the Zone 2 walk today. It offsets yesterday\'s late Push session and keeps this week\'s training load on track without adding more volume than you can recover from.';
  const title = deriveActionTitle(text);
  assert.equal(title, 'Do the Zone 2 walk today.');
  assert.ok(title.length <= 100);
});

test('deriveActionTitle falls back to word-boundary truncation for a single long run-on sentence', () => {
  const text = 'Do the Zone 2 incline walk at an easy pace today since your last two Push sessions ran high and recovery is still catching up from the week';
  const title = deriveActionTitle(text);
  assert.ok(title.length <= 101, 'truncated title (plus ellipsis) stays near the cap'); // 100 + '…'
  assert.ok(title.endsWith('…'), 'a truncated title is marked with an ellipsis');
  assert.ok(!title.endsWith(' …'), 'truncation lands on a whole word, not mid-word with a trailing space');
});

test('deriveActionTitle handles empty/null input safely', () => {
  assert.equal(deriveActionTitle(''), '');
  assert.equal(deriveActionTitle(null), '');
  assert.equal(deriveActionTitle(undefined), '');
});

test('deriveActionTitle is deterministic — same input always produces the same title (no LLM call)', () => {
  const text = 'Protect two uninterrupted morning hours today and push reactive tasks to the afternoon, since focus has been trending down for the last week and a half.';
  assert.equal(deriveActionTitle(text), deriveActionTitle(text));
});

// ── isReminderDue (first reminder + persistent follow-ups) ───────────────────

const NOW_MS = new Date('2026-07-03T15:00:00Z').getTime();
const OPTS = { now: NOW_MS, reNudgeMs: 3 * 3600e3, maxReminders: 4, maxAgeMs: 24 * 3600e3 };
const H = 3600e3;

test('first reminder fires once due and never nudged', () => {
  assert.equal(isReminderDue({ status: 'open', due_at: new Date(NOW_MS - 60e3), reminded_at: null, reminder_count: 0 }, OPTS), true);
});

test('not due yet → no reminder', () => {
  assert.equal(isReminderDue({ status: 'open', due_at: new Date(NOW_MS + H), reminded_at: null, reminder_count: 0 }, OPTS), false);
});

test('follow-up waits for the re-nudge interval', () => {
  // Nudged 1h ago (< 3h) → not yet.
  assert.equal(isReminderDue({ status: 'open', due_at: new Date(NOW_MS - 2 * H), reminded_at: new Date(NOW_MS - H), reminder_count: 1 }, OPTS), false);
  // Nudged 3.5h ago → re-nudge.
  assert.equal(isReminderDue({ status: 'open', due_at: new Date(NOW_MS - 4 * H), reminded_at: new Date(NOW_MS - 3.5 * H), reminder_count: 1 }, OPTS), true);
});

test('stops after the per-commitment max reminders', () => {
  assert.equal(isReminderDue({ status: 'open', due_at: new Date(NOW_MS - 10 * H), reminded_at: new Date(NOW_MS - 4 * H), reminder_count: 4 }, OPTS), false);
});

test('stops once the commitment is older than the max age', () => {
  assert.equal(isReminderDue({ status: 'open', due_at: new Date(NOW_MS - 25 * H), reminded_at: new Date(NOW_MS - 4 * H), reminder_count: 1 }, OPTS), false);
});

test('done / skipped commitments never re-nudge', () => {
  assert.equal(isReminderDue({ status: 'done', due_at: new Date(NOW_MS - H), reminded_at: null, reminder_count: 0 }, OPTS), false);
  assert.equal(isReminderDue({ status: 'skipped', due_at: new Date(NOW_MS - H), reminded_at: new Date(NOW_MS - 4 * H), reminder_count: 1 }, OPTS), false);
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

// ── parseAction: log_day_context ─────────────────────────────────────────────

test('parseAction extracts a day-context recap', () => {
  const a = parseAction('Got it. <action>{"type":"log_day_context","text":"Rough day — poor sleep, stressful launch, skipped lunch."}</action>');
  assert.deepEqual(a, { action: 'log_day_context', text: 'Rough day — poor sleep, stressful launch, skipped lunch.' });
});

test('parseAction rejects an empty day-context', () => {
  assert.equal(parseAction('<action>{"type":"log_day_context","text":""}</action>'), null);
});

// ── parseAction: log_activity ────────────────────────────────────────────────

test('parseAction extracts a full log_activity', () => {
  const a = parseAction('<action>{"type":"log_activity","activityType":"cycle","durationMin":30,"label":"30 min biking","noWatch":false}</action>');
  assert.deepEqual(a, { action: 'log_activity', activityType: 'cycle', durationMin: 30, label: '30 min biking', noWatch: false });
});

test('parseAction maps an unrecognized activity type to "other" rather than dropping it', () => {
  const a = parseAction('<action>{"type":"log_activity","activityType":"kayaking","durationMin":45,"label":"45 min kayaking"}</action>');
  assert.equal(a.action, 'log_activity');
  assert.equal(a.activityType, 'other');
  assert.equal(a.label, '45 min kayaking'); // the description survives even when uncategorized
});

test('parseAction clamps an out-of-range duration to null rather than storing garbage', () => {
  const a = parseAction('<action>{"type":"log_activity","activityType":"run","durationMin":9999}</action>');
  assert.equal(a.durationMin, null);
});

test('parseAction rejects log_activity with no activityType', () => {
  assert.equal(parseAction('<action>{"type":"log_activity","durationMin":30}</action>'), null);
});

test('parseActions logs two distinct activities from one statement', () => {
  const text = '<action>{"type":"log_activity","activityType":"cycle","durationMin":30,"label":"30 min biking","noWatch":false}</action>' +
    '<action>{"type":"log_activity","activityType":"basketball","durationMin":60,"label":"1hr basketball","noWatch":false}</action>';
  const actions = parseActions(text);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].activityType, 'cycle');
  assert.equal(actions[1].activityType, 'basketball');
});

// ── parseActions: multiple actions in one turn (day recap + tomorrow) ─────────

test('parseActions captures a day recap AND a forward-looking note', () => {
  const text = 'Got it — logged today and noted tomorrow. ' +
    '<action>{"type":"log_day_context","text":"Rough day, poor sleep."}</action>\n' +
    '<action>{"type":"add_context","text":"Big presentation at 10am tomorrow."}</action>';
  const actions = parseActions(text);
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0], { action: 'log_day_context', text: 'Rough day, poor sleep.' });
  assert.deepEqual(actions[1], { action: 'add_context', text: 'Big presentation at 10am tomorrow.' });
});

test('parseActions drops exact duplicate tags', () => {
  const text = '<action>{"type":"log_habit","habit":"exercise"}</action>' +
    '<action>{"type":"log_habit","habit":"exercise"}</action>';
  assert.equal(parseActions(text).length, 1);
});

test('parseActions keeps two distinct habits', () => {
  const text = '<action>{"type":"log_habit","habit":"exercise"}</action>' +
    '<action>{"type":"log_habit","habit":"gratitude"}</action>';
  assert.equal(parseActions(text).length, 2);
});

test('parseAction still returns just the first (back-compat)', () => {
  const text = '<action>{"type":"log_day_context","text":"x day"}</action>' +
    '<action>{"type":"add_context","text":"y tomorrow"}</action>';
  assert.deepEqual(parseAction(text), { action: 'log_day_context', text: 'x day' });
});

// ── parseAction: log_weight ──────────────────────────────────────────────────

test('parseAction extracts a log_weight and rounds to one decimal', () => {
  const a = parseAction('<action>{"type":"log_weight","weightLb":172.34}</action>');
  assert.deepEqual(a, { action: 'log_weight', weightLb: 172.3 });
});

test('parseAction rejects an out-of-range weight rather than storing garbage', () => {
  assert.equal(parseAction('<action>{"type":"log_weight","weightLb":12}</action>'), null);
  assert.equal(parseAction('<action>{"type":"log_weight","weightLb":900}</action>'), null);
});

test('parseAction rejects a non-numeric weight', () => {
  assert.equal(parseAction('<action>{"type":"log_weight","weightLb":"a lot"}</action>'), null);
  assert.equal(parseAction('<action>{"type":"log_weight"}</action>'), null);
});

// ── parseAction: log_gratitude_text ──────────────────────────────────────────

test('parseAction extracts a log_gratitude_text', () => {
  const a = parseAction('<action>{"type":"log_gratitude_text","text":"my health and my family"}</action>');
  assert.deepEqual(a, { action: 'log_gratitude_text', text: 'my health and my family' });
});

test('parseAction rejects an empty log_gratitude_text', () => {
  assert.equal(parseAction('<action>{"type":"log_gratitude_text","text":""}</action>'), null);
  assert.equal(parseAction('<action>{"type":"log_gratitude_text"}</action>'), null);
});
