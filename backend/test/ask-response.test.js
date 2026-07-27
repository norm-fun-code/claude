// Unit tests for chat/askResponse.js — the structured AskResponse contract
// builder. Pure functions, no DB/LLM: intent classification, evidence
// selection/formatting from a real EvidenceClaim packet (built via
// brain/evidenceClaim.js's own makeClaim, not a hand-rolled shape), honest
// uncertainty surfacing, and proposedActions assembly.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyIntent, describeClaim, selectRelevantEvidence, claimToEvidence,
  buildUncertainties, buildProposedActions, buildAskResponse, currentSnapshotMeta,
} = require('../src/chat/askResponse');
const { makeClaim, CLAIM_TYPE, EVIDENCE_TIER } = require('../src/brain/evidenceClaim');

test('classifyIntent: a command or a turn that produced an action is always "act", regardless of wording', () => {
  assert.equal(classifyIntent('swap my workout to zone2', { isCommand: true, hasActions: false }), 'act');
  assert.equal(classifyIntent('what should I focus on?', { isCommand: false, hasActions: true }), 'act');
});

test('classifyIntent: a tradeoff/recommendation question is "decide"', () => {
  assert.equal(classifyIntent('should I do my planned workout or rest?', {}), 'decide');
  assert.equal(classifyIntent('what should I prioritize this week?', {}), 'decide');
  assert.equal(classifyIntent('is it worth switching to Zone 2 today?', {}), 'decide');
});

test('classifyIntent: a plain factual question defaults to "understand" — the safer default when uncertain', () => {
  assert.equal(classifyIntent('why was my recovery lower today?', {}), 'understand');
  assert.equal(classifyIntent('what do you know versus suspect about my HRV?', {}), 'understand');
});

test('required: a question that merely ASKS about an action ("should I swap...") is never itself treated as an act request', () => {
  // Distinguishing this from the command "swap my workout" is exactly what
  // stops Ask from silently mutating state in response to a question.
  assert.equal(classifyIntent('should I swap my workout to zone2?', { isCommand: false, hasActions: false }), 'decide');
});

function recoveryBandClaim() {
  return makeClaim({
    claimType: CLAIM_TYPE.FACT, subject: 'recovery', predicate: 'band', value: 'green',
    evidenceRefs: ['intelligence/recovery.liveRecovery'], evidenceTier: EVIDENCE_TIER.DIRECT_OBSERVATION, confidence: 0.9,
  });
}
function unrelatedGoalClaim() {
  return makeClaim({
    claimType: CLAIM_TYPE.FACT, subject: 'goal:Ship the deck', predicate: 'completed', value: false,
    evidenceRefs: ['store/goals.listGoals'], evidenceTier: EVIDENCE_TIER.DIRECT_OBSERVATION,
  });
}
function recoveryCauseUnknownClaim() {
  return makeClaim({
    claimType: CLAIM_TYPE.UNKNOWN, subject: 'recovery', predicate: 'cause', value: null,
    evidenceRefs: ['intelligence/recovery-drivers'],
  });
}

test('required: evidence[] never dumps every retrieved fact — only claims relevant to the question/answer are selected', () => {
  const claims = [recoveryBandClaim(), unrelatedGoalClaim()];
  const selected = selectRelevantEvidence(claims, { question: 'why is my recovery low today?', answer: 'Your recovery band is green today.' });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].subject, 'recovery');
});

test('claimToEvidence maps a fresh claim to freshness "fresh" and carries source/tier/confidence through unchanged', () => {
  const claim = recoveryBandClaim();
  const ev = claimToEvidence(claim);
  assert.equal(ev.freshness, 'fresh');
  assert.equal(ev.evidenceTier, EVIDENCE_TIER.DIRECT_OBSERVATION);
  assert.equal(ev.confidence, 0.9);
  assert.equal(ev.source, 'intelligence/recovery.liveRecovery');
  assert.match(ev.statement, /Recovery band: green/);
});

test('claimToEvidence marks an expired claim "stale"', () => {
  const claim = makeClaim({
    claimType: CLAIM_TYPE.FACT, subject: 'assertion:x', predicate: 'eventStatus', value: 'occurred',
    evidenceRefs: ['ctx'], expiresAt: '2020-01-01T00:00:00.000Z',
  });
  const ev = claimToEvidence(claim, { asOf: new Date('2026-01-01') });
  assert.equal(ev.freshness, 'stale');
});

test('required: an UNKNOWN-type claim never becomes fabricated evidence — it is excluded from evidence[] and surfaced as an honest uncertainty instead', () => {
  const claims = [recoveryCauseUnknownClaim()];
  const relevant = selectRelevantEvidence(claims, { question: 'why was my recovery lower today?', answer: 'no established cause' });
  const evidence = relevant.filter((c) => c.claimType !== 'unknown').map((c) => claimToEvidence(c));
  assert.equal(evidence.length, 0, 'an UNKNOWN claim must never appear in evidence[]');
  const uncertainties = buildUncertainties(relevant, []);
  assert.equal(uncertainties.length, 1);
  assert.match(uncertainties[0], /doesn't have a confirmed driver/);
});

test('buildUncertainties surfaces a neutralized claim-validator check as a human-readable uncertainty', () => {
  const out = buildUncertainties([], ['commitment_completion']);
  assert.equal(out.length, 1);
  assert.match(out[0], /commitment completion/);
});

test('buildProposedActions: a meaningful action (swap_workout) is marked requiresConfirmation and carries the validated payload unmodified', () => {
  const action = { action: 'swap_workout', workoutId: 'zone2' };
  const [pa] = buildProposedActions([{ action, executed: false, result: null }]);
  assert.equal(pa.actionType, 'swap_workout');
  assert.equal(pa.requiresConfirmation, true);
  assert.equal(pa.executed, false);
  assert.deepEqual(pa.validatedPayload, action);
});

test('buildProposedActions: a low-stakes action (log_habit) is NOT flagged for confirmation and reflects its immediate execution result', () => {
  const action = { action: 'log_habit', habit: 'coldShower' };
  const [pa] = buildProposedActions([{ action, executed: true, result: { done: true, description: 'Logged coldShower as done' } }]);
  assert.equal(pa.requiresConfirmation, false);
  assert.equal(pa.executed, true);
  assert.equal(pa.executionResult.description, 'Logged coldShower as done');
});

test('buildAskResponse assembles a complete, well-formed envelope', () => {
  const claims = [recoveryBandClaim()];
  const res = buildAskResponse({
    question: 'what is my recovery today?',
    answer: 'Your recovery band is green today.',
    actionResults: [],
    claims,
    conversationId: 42,
    snapshotId: 'ask:7', snapshotVersion: 7, snapshotAt: '2026-07-27T12:00:00.000Z',
    isCommand: false,
  });
  assert.match(res.responseId, /^ar_/);
  assert.equal(res.conversationId, 42);
  assert.equal(res.snapshotVersion, 7);
  assert.equal(res.intent, 'understand');
  assert.equal(res.directAnswer, 'Your recovery band is green today.');
  assert.equal(res.evidence.length, 1);
  assert.equal(res.evidence[0].statement, 'Recovery band: green');
  assert.deepEqual(res.proposedActions, []);
  assert.ok(typeof res.generatedAt === 'string' && !Number.isNaN(Date.parse(res.generatedAt)));
});

test('currentSnapshotMeta returns a non-null snapshotId/snapshotVersion tied to the live invalidation state', () => {
  const meta = currentSnapshotMeta();
  assert.equal(typeof meta.snapshotVersion, 'number');
  assert.equal(meta.snapshotId, `ask:${meta.snapshotVersion}`);
  assert.ok(!Number.isNaN(Date.parse(meta.snapshotAt)));
});
