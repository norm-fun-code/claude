const test = require('node:test');
const assert = require('node:assert/strict');
const { eveningHabitsToTrack } = require('../src/intelligence/evening-readiness');

test('non-rest day tracks all evening habits, including Exercise', () => {
  const habits = eveningHabitsToTrack(false).map((h) => h.metric);
  assert.ok(habits.includes('exercise'));
  assert.ok(habits.includes('gratitude'));
  assert.ok(habits.includes('afternoon_tm'));
  assert.ok(habits.includes('cold_shower'));
});

test('rest day excludes Exercise — there was no planned session to have done', () => {
  const habits = eveningHabitsToTrack(true).map((h) => h.metric);
  assert.ok(!habits.includes('exercise'));
  // The rest of the stack is unaffected — a rest day doesn't excuse gratitude/TM/shower.
  assert.ok(habits.includes('gratitude'));
  assert.ok(habits.includes('afternoon_tm'));
  assert.ok(habits.includes('cold_shower'));
});
