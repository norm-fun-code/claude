import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingConfirmations, intentLabel, type AskResponse, type ProposedAction } from './askResponse.ts';

function action(overrides: Partial<ProposedAction>): ProposedAction {
  return {
    actionType: 'swap_workout',
    title: 'Swap',
    preview: '',
    validatedPayload: { action: 'swap_workout', workoutId: 'zone2' },
    requiresConfirmation: true,
    reversibility: 'reversible',
    executed: false,
    executionResult: null,
    ...overrides,
  };
}

function response(proposedActions: ProposedAction[]): AskResponse {
  return {
    responseId: 'ar_1', conversationId: null, snapshotId: null, snapshotVersion: null, snapshotAt: null,
    intent: 'act', directAnswer: 'ok', reasoningSummary: null, evidence: [], uncertainties: [],
    proposedActions, followUps: [], generatedAt: new Date(0).toISOString(),
  };
}

test('pendingConfirmations returns only actions that need confirmation AND have not executed yet', () => {
  const needsConfirm = action({ requiresConfirmation: true, executed: false });
  const alreadyExecuted = action({ requiresConfirmation: true, executed: true, actionType: 'log_habit' });
  const noConfirmNeeded = action({ requiresConfirmation: false, executed: true, actionType: 'log_checkin' });
  const list = pendingConfirmations(response([needsConfirm, alreadyExecuted, noConfirmNeeded]));
  assert.deepEqual(list, [needsConfirm]);
});

test('pendingConfirmations is empty for a null/undefined response (no crash)', () => {
  assert.deepEqual(pendingConfirmations(null), []);
  assert.deepEqual(pendingConfirmations(undefined), []);
});

test('intentLabel maps every intent to a non-empty human label', () => {
  assert.equal(intentLabel('understand'), 'Understand');
  assert.equal(intentLabel('decide'), 'Decide');
  assert.equal(intentLabel('act'), 'Act');
  assert.equal(intentLabel(null), '');
});
