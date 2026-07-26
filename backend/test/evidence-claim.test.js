// Unit coverage for brain/evidenceClaim.js — the EvidenceClaim v1 contract:
// makeClaim's shape validation, buildEvidenceClaims' pure projection of a
// canonical facts object into typed claims, isClaimStale's temporal check,
// and summarizeClaimsForDebug's never-leak-the-value guarantee.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CLAIM_TYPE, LANGUAGE_LEVEL, EVIDENCE_TIER,
  makeClaim, buildEvidenceClaims, isClaimStale, summarizeClaimsForDebug,
} = require('../src/brain/evidenceClaim');

test('makeClaim requires a valid claimType', () => {
  assert.throws(() => makeClaim({ claimType: 'not_a_real_type', subject: 'x', predicate: 'y' }), /invalid claimType/);
});

test('makeClaim requires subject and predicate', () => {
  assert.throws(() => makeClaim({ claimType: CLAIM_TYPE.FACT, predicate: 'y' }), /subject and predicate/);
  assert.throws(() => makeClaim({ claimType: CLAIM_TYPE.FACT, subject: 'x' }), /subject and predicate/);
});

test('makeClaim defaults allowedLanguage from claimType when not given', () => {
  const c = makeClaim({ claimType: CLAIM_TYPE.ASSOCIATION, subject: 'recovery', predicate: 'contributingFactor', value: 'wine' });
  assert.equal(c.allowedLanguage, LANGUAGE_LEVEL.OBSERVATIONAL);
  const fact = makeClaim({ claimType: CLAIM_TYPE.FACT, subject: 'recovery', predicate: 'band', value: 'red' });
  assert.equal(fact.allowedLanguage, LANGUAGE_LEVEL.ASSERTIVE);
});

test('makeClaim result is frozen (immutable) and auto-assigns a claimId', () => {
  const c = makeClaim({ claimType: CLAIM_TYPE.FACT, subject: 'x', predicate: 'y', value: 1 });
  assert.ok(c.claimId);
  assert.ok(Object.isFrozen(c));
  c.value = 2; // a no-op outside strict mode — assert the object itself rejected the mutation
  assert.equal(c.value, 1);
});

test('buildEvidenceClaims returns [] for null/undefined facts', () => {
  assert.deepEqual(buildEvidenceClaims(null), []);
  assert.deepEqual(buildEvidenceClaims(undefined), []);
});

test('buildEvidenceClaims: recovery band/score become FACT claims at DIRECT_OBSERVATION tier, ASSERTIVE language', () => {
  const claims = buildEvidenceClaims({ recoveryBand: 'red', recoveryScore: 38 });
  const band = claims.find((c) => c.subject === 'recovery' && c.predicate === 'band');
  const score = claims.find((c) => c.subject === 'recovery' && c.predicate === 'score');
  assert.equal(band.value, 'red');
  assert.equal(band.claimType, CLAIM_TYPE.FACT);
  // DIRECT_OBSERVATION, not ESTABLISHED — a raw current reading is not the
  // same kind of evidence as curated population-level science (audit
  // priority #1, truth-and-evidence contract).
  assert.equal(band.evidenceTier, EVIDENCE_TIER.DIRECT_OBSERVATION);
  assert.equal(band.allowedLanguage, LANGUAGE_LEVEL.ASSERTIVE);
  assert.equal(score.value, 38);
});

test('buildEvidenceClaims: a proxy recovery reading gets lower confidence than a real one', () => {
  const real = buildEvidenceClaims({ recoveryBand: 'green', recoveryProxy: false }).find((c) => c.predicate === 'band');
  const proxy = buildEvidenceClaims({ recoveryBand: 'green', recoveryProxy: true }).find((c) => c.predicate === 'band');
  assert.ok(proxy.confidence < real.confidence);
});

test('buildEvidenceClaims: eligible recovery drivers become OBSERVATIONAL ASSOCIATION claims, never assertive', () => {
  const claims = buildEvidenceClaims({ recoveryDrivers: ['drank wine last night', 'a hard training session'] });
  const associations = claims.filter((c) => c.claimType === CLAIM_TYPE.ASSOCIATION);
  assert.equal(associations.length, 2);
  for (const c of associations) {
    assert.equal(c.allowedLanguage, LANGUAGE_LEVEL.OBSERVATIONAL);
    assert.equal(c.evidenceTier, EVIDENCE_TIER.SUPPORTED_ASSOCIATION);
  }
});

test('buildEvidenceClaims: no eligible drivers but a known recovery value produces an explicit UNKNOWN cause claim', () => {
  const claims = buildEvidenceClaims({ recoveryBand: 'yellow', recoveryDrivers: [] });
  const unknown = claims.find((c) => c.subject === 'recovery' && c.predicate === 'cause');
  assert.ok(unknown);
  assert.equal(unknown.claimType, CLAIM_TYPE.UNKNOWN);
  assert.equal(unknown.allowedLanguage, LANGUAGE_LEVEL.FORBIDDEN);
});

test('buildEvidenceClaims: no recovery value at all produces no cause claim (nothing to explain)', () => {
  const claims = buildEvidenceClaims({});
  assert.equal(claims.find((c) => c.subject === 'recovery' && c.predicate === 'cause'), undefined);
});

test('buildEvidenceClaims: workout completion (plannedWorkoutCompleted) becomes its own FACT claim, distinct from the effectivePlan claim', () => {
  const claims = buildEvidenceClaims({
    effectiveWorkoutLabel: '4×4 Intervals', effectiveWorkoutSource: 'scheduled', plannedWorkoutCompleted: false,
  });
  const planClaim = claims.find((c) => c.subject === 'workout' && c.predicate === 'effectivePlan');
  const completionClaim = claims.find((c) => c.subject === 'workout' && c.predicate === 'completed');
  assert.ok(planClaim, 'the plan claim still exists');
  assert.ok(completionClaim, 'a separate completion claim exists');
  assert.equal(completionClaim.value, false);
  assert.equal(completionClaim.evidenceTier, EVIDENCE_TIER.DIRECT_OBSERVATION);
  assert.deepEqual(completionClaim.evidenceRefs, ['services/workout.resolveTrainingOutcome']);
});

test('buildEvidenceClaims: no workout completion claim when plannedWorkoutCompleted is unknown (null/undefined)', () => {
  const claims = buildEvidenceClaims({ effectiveWorkoutLabel: '4×4 Intervals', effectiveWorkoutSource: 'scheduled' });
  assert.ok(!claims.some((c) => c.subject === 'workout' && c.predicate === 'completed'));
});

test('buildEvidenceClaims: goals/commitments become per-item FACT completion claims', () => {
  const claims = buildEvidenceClaims({
    goals: [{ text: 'Ship the deck', achieved: false }, { text: 'Renew passport', achieved: true }],
    commitments: [{ title: 'Call the accountant', status: 'open' }, { title: 'Book flights', status: 'done' }],
  });
  const openGoal = claims.find((c) => c.subject === 'goal:Ship the deck');
  const doneGoal = claims.find((c) => c.subject === 'goal:Renew passport');
  const openCommitment = claims.find((c) => c.subject === 'commitment:Call the accountant');
  const doneCommitment = claims.find((c) => c.subject === 'commitment:Book flights');
  assert.equal(openGoal.value, false);
  assert.equal(doneGoal.value, true);
  assert.equal(openCommitment.value, false);
  assert.equal(doneCommitment.value, true);
});

test('buildEvidenceClaims: a confirmed experiment is EXPERIMENT_RESULT/ASSERTIVE; anything else is HYPOTHESIS/FORBIDDEN', () => {
  const claims = buildEvidenceClaims({
    experiments: [
      { hypothesis: 'Zone2 boosts next-day recovery', verdict: 'confirmed' },
      { hypothesis: 'Cold shower helps focus', status: 'running' },
      { hypothesis: 'Late coffee hurts sleep', verdict: 'refuted' },
    ],
  });
  const confirmed = claims.find((c) => c.subject.includes('Zone2'));
  const running = claims.find((c) => c.subject.includes('Cold shower'));
  const refuted = claims.find((c) => c.subject.includes('Late coffee'));
  assert.equal(confirmed.claimType, CLAIM_TYPE.EXPERIMENT_RESULT);
  assert.equal(confirmed.allowedLanguage, LANGUAGE_LEVEL.ASSERTIVE);
  assert.equal(confirmed.evidenceTier, EVIDENCE_TIER.PERSONAL_EXPERIMENT);
  assert.equal(running.claimType, CLAIM_TYPE.HYPOTHESIS);
  assert.equal(running.allowedLanguage, LANGUAGE_LEVEL.FORBIDDEN);
  assert.equal(refuted.claimType, CLAIM_TYPE.HYPOTHESIS);
  assert.equal(refuted.allowedLanguage, LANGUAGE_LEVEL.FORBIDDEN);
});

test('buildEvidenceClaims: a resolved-context assertion carries its eventStatus, window, and expiresAt', () => {
  const claims = buildEvidenceClaims({
    resolvedContext: {
      assertions: [{
        id: 'a1', predicate: 'went to', objectValue: 'the concert', eventStatus: 'retracted',
        effectiveStart: '2026-07-01T00:00:00Z', effectiveEnd: '2026-07-02T00:00:00Z',
      }],
    },
  });
  const c = claims.find((c) => c.subject === 'assertion:a1');
  assert.equal(c.value, 'retracted');
  assert.equal(c.observedFrom, '2026-07-01T00:00:00Z');
  assert.equal(c.observedTo, '2026-07-02T00:00:00Z');
  assert.equal(c.expiresAt, '2026-07-02T00:00:00Z');
});

test('buildEvidenceClaims: a retracted assertion with a supersession link carries supersededBy', () => {
  const claims = buildEvidenceClaims({
    resolvedContext: {
      assertions: [{ id: 'a2', rawText: 'went for drinks', eventStatus: 'retracted', supersededByAssertionId: 'a3' }],
    },
  });
  const c = claims.find((c) => c.subject === 'assertion:a2');
  assert.equal(c.supersededBy, 'a3');
});

test('isClaimStale: false before expiresAt, true after; true whenever supersededBy is set regardless of expiresAt', () => {
  const c1 = makeClaim({ claimType: CLAIM_TYPE.FACT, subject: 'x', predicate: 'y', expiresAt: '2026-07-10T00:00:00Z' });
  assert.equal(isClaimStale(c1, new Date('2026-07-05T00:00:00Z')), false);
  assert.equal(isClaimStale(c1, new Date('2026-07-15T00:00:00Z')), true);

  const c2 = makeClaim({ claimType: CLAIM_TYPE.FACT, subject: 'x', predicate: 'y', supersededBy: 'other-claim' });
  assert.equal(isClaimStale(c2, new Date('2020-01-01T00:00:00Z')), true, 'a superseded claim is stale regardless of any expiry');

  const c3 = makeClaim({ claimType: CLAIM_TYPE.FACT, subject: 'x', predicate: 'y' });
  assert.equal(isClaimStale(c3), false, 'no expiresAt/supersededBy at all → never stale');
});

test('summarizeClaimsForDebug never leaks value or full evidenceRefs — only claimId/claimType/evidenceTier/allowedLanguage', () => {
  const claims = buildEvidenceClaims({ recoveryBand: 'red', spendingTotalMonth: 4321.99 });
  const summary = summarizeClaimsForDebug(claims);
  for (const s of summary) {
    assert.deepEqual(Object.keys(s).sort(), ['allowedLanguage', 'claimId', 'claimType', 'evidenceTier']);
  }
  assert.equal(JSON.stringify(summary).includes('4321'), false, 'the raw spending figure never appears in the debug summary');
});
