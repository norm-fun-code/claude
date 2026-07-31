import test from 'node:test';
import assert from 'node:assert/strict';
import { isNarrationBusy, narrationButtonLabel } from './narrationStatus.ts';

test('cold narration tells the person it is preparing rather than looking permanently unavailable', () => {
  assert.equal(narrationButtonLabel('loading'), 'Preparing…');
  assert.equal(narrationButtonLabel('preparing'), 'Preparing…');
  assert.equal(isNarrationBusy('preparing'), true);
});

test('a transient TTS failure has an explicit immediate retry affordance', () => {
  assert.equal(narrationButtonLabel('error', 'narration_failed'), 'Try again');
  assert.equal(narrationButtonLabel('error', 'not_found'), 'Not found');
  assert.equal(isNarrationBusy('error'), false);
});
