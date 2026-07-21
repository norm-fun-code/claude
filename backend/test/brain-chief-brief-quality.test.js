// THE authoritative Chief Brief quality contract (brain/claimValidator.js's
// assessChiefBriefQuality) — proves the exact bug from the production audit:
// "Recovery is green at 100/100 today." (the deterministic grounded-fallback
// sentence groundedFallbackSentence() ships when a required field would
// otherwise go blank) was being treated as a successful FRESH morning build
// because shape validation only checked "every field non-empty". A brief is
// not fresh merely because every field is non-empty: this contract also
// rejects the exact fallback sentences, enforces meaningful minimum
// completeness, and never calls a claim-violating result fresh.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assessChiefBriefQuality, groundedFallbackSentence, isGroundedFallbackText, buildQualityRetryPrompt,
} = require('../src/brain/claimValidator');

const FACTS = {
  localDate: '2026-06-11',
  recoveryScore: 100,
  recoveryBand: 'green',
  effectiveWorkoutLabel: 'Intervals',
  effectiveWorkoutSource: 'scheduled',
  goals: [], commitments: [], experiments: [],
};

const FRESH = {
  chiefBrief: {
    synthesis: 'Recovery is strong this morning after a full night of deep sleep, so today is a good day to push the scheduled intervals session.',
    action: 'Run the scheduled interval session as planned, focusing on hitting your target paces in each rep.',
    risk: 'Watch your hydration given the heat forecast for this afternoon\'s outdoor portion of the day.',
    move: 'Get your gear ready tonight so the morning session starts on time without a scramble.',
    openQuestion: '',
    affirmation: 'You\'ve shown up for every scheduled session this week, and that consistency is exactly what builds real fitness.',
  },
  morningFocus: 'With recovery this strong, the highest-leverage move today is the scheduled hard session — everything else on the calendar is secondary to protecting that window.',
};

test('scenario 1: the exact "Recovery is green at 100/100 today." fallback is classified degraded, not fresh', () => {
  const result = { chiefBrief: { synthesis: groundedFallbackSentence('synthesis', FACTS), action: 'a', risk: 'r', move: 'm' } };
  // Sanity-check the exact string the bug report described.
  assert.equal(groundedFallbackSentence('synthesis', FACTS), 'Recovery is green at 100/100 today.');
  const quality = assessChiefBriefQuality(result, FACTS);
  assert.equal(quality.status, 'degraded');
  assert.ok(quality.fallbackFields.includes('synthesis'));
  assert.ok(quality.reasonCodes.includes('grounded_fallback_used'));
});

test('scenario 3: a valid, detailed synthesis (and the rest of the fields) passes the quality contract as fresh', () => {
  const quality = assessChiefBriefQuality(FRESH, FACTS);
  assert.equal(quality.status, 'fresh');
  assert.deepEqual(quality.fallbackFields, []);
  assert.deepEqual(quality.violatedChecks, []);
});

test('no chiefBrief at all → failed, not degraded', () => {
  const quality = assessChiefBriefQuality({ chiefBrief: null }, FACTS);
  assert.equal(quality.status, 'failed');
});

test('a required field missing entirely → failed', () => {
  const quality = assessChiefBriefQuality({ chiefBrief: { synthesis: 'x', action: 'y', risk: 'z' /* move missing */ } }, FACTS);
  assert.equal(quality.status, 'failed');
  assert.ok(quality.reasonCodes.includes('move_missing'));
});

test('a schema-valid but underfilled synthesis (well short of the ~20-35 word target) is degraded, even though it is not the exact fallback sentence', () => {
  const result = { chiefBrief: { synthesis: 'Good day.', action: FRESH.chiefBrief.action, risk: FRESH.chiefBrief.risk, move: FRESH.chiefBrief.move } };
  assert.notEqual(result.chiefBrief.synthesis, groundedFallbackSentence('synthesis', FACTS), 'must not be the literal fallback — proves length alone is being caught');
  const quality = assessChiefBriefQuality(result, FACTS);
  assert.equal(quality.status, 'degraded');
  assert.ok(quality.reasonCodes.includes('synthesis_underfilled'));
});

test('a claim contradiction against canonical facts is never fresh, no matter how long the text is', () => {
  const result = {
    chiefBrief: {
      synthesis: 'Recovery is yellow this morning, so ease off the intensity and keep today lighter than the plan called for originally.',
      action: FRESH.chiefBrief.action, risk: FRESH.chiefBrief.risk, move: FRESH.chiefBrief.move,
    },
  };
  const quality = assessChiefBriefQuality(result, FACTS); // FACTS says recoveryBand is 'green'
  assert.equal(quality.status, 'degraded');
  assert.ok(quality.reasonCodes.includes('unresolved_claim_violation'));
  assert.ok(quality.violatedChecks.length > 0);
});

test('quality metadata never contains generated prose — only field names, word counts, and reason codes', () => {
  const result = { chiefBrief: { synthesis: groundedFallbackSentence('synthesis', FACTS), action: 'a', risk: 'r', move: 'm' } };
  const quality = assessChiefBriefQuality(result, FACTS);
  const serialized = JSON.stringify(quality);
  assert.doesNotMatch(serialized, /Recovery is green/, 'the fallback SENTENCE TEXT itself must not appear in quality metadata');
});

test('isGroundedFallbackText matches only the exact deterministic sentence, not a similar one', () => {
  assert.equal(isGroundedFallbackText('synthesis', groundedFallbackSentence('synthesis', FACTS), FACTS), true);
  assert.equal(isGroundedFallbackText('synthesis', 'Recovery is green at 100/100 today, and looking strong.', FACTS), false);
  assert.equal(isGroundedFallbackText('synthesis', '', FACTS), false);
  assert.equal(isGroundedFallbackText('synthesis', null, FACTS), false);
});

test('buildQualityRetryPrompt names the underfilled/fallback fields without echoing any generated prose', () => {
  const result = { chiefBrief: { synthesis: groundedFallbackSentence('synthesis', FACTS), action: 'x', risk: 'y', move: 'z' } };
  const quality = assessChiefBriefQuality(result, FACTS);
  const prompt = buildQualityRetryPrompt('BASE PROMPT', quality);
  assert.match(prompt, /synthesis/);
  assert.doesNotMatch(prompt, /Recovery is green/);
});

// Minimum-completeness floors apply to action/risk/move too, without being
// brittle exact-length requirements — a couple of words is clearly
// insufficient, but there's no upper bound and no exact target enforced.
for (const field of ['action', 'risk', 'move']) {
  test(`a near-empty "${field}" (well under the floor) is degraded`, () => {
    const result = { chiefBrief: { ...FRESH.chiefBrief, [field]: 'Do it.' } };
    const quality = assessChiefBriefQuality(result, FACTS);
    assert.equal(quality.status, 'degraded');
    assert.ok(quality.reasonCodes.includes(`${field}_underfilled`));
  });
}

test('a missing optional field (affirmation, morningFocus) does not by itself cause degraded', () => {
  const result = { chiefBrief: { ...FRESH.chiefBrief, affirmation: '' } };
  const quality = assessChiefBriefQuality(result, FACTS);
  assert.equal(quality.status, 'fresh');
});
