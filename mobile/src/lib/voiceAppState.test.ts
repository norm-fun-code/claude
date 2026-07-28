import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldStopForAppState, shouldResetOnForeground } from './voiceAppState.ts';

test('required: backgrounding stops an active voice session (no zombie mic)', () => {
  assert.equal(shouldStopForAppState('background'), true);
});

test('the brief iOS "inactive" transitional state also stops the session', () => {
  assert.equal(shouldStopForAppState('inactive'), true);
});

test('staying active never stops anything', () => {
  assert.equal(shouldStopForAppState('active'), false);
});

test('required: returning to active from background/inactive requires a full reset, never a silent resume (no duplicate session)', () => {
  assert.equal(shouldResetOnForeground('background', 'active'), true);
  assert.equal(shouldResetOnForeground('inactive', 'active'), true);
});

test('going active -> active (no real transition) never triggers a reset', () => {
  assert.equal(shouldResetOnForeground('active', 'active'), false);
});
