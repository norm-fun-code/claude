// Regression tests for the mobile workout-completion decision logic. Run
// via: node --experimental-strip-types --test src/lib/workoutCompletion.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { isWorkoutMarkedComplete, shouldWriteExerciseHabit } from './workoutCompletion.ts';

// ── isWorkoutMarkedComplete ──────────────────────────────────────────────

test('isWorkoutMarkedComplete: true when the completion record matches the displayed workout id', () => {
  assert.equal(isWorkoutMarkedComplete({ workoutId: 'intervals', source: 'manual' }, 'intervals'), true);
});

test('isWorkoutMarkedComplete: false when no completion record exists for the day', () => {
  assert.equal(isWorkoutMarkedComplete(undefined, 'intervals'), false);
});

test('isWorkoutMarkedComplete: false when the completion record is for a DIFFERENT workout (a swap/downgrade since marking)', () => {
  assert.equal(isWorkoutMarkedComplete({ workoutId: 'zone2', source: 'manual' }, 'intervals'), false);
});

// ── shouldWriteExerciseHabit ──────────────────────────────────────────────

test('marking complete always writes the Exercise habit', () => {
  assert.equal(shouldWriteExerciseHabit(true, []), true);
  assert.equal(shouldWriteExerciseHabit(true, [{ activity_type: 'walk' }]), true);
});

test('unmarking clears the Exercise habit when nothing else non-rest is logged today', () => {
  assert.equal(shouldWriteExerciseHabit(false, []), true);
  assert.equal(shouldWriteExerciseHabit(false, [{ activity_type: 'rest' }]), true);
});

test('unmarking does NOT clear the Exercise habit when another non-rest activity remains logged', () => {
  assert.equal(shouldWriteExerciseHabit(false, [{ activity_type: 'walk' }]), false);
});

test('unmarking with a mix of rest and non-rest activities still preserves the habit', () => {
  assert.equal(shouldWriteExerciseHabit(false, [{ activity_type: 'rest' }, { activity_type: 'walk' }]), false);
});
