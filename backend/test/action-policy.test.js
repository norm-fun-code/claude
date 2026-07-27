// Unit tests for chat/actionPolicy.js — the per-action consent rule that
// decides which validated Ask/voice actions execute immediately on the
// user's own statement vs. need an explicit confirm step first.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { needsConfirmation, describeAction, reversibilityOf, IMMEDIATE_ACTIONS, CONFIRM_REQUIRED_ACTIONS } = require('../src/chat/actionPolicy');

test('required: a meaningful, cross-surface-visible mutation (swap_workout, add_chapter) requires confirmation', () => {
  assert.equal(needsConfirmation({ action: 'swap_workout', workoutId: 'zone2' }), true);
  assert.equal(needsConfirmation({ action: 'add_chapter', kind: 'note', label: 'x' }), true);
});

test('required: an existing per-action consent rule allows every low-stakes, reversible logging action to execute immediately', () => {
  for (const action of IMMEDIATE_ACTIONS) {
    assert.equal(needsConfirmation({ action }), false, `${action} should not require confirmation`);
  }
});

test('IMMEDIATE_ACTIONS and CONFIRM_REQUIRED_ACTIONS are disjoint and together cover every action type ask.js validates', () => {
  const ALL_ACTION_TYPES = [
    'swap_workout', 'log_habit', 'log_activity', 'log_checkin', 'log_weight',
    'log_gratitude_text', 'add_context', 'log_day_context', 'set_reminder', 'add_chapter',
  ];
  for (const t of ALL_ACTION_TYPES) {
    const inImmediate = IMMEDIATE_ACTIONS.has(t);
    const inConfirm = CONFIRM_REQUIRED_ACTIONS.has(t);
    assert.notEqual(inImmediate, inConfirm, `${t} must be in exactly one of the two sets`);
  }
});

test('needsConfirmation is false for null/malformed input (never throws)', () => {
  assert.equal(needsConfirmation(null), false);
  assert.equal(needsConfirmation(undefined), false);
  assert.equal(needsConfirmation({}), false);
});

test('describeAction produces an accurate preview for a workout swap, naming the exact new plan', () => {
  const { title, preview } = describeAction({ action: 'swap_workout', workoutId: 'zone2' });
  assert.match(title, /Zone 2/);
  assert.match(preview, /Zone 2/);
});

test('describeAction never claims an action is done — its wording is prospective (preview), not a completion claim', () => {
  const DONE_WORDS = /\b(done|completed|swapped|logged|added|remembered)\b/i;
  for (const action of [
    { action: 'swap_workout', workoutId: 'push' },
    { action: 'add_chapter', kind: 'note', label: 'New role starts' },
  ]) {
    const { preview } = describeAction(action);
    assert.equal(DONE_WORDS.test(preview), false, `preview for ${action.action} must not claim completion: "${preview}"`);
  }
});

test('reversibilityOf reports "reversible" for a known action type, "unknown" for a malformed one', () => {
  assert.equal(reversibilityOf({ action: 'swap_workout' }), 'reversible');
  assert.equal(reversibilityOf(null), 'unknown');
});
