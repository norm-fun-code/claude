// The ONE canonical training-day fact/state layer (brain/trainingDayState.js)
// introduced to fix the production incident where the Today headline
// ("Treat today as a genuine rest day, not a data point.") and THE ACTION
// ("Today's Pull session (~45 min) is the only structured load.") disagreed
// with each other AND with the authoritative effective workout (Pull) —
// the prior fix's narrow "rest day" phrase list caught the literal phrase but
// not this paraphrase. These tests exercise the real production module, not
// a reimplementation, and specifically prove: (a) the fact layer never lets
// a calendar block / missing sleep data / provisional recovery flip WORKOUT
// into REST (it isn't even given those inputs — effectiveWorkout is the only
// input), and (b) the content-validation guard catches a table of semantic
// paraphrases, not just the literal phrase "rest day".
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TRAINING_DAY_STATE,
  resolveTrainingDayState,
  describesRestFraming,
  validateTrainingDayContent,
} = require('../src/brain/trainingDayState');

const PULL_SCHEDULED = { label: 'Pull', source: 'scheduled', workoutId: 'pull', scheduledLabel: 'Pull', scheduledWorkoutId: 'pull' };

// ── 1. The exact production fixture resolves to WORKOUT, not REST ─────────
test('scenario 1 — exact production fixture (Pull scheduled, no override) resolves trainingDayState to WORKOUT', () => {
  const tds = resolveTrainingDayState({ effectiveWorkout: PULL_SCHEDULED, snapshotId: 'snap-1', snapshotVersion: 3 });
  assert.equal(tds.state, TRAINING_DAY_STATE.WORKOUT);
  assert.equal(tds.effectiveWorkout.label, 'Pull');
  assert.equal(tds.explicitOverride, null, 'no override was ever supplied — must not be invented');
  assert.equal(tds.plannedWorkout.label, 'Pull');
  assert.equal(tds.provenance, 'scheduled');
});

// ── 1b. The exact production headline+action pair is caught by the guard ──
test('scenario 1b — the exact production headline/action pair fails validateTrainingDayContent under WORKOUT state', () => {
  const tds = resolveTrainingDayState({ effectiveWorkout: PULL_SCHEDULED });
  const { valid, violations } = validateTrainingDayContent(tds, {
    synthesis: 'Treat today as a genuine rest day, not a data point.',
    action: "Today's Pull session (~45 min) is the only structured load.",
  });
  assert.equal(valid, false);
  assert.ok(violations.some((v) => v.field === 'synthesis' && v.check === 'training_day_state_workout_vs_rest_claim'));
});

// ── 2. A protected/family calendar block never converts WORKOUT to REST ───
// resolveTrainingDayState's ONLY input is effectiveWorkout — calendar data is
// never passed to it at all, so a "family block" fact structurally cannot
// reach this function, let alone flip its state. Proven directly: supplying
// extraneous calendar-shaped fields (as a caller might mistakenly try to)
// has zero effect on the resolved state.
test('scenario 2 — a protected family/calendar block does not create REST (the fact layer never even sees calendar data)', () => {
  const tds = resolveTrainingDayState({
    effectiveWorkout: PULL_SCHEDULED,
    // Even if a caller mistakenly bundled calendar context onto the input,
    // resolveTrainingDayState has no calendar-shaped field to read it from.
    calendarBlocks: [{ type: 'family', protected: true, title: 'Kids pickup' }],
  });
  assert.equal(tds.state, TRAINING_DAY_STATE.WORKOUT);
});

// ── 3. Missing Eight Sleep / recovery data never creates REST ─────────────
test('scenario 3 — missing recovery/sleep data does not create REST (effectiveWorkout is unaffected by recovery presence)', () => {
  const tds = resolveTrainingDayState({ effectiveWorkout: PULL_SCHEDULED, recovery: null });
  assert.equal(tds.state, TRAINING_DAY_STATE.WORKOUT);
});

// ── 3b. Provisional/self-reported recovery reduces confidence, not state ──
test('scenario 3b — a provisional/self-reported recovery reading does not silently convert Pull into rest', () => {
  const tds = resolveTrainingDayState({
    effectiveWorkout: PULL_SCHEDULED,
    recovery: { proxy: true, category: 'Good', score: 80 },
  });
  assert.equal(tds.state, TRAINING_DAY_STATE.WORKOUT, 'a provisional recovery reading must not change the resolved training-day state');
});

// ── 4. An explicit persisted rest override creates REST and suppresses Pull ─
test('scenario 4 — an explicit override to rest resolves REST and validateTrainingDayContent suppresses a Pull directive', () => {
  const tds = resolveTrainingDayState({
    effectiveWorkout: { label: 'Rest', source: 'override', workoutId: 'rest', scheduledLabel: 'Pull', scheduledWorkoutId: 'pull' },
  });
  assert.equal(tds.state, TRAINING_DAY_STATE.REST);
  assert.deepEqual(tds.explicitOverride, { workoutId: 'rest', label: 'Rest' });
  assert.equal(tds.plannedWorkout.label, 'Pull', 'the original schedule is preserved for the conflict-resolution UI');

  const { valid, violations } = validateTrainingDayContent(tds, {
    action: "Today's Pull session (~45 min) is the only structured load.",
  });
  assert.equal(valid, false);
  assert.equal(violations[0].check, 'training_day_state_rest_vs_workout_directive');
});

test('scenario 4b — REST content that explicitly acknowledges the swap is not flagged', () => {
  const tds = resolveTrainingDayState({
    effectiveWorkout: { label: 'Rest', source: 'override', workoutId: 'rest', scheduledLabel: 'Pull', scheduledWorkoutId: 'pull' },
  });
  const { valid } = validateTrainingDayContent(tds, {
    action: 'Pull was scheduled, but today is marked as rest — take the day off from training.',
  });
  assert.equal(valid, true);
});

// ── 5. No missing-effectiveWorkout input is treated as ambiguity, not invention ──
test('scenario 5 — a missing effectiveWorkout resolves UNRESOLVED_CONFLICT rather than guessing a state', () => {
  const tds = resolveTrainingDayState({ effectiveWorkout: null });
  assert.equal(tds.state, TRAINING_DAY_STATE.UNRESOLVED_CONFLICT);
});

// ── 9. No paraphrase of the production contradiction slips past the guard ──
// Table of semantic equivalents the user's report explicitly called out
// (recover, take the day off, no training, genuine rest, avoid load) plus
// the exact production sentence itself — none may pass validateTrainingDayContent
// under a WORKOUT state, proving the fix is semantic, not a literal-phrase patch.
const REST_FRAMING_PARAPHRASES = [
  'Treat today as a genuine rest day, not a data point.', // the exact production sentence
  'Today is a full rest day — recharge before the week ahead.',
  "You're taking the day off from any structured training.",
  "There's no training scheduled for you today.",
  'Best to avoid load today and let your body recover.',
  'Nothing planned for the gym today.',
  'Stand down from training until tomorrow.',
  "Today calls for resting instead of a session.",
];
for (const [i, sentence] of REST_FRAMING_PARAPHRASES.entries()) {
  test(`scenario 9.${i + 1} — paraphrase "${sentence}" is caught under WORKOUT state (describesRestFraming + validateTrainingDayContent)`, () => {
    assert.equal(describesRestFraming(sentence), true, `expected describesRestFraming to flag: ${sentence}`);
    const tds = resolveTrainingDayState({ effectiveWorkout: PULL_SCHEDULED });
    const { valid, violations } = validateTrainingDayContent(tds, { synthesis: sentence });
    assert.equal(valid, false, `expected validateTrainingDayContent to reject: ${sentence}`);
    assert.equal(violations[0].check, 'training_day_state_workout_vs_rest_claim');
  });
}

// A legitimate scheduled "Recovery + Mobility" session must never be caught
// by the same broadened classifier — it's a real prescribed session, not an
// absence of one.
test('scenario 9b — a genuine "Recovery + Mobility" session framing never false-positives as rest framing', () => {
  assert.equal(describesRestFraming('Recovery is green at 88 today — a solid mobility session on tap.'), false);
});
