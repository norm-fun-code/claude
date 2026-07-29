// Bug: red recovery auto-swapped today's Health-tab session from Push to
// Mobility (mirroring the mobile client's own zone-based downgrade), but the
// chief brief's "Today's workout" line still said Push with no idea a swap
// had already happened — the LLM wrote "scale back today's Push" hours after
// the user's app had already, correctly, replaced it with Mobility.
//
// routes/briefing.js's resolveWorkoutForPrompt() now builds an explicit
// `autoSwapNote` whenever services/workout.js's getEffectiveWorkout() reports
// source==='auto_downgrade', and buildChiefBriefPrompt() must weave it into
// the prompt right after the "Today's workout:" line so the model narrates
// the swap as already-done and correct instead of ignoring it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChiefBriefPrompt } = require('../src/services/briefing-ai');

function callWithWorkoutPlan(workoutPlan) {
  return buildChiefBriefPrompt([], 'Thursday', workoutPlan, [], '', '', '', '', '', '', [], '', '', '', '', '', '', '', '', '');
}

test('an auto-downgraded workout plan\'s note is woven into the prompt right after "Today\'s workout:"', () => {
  const workoutPlan = {
    type: 'Mobility',
    duration: '20–30 min + an easy walk',
    autoSwapNote:
      'NOTE: today\'s session was AUTOMATICALLY swapped from the scheduled Push to Mobility because last night\'s recovery came in red. This already happened — it is not a suggestion — and it was the correct, protective call.',
  };
  const prompt = callWithWorkoutPlan(workoutPlan);
  assert.match(prompt, /Today's workout: Mobility \(20–30 min \+ an easy walk\)/);
  assert.match(prompt, /AUTOMATICALLY swapped from the scheduled Push to Mobility/);
  assert.match(prompt, /already happened — it is not a suggestion/);
});

test('the note explicitly forbids telling the user to scale back the ORIGINAL session', () => {
  const workoutPlan = {
    type: 'Mobility',
    duration: null,
    autoSwapNote: 'NOTE: ... do NOT tell the user to scale back, modify, or go easier on the ORIGINAL Push session, since that is no longer today\'s plan.',
  };
  const prompt = callWithWorkoutPlan(workoutPlan);
  assert.match(prompt, /do NOT tell the user to scale back.*ORIGINAL Push session/s);
});

test('a normal (non-downgraded) workout plan with no autoSwapNote produces no auto-swap language at all', () => {
  const workoutPlan = { type: 'Push', duration: '~45 min', autoSwapNote: null };
  const prompt = callWithWorkoutPlan(workoutPlan);
  assert.match(prompt, /Today's workout: Push \(~45 min\)/);
  assert.doesNotMatch(prompt, /AUTOMATICALLY swapped/);
  assert.doesNotMatch(prompt, /NOTE:/);
});

test('a workout plan that never sets autoSwapNote at all (undefined) is handled the same as null', () => {
  const workoutPlan = { type: 'Rest', duration: null };
  const prompt = callWithWorkoutPlan(workoutPlan);
  assert.match(prompt, /Today's workout: Rest/);
  assert.doesNotMatch(prompt, /AUTOMATICALLY swapped/);
});

// Hardening pass, item 6: the hardcoded "Green=train as planned |
// Yellow=downgrade intensity | Red=mobility/walk only" guidance
// (workoutPromptShape's old hrvNote field) contradicted the centralized
// near-green presentation (intelligence/recoveryPresentation.js) — a score
// of 59 is canonically yellow but must NOT automatically read as "downgrade
// intensity." The field is now deleted entirely (it was never actually
// interpolated into the prompt template — recoveryContext already carries
// the correct presentation-tier guidance), so no prompt built from any
// workout plan shape can ever reintroduce that contradiction.
test('required: no chief-brief prompt can contain the deleted hardcoded HRV downgrade guidance, for any workout plan shape', () => {
  const shapes = [
    { type: 'Push', duration: '~45 min', hrTarget: '150', protein: '40g', autoSwapNote: null },
    { type: 'Mobility', duration: '20–30 min + an easy walk', autoSwapNote: 'NOTE: swapped from Push to Mobility.' },
    { type: 'Rest', duration: null },
  ];
  for (const workoutPlan of shapes) {
    assert.equal('hrvNote' in workoutPlan, false, 'the prompt-facing workout shape must not carry an hrvNote field at all');
    const prompt = callWithWorkoutPlan(workoutPlan);
    assert.doesNotMatch(prompt, /Green=train as planned/);
    assert.doesNotMatch(prompt, /Yellow=downgrade intensity/);
    assert.doesNotMatch(prompt, /Red=mobility\/walk only/);
  }
});

test('required: workoutPromptShape() (routes/briefing.js) and getWorkout() (services/workout.js) no longer return an hrvNote field', () => {
  const { workoutPromptShape } = require('../src/routes/briefing');
  const { getWorkout } = require('../src/services/workout');
  const shaped = workoutPromptShape({ label: 'Push', duration: '~45 min', hrTarget: '150', protein: '40g', source: 'scheduled' });
  assert.equal('hrvNote' in shaped, false);
  const scheduled = getWorkout('Monday');
  assert.equal('hrvNote' in scheduled, false);
});
