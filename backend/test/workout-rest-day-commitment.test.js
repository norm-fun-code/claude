// Bug: committing to a rest day via the morning brief's "Commit to something
// else" freeform box (or a manually-typed commitment) only ever wrote a
// commitments row — it never touched workout_overrides, the table every
// other reader of "today's plan" actually reads (getTodayWorkout(), the
// evening brief's plan-vs-actual grading, chat/ask.js's TODAY'S PLANNED
// WORKOUT). So the evening brief kept grading the day against the original
// scheduled session ("Planned Pull — not logged as done") even though the
// user told the app that morning they were resting instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isRestDayCommitment } = require('../src/services/workout');

test('isRestDayCommitment recognizes plain "rest day" phrasing', () => {
  assert.ok(isRestDayCommitment('Rest day'));
  assert.ok(isRestDayCommitment('taking a rest day today'));
  assert.ok(isRestDayCommitment('Full rest day — HRV was down'));
});

test('isRestDayCommitment recognizes other common rest-intent phrasings', () => {
  assert.ok(isRestDayCommitment('resting today instead'));
  assert.ok(isRestDayCommitment('taking a day off'));
  assert.ok(isRestDayCommitment('skipping today\'s workout'));
  assert.ok(isRestDayCommitment('going to skip training, feeling beat up'));
});

test('isRestDayCommitment is case-insensitive', () => {
  assert.ok(isRestDayCommitment('REST DAY'));
});

test('isRestDayCommitment does not fire on unrelated commitments', () => {
  assert.equal(isRestDayCommitment('Do the Zone 2 incline walk at an easy pace'), false);
  assert.equal(isRestDayCommitment('Log gratitude before bed'), false);
  assert.equal(isRestDayCommitment('Call mom at 6'), false);
});

test('isRestDayCommitment avoids false positives on unrelated "rest" roots', () => {
  // Same lesson as evening-readiness.js's SICK_KEYWORDS — a loose \brest\b
  // would also fire on these, which are not rest-day commitments.
  assert.equal(isRestDayCommitment('rest assured I logged my workout'), false);
  assert.equal(isRestDayCommitment('dinner at the restaurant tonight'), false);
});

test('isRestDayCommitment handles null/empty/non-string input safely', () => {
  assert.equal(isRestDayCommitment(null), false);
  assert.equal(isRestDayCommitment(undefined), false);
  assert.equal(isRestDayCommitment(''), false);
});
