const test = require('node:test');
const assert = require('node:assert/strict');
const { composeFallback, composeEveningBrief } = require('../src/notify/evening-brief');
const llm = require('../src/llm');

const sig = (autonomic, load = {}, openHabits = []) => ({
  autonomic: { tone: 'settled', sampleThin: false, hrv: null, hrvBaseline: null, rhr: null, rhrBaseline: null, ...autonomic },
  load: { steps: null, stepsBaseline: null, activeEnergy: null, ...load },
  openHabits,
});

test('settled tone → settled headline and restorative read', () => {
  const c = composeFallback(sig({ tone: 'settled', hrv: 44, hrvBaseline: 42, rhr: 54, rhrBaseline: 55 }));
  assert.equal(c.tone, 'settled');
  assert.match(c.headline, /settled/i);
  assert.match(c.readiness, /settled|room/i);
  assert.match(c.readiness, /44 ms/);
  assert.match(c.readiness, /54 bpm/);
});

test('elevated tone → still-spending wind-down read', () => {
  const c = composeFallback(sig({ tone: 'elevated', hrv: 32, hrvBaseline: 42, rhr: 62, rhrBaseline: 55 }));
  assert.equal(c.tone, 'elevated');
  assert.match(c.headline, /protect tonight/i);
  assert.match(c.readiness, /spending|banks/i);
  assert.match(c.tomorrow, /bedtime/i);
});

test('thin data → soft read, never fabricates numbers', () => {
  const c = composeFallback(sig({ tone: 'unknown', sampleThin: true }));
  assert.match(c.readiness, /soft read|how you actually feel/i);
  assert.doesNotMatch(c.readiness, /\bms\b|\bbpm\b/);
});

test('steps under baseline are framed as under-norm', () => {
  const c = composeFallback(sig({ tone: 'mild', hrv: 38, hrvBaseline: 42 }, { steps: 8400, stepsBaseline: 11000 }));
  assert.match(c.today, /8,400/);
  assert.match(c.today, /under your 11,000 norm/);
});

test('open evening habits are listed; none → empty string', () => {
  const withHabits = composeFallback(sig({ tone: 'settled' }, {}, ['Gratitude journal', 'Cold shower']));
  assert.match(withHabits.habits, /Gratitude journal, Cold shower/);
  const none = composeFallback(sig({ tone: 'settled' }, {}, []));
  assert.equal(none.habits, '');
});

// ── Required regression: evidence language must respect claim confidence —
// a "mild" tone is ONE signal a touch off baseline, not a confirmed problem,
// and must never read as more certain than that (no "pays off by morning",
// no declarative "load"/"stress" claim). HRV essentially at baseline plus a
// modest ~3bpm RHR elevation is exactly the combination the point-threshold
// classifier (evening-readiness.js's autonomicRead) scores as 'mild', not
// 'elevated' — this test proves the fallback prose for that exact tone is
// hedged, not overconfident. ─────────────────────────────────────────────
test('required: HRV at baseline + modestly elevated RHR (mild tone) reads hedged, never overconfident', () => {
  const c = composeFallback(sig({ tone: 'mild', hrv: 42, hrvBaseline: 42, rhr: 58, rhrBaseline: 55 }));
  assert.match(c.readiness, /touch outside your norm|reasonable/i);
  assert.doesNotMatch(c.readiness, /pays off by morning/i);
  assert.doesNotMatch(c.readiness, /\bload\b|\bstress\b/i);
});

test('required: mild-tone headline names ONE signal off baseline, not a confirmed problem', () => {
  const c = composeFallback(sig({ tone: 'mild', hrv: 42, hrvBaseline: 42, rhr: 58, rhrBaseline: 55 }));
  assert.match(c.headline, /touch off baseline/i);
  assert.doesNotMatch(c.headline, /wind down for real/i);
});

test('required: elevated tone (genuinely confirmed combined read) is allowed firmer, but still hedged, language', () => {
  const c = composeFallback(sig({ tone: 'elevated', hrv: 30, hrvBaseline: 42, rhr: 63, rhrBaseline: 55 }));
  assert.match(c.readiness, /may help/i);
  assert.doesNotMatch(c.readiness, /pays off by morning|single biggest lever/i);
});

// ── Required regression: still-open habits split into TONIGHT vs LET GO —
// see evening-readiness.js's classifyOpenHabits/isPastWindDownCutoff. This
// module only renders whatever split it's given; the classification itself
// is covered in evening-readiness.test.js. ──────────────────────────────
test('required: letGo habits render as a deliberate release, never as a missed quick win', () => {
  const c = composeFallback({ ...sig({ tone: 'settled' }, {}, []), letGoHabits: ['Afternoon TM', 'Exercise'] });
  assert.match(c.letGo, /let go of afternoon tm and exercise/i);
  assert.doesNotMatch(c.letGo, /quick win|hurry|catch up/i);
});

test('required: no letGo habits → empty string, no phantom "let go" beat', () => {
  const c = composeFallback(sig({ tone: 'settled' }, {}, []));
  assert.equal(c.letGo, '');
});

test('signals are passed through for the card chips', () => {
  const c = composeFallback(sig({ tone: 'mild', hrv: 38, hrvBaseline: 42, rhr: 58, rhrBaseline: 55 }, { steps: 12000 }));
  assert.equal(c.signals.hrv, 38);
  assert.equal(c.signals.rhr, 58);
  assert.equal(c.signals.steps, 12000);
});

test('reflection: recent gratitude → echo, none → omitted entirely (never an invented prompt)', () => {
  const withG = composeFallback({ ...sig({ tone: 'settled' }), gratitude: [{ log_date: '2026-07-01', text: 'a quiet morning' }] });
  assert.match(withG.reflection, /grateful for/i);
  const none = composeFallback(sig({ tone: 'settled' }));
  assert.equal(none.reflection, '');
  assert.notEqual(withG.reflection, none.reflection);
});

// ── Rest day: a rest day means no planned hard TRAINING — it does NOT mean
// low steps. Steps are judged against the user's own baseline regardless of
// rest-day status; "expected/fine" language is about training, never a cover
// for mislabeling substantial movement as light. ──────────────────────────

test('rest day + steps ABOVE baseline: framed as plenty of movement, never "light"/"low"/"lighter"', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }, { steps: 11842, stepsBaseline: 9000 }),
    isRestDay: true,
  });
  assert.match(c.today, /11,842/);
  assert.match(c.today, /rest day/i);
  assert.doesNotMatch(c.today, /\blight(?:er)?\b|\blow(?:er)?\b/i);
  assert.match(c.today, /plenty of movement|structured training/i);
});

test('rest day + steps BELOW baseline: honestly cites the norm — a rest day does not suppress the comparison', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }, { steps: 5392, stepsBaseline: 12731 }),
    isRestDay: true,
  });
  assert.match(c.today, /5,392/);
  assert.match(c.today, /rest day/i);
  assert.match(c.today, /under your 12,731 norm/);
});

test('rest day + NO valid step baseline: neutral factual language only, never "high"/"low"/"lighter"', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }, { steps: 8000, stepsBaseline: null }),
    isRestDay: true,
  });
  assert.match(c.today, /8,000/);
  assert.match(c.today, /rest day/i);
  assert.doesNotMatch(c.today, /\bhigh\b|\blow(?:er)?\b|\blight(?:er)?\b/i);
});

test('training day + LOW steps: still compared honestly against baseline (no rest-day special-casing to hide behind)', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }, { steps: 5392, stepsBaseline: 12731 }),
    isRestDay: false,
  });
  assert.match(c.today, /under your 12,731 norm/);
});

test('rest day: the plan line does not grade the rest itself as a miss', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }),
    training: { planned: 'Rest', completed: false, actual: null },
    isRestDay: true,
  });
  assert.equal(c.plan, ''); // nothing to grade — matches the pre-existing training.planned==='rest' guard
});

// ── Workout-identity fix: the exact production reproduction ────────────────
// "Planned 4×4 Intervals — done (logged as walk)." must never be produced
// again. `training.completed` now means ONLY "the effective workout was
// EXPLICITLY completed" (canonical plannedWorkoutCompleted) — a walk logged
// on an Intervals day must read as NOT completed, with the walk described
// plainly as what it is.

test('THE EXACT REPRODUCTION: Intervals planned + a 60-minute walk logged => "not marked complete; logged a 60-minute walk.", never "done"', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }),
    training: {
      planned: '4×4 Intervals',
      completed: false,
      actual: 'walk',
      actualActivityDescription: 'a 60-minute walk',
      hasExtraActivity: false,
      extraActivityDescription: null,
    },
  });
  assert.equal(c.plan, 'Planned 4×4 Intervals — not marked complete; logged a 60-minute walk.');
  assert.doesNotMatch(c.plan, /\bdone\b/i, 'must never say "done" when the planned workout was not explicitly completed');
  assert.doesNotMatch(c.plan, /logged as walk/i, 'must never use the old "done (logged as X)" phrasing');
});

test('explicit Intervals completion => "done." wording, no walk to mention', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }),
    training: {
      planned: '4×4 Intervals',
      completed: true,
      actual: 'intervals',
      actualActivityDescription: null,
      hasExtraActivity: false,
      extraActivityDescription: null,
    },
  });
  assert.equal(c.plan, 'Planned 4×4 Intervals — done.');
});

test('mixed: explicit Intervals completion PLUS an additional walk => "done." plus a SEPARATE mention of the walk, never describing the walk as Intervals', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }),
    training: {
      planned: '4×4 Intervals',
      completed: true,
      actual: 'intervals',
      actualActivityDescription: 'a walk',
      hasExtraActivity: true,
      extraActivityDescription: 'a walk',
    },
  });
  assert.equal(c.plan, 'Planned 4×4 Intervals — done. Also logged a walk today.');
  assert.doesNotMatch(c.plan, /logged as walk/i);
});

test('generic Exercise habit alone (no specific activity logged) falls back to the original "not logged as done" wording', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }),
    training: {
      planned: '4×4 Intervals',
      completed: false,
      actual: null,
      actualActivityDescription: null,
      hasExtraActivity: false,
      extraActivityDescription: null,
    },
  });
  assert.equal(c.plan, 'Planned 4×4 Intervals — not logged as done; the day\'s closed either way.');
});

// ── Tomorrow-awareness: the bedtime lever gets concrete when there's an early
// commitment on record. A day off may be named as a fact but never loosens
// the advice itself — that's driven only by sleep debt/tone. ───────────────

test('an early first event tomorrow tightens the bedtime line with the specific commitment', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }),
    tomorrowFirstEvent: '"Client call" at 7:30 AM',
  });
  assert.match(c.tomorrow, /7:30 AM/);
  assert.match(c.tomorrow, /bed on time/i);
});

test('tomorrow a day off, NO sleep debt, settled tone: normal settled wind-down line — never framed as "more room"', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }),
    tomorrowIsDayOff: true,
    sleepBalance: { net: 0.5, nights: 5, need: 8 },
  });
  assert.doesNotMatch(c.tomorrow, /more room|no rush|stay up|slack tonight/i);
  assert.match(c.tomorrow, /bedtime window/i);
});

// ── A free/day-off tomorrow must never be treated as permission to shorten
// sleep — the wind-down lever is grounded in the canonical 7-night sleep
// balance (recovery.js's sleepBalance7) and tonight's autonomic tone, not in
// whether tomorrow happens to be open. ──────────────────────────────────────

test('tomorrow free BUT a real sleep deficit is on record: normal/firmer wind-down still applies, day off does not loosen it', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }),
    tomorrowIsDayOff: true,
    sleepBalance: { net: -4.5, nights: 6, need: 8 },
  });
  assert.match(c.tomorrow, /sleep deficit|catch up/i);
  assert.doesNotMatch(c.tomorrow, /more room|no rush|stay up|slack tonight|doesn'?t matter/i);
});

test('day off tomorrow names the holiday when there is one, still without "more room" framing', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }),
    tomorrowIsDayOff: true,
    tomorrowHoliday: 'Independence Day',
    sleepBalance: { net: 0.5, nights: 5, need: 8 },
  });
  assert.match(c.tomorrow, /Independence Day/);
  assert.doesNotMatch(c.tomorrow, /more room|no rush|stay up/i);
});

test('an early event takes priority over a day-off flag if both are somehow set', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }),
    tomorrowFirstEvent: 'a meeting at 8:00 AM',
    tomorrowIsDayOff: true,
  });
  assert.match(c.tomorrow, /8:00 AM/);
});

test('no tomorrow context (normal workday, nothing early) falls back to the generic bedtime line', () => {
  const c = composeFallback(sig({ tone: 'settled' }));
  assert.match(c.tomorrow, /bedtime window/i);
});

// ── Today's check-in: the body can look settled while the day genuinely
// wasn't — a low self-report should still surface, not just HRV/RHR ──────────

test('a low self-reported check-in surfaces even when HRV/RHR read as settled — in plain words, never a raw score', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled', hrv: 44, hrvBaseline: 42 }),
    checkin: { mood: 2, energy: 2, focus: 4 },
  });
  assert.match(c.readiness, /mood and energy/);
  assert.match(c.readiness, /low/);
  assert.doesNotMatch(c.readiness, /\d\/5/); // never a raw "2/5" style score
  assert.doesNotMatch(c.readiness, /focus/); // only the low ones are called out
});

test('a normal/high check-in does not get tacked onto the readiness read', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }),
    checkin: { mood: 4, energy: 5, focus: 4 },
  });
  assert.doesNotMatch(c.readiness, /mood|energy|focus/i);
});

test('no check-in logged does not alter the readiness read', () => {
  const withNull = composeFallback({ ...sig({ tone: 'settled' }), checkin: null });
  const withoutKey = composeFallback(sig({ tone: 'settled' }));
  assert.equal(withNull.readiness, withoutKey.readiness);
});

// ── composeEveningBrief end-to-end: the LLM path is neutralized too ────────
// Even if the model itself slips and writes the old buggy wording, the
// deterministic post-generation guard (evening-brief-validator.js's
// checkWorkoutCompletionOverclaim) must catch and replace it — this is not
// just a composeFallback-level fix.

test('an LLM result that says "done (logged as walk)" gets neutralized back to the safe fallback wording', async () => {
  const originalGenerateText = llm.generateText;
  llm.generateText = async () => JSON.stringify({
    headline: 'Settled tonight',
    readiness: 'Your body looks settled tonight.',
    today: 'A normal day of movement.',
    plan: 'Planned 4×4 Intervals — done (logged as walk).',
    tomorrow: 'Hold your bedtime window.',
    habits: '',
    reflection: 'Take a moment for gratitude.',
  });
  try {
    const signals = {
      ...sig({ tone: 'settled' }),
      training: {
        planned: '4×4 Intervals',
        completed: false,
        actual: 'walk',
        actualActivityDescription: 'a 60-minute walk',
        hasExtraActivity: false,
        extraActivityDescription: null,
      },
      trainingOutcome: { plannedWorkoutCompleted: false, plannedWorkoutLabel: '4×4 Intervals' },
    };
    const result = await composeEveningBrief(signals);
    assert.doesNotMatch(result.plan, /done \(logged as walk\)/i, 'the false completion claim must never survive to the final result');
    assert.equal(result.plan, 'Planned 4×4 Intervals — not marked complete; logged a 60-minute walk.', 'replaced with the safe, canonical fallback wording');
  } finally {
    llm.generateText = originalGenerateText;
  }
});

test('an LLM result that correctly says the plan was NOT completed passes through untouched', async () => {
  const originalGenerateText = llm.generateText;
  llm.generateText = async () => JSON.stringify({
    headline: 'Settled tonight',
    readiness: 'Your body looks settled tonight.',
    today: 'A normal day of movement.',
    plan: 'You had 4×4 Intervals on the books but it was not marked complete — a walk went in the books instead.',
    tomorrow: 'Hold your bedtime window.',
    habits: '',
    reflection: 'Take a moment for gratitude.',
  });
  try {
    const signals = {
      ...sig({ tone: 'settled' }),
      training: {
        planned: '4×4 Intervals',
        completed: false,
        actual: 'walk',
        actualActivityDescription: 'a 60-minute walk',
        hasExtraActivity: false,
        extraActivityDescription: null,
      },
      trainingOutcome: { plannedWorkoutCompleted: false, plannedWorkoutLabel: '4×4 Intervals' },
    };
    const result = await composeEveningBrief(signals);
    assert.match(result.plan, /not marked complete/i);
  } finally {
    llm.generateText = originalGenerateText;
  }
});
