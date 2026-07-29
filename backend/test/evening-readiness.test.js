const test = require('node:test');
const assert = require('node:assert/strict');
const {
  eveningHabitsToTrack, detectDeviceDataGap, isSickDay,
  isPastWindDownCutoff, classifyOpenHabits,
} = require('../src/intelligence/evening-readiness');

test('non-rest day tracks all evening habits, including Exercise', () => {
  const habits = eveningHabitsToTrack(false).map((h) => h.metric);
  assert.ok(habits.includes('exercise'));
  assert.ok(habits.includes('gratitude'));
  assert.ok(habits.includes('afternoon_tm'));
});

test('rest day excludes Exercise — there was no planned session to have done', () => {
  const habits = eveningHabitsToTrack(true).map((h) => h.metric);
  assert.ok(!habits.includes('exercise'));
  // The rest of the stack is unaffected — a rest day doesn't excuse gratitude/TM.
  assert.ok(habits.includes('gratitude'));
  assert.ok(habits.includes('afternoon_tm'));
});

// User report: logged "not feeling well, getting sick" 30 minutes before the
// evening brief built, but it still nagged "Still open: Exercise — a quick win
// before bed." A sick day should get the same treatment a rest day gives
// exercise, since it isn't a good idea while unwell.
test('sick day excludes Exercise — not a quick win while unwell', () => {
  const habits = eveningHabitsToTrack(false, true).map((h) => h.metric);
  assert.ok(!habits.includes('exercise'));
  assert.ok(habits.includes('gratitude'));
  assert.ok(habits.includes('afternoon_tm'));
});

test('isSickDay recognizes the exact reported phrasing', () => {
  assert.equal(isSickDay("Not feeling well today, think I'm getting sick"), true);
});

test('isSickDay recognizes common illness phrasing', () => {
  for (const text of ['Coming down with something', 'Have a fever tonight', 'Feeling pretty unwell', 'Under the weather today', 'Got the flu', 'Sore throat and congested', 'Getting chills']) {
    assert.equal(isSickDay(text), true, `"${text}" should read as a sick day`);
  }
});

test('isSickDay does not false-positive on casual words containing illness-like substrings', () => {
  for (const text of ['Chill day at home, did a cold shower and lifted', 'It was cold out today but I still ran', 'Netflix and chill tonight', 'Fluffy blanket weather']) {
    assert.equal(isSickDay(text), false, `"${text}" should NOT read as a sick day`);
  }
});

test('isSickDay is false for empty/missing context', () => {
  assert.equal(isSickDay(''), false);
  assert.equal(isSickDay(null), false);
  assert.equal(isSickDay(undefined), false);
});

// A dead/unworn Apple Watch (user report: "Watch was dead most of the day") should
// read as a data gap, not a real behavior dip that gets narrated as a below-baseline day.
test('detectDeviceDataGap flags when steps AND active energy both collapse together', () => {
  const flag = detectDeviceDataGap({
    load: { steps: 800, stepsBaseline: 8000, activeEnergy: 50, activeEnergyBaseline: 550 },
    isRestDay: false,
  });
  assert.ok(flag);
  assert.match(flag, /Watch gap/);
  assert.match(flag, /800/);
  assert.match(flag, /8,?000|8000/);
});

test('detectDeviceDataGap stays quiet when only one metric is low (a real quiet day, phone still tracked steps)', () => {
  const flag = detectDeviceDataGap({
    load: { steps: 7000, stepsBaseline: 8000, activeEnergy: 50, activeEnergyBaseline: 550 },
    isRestDay: false,
  });
  assert.equal(flag, null);
});

test('detectDeviceDataGap stays quiet on a scheduled rest day — low activity is expected, not a gap', () => {
  const flag = detectDeviceDataGap({
    load: { steps: 800, stepsBaseline: 8000, activeEnergy: 50, activeEnergyBaseline: 550 },
    isRestDay: true,
  });
  assert.equal(flag, null);
});

test('detectDeviceDataGap stays quiet without a real baseline to compare against', () => {
  const flag = detectDeviceDataGap({
    load: { steps: 800, stepsBaseline: null, activeEnergy: 50, activeEnergyBaseline: null },
    isRestDay: false,
  });
  assert.equal(flag, null);
});

test('detectDeviceDataGap stays quiet on a genuinely normal day', () => {
  const flag = detectDeviceDataGap({
    load: { steps: 8200, stepsBaseline: 8000, activeEnergy: 560, activeEnergyBaseline: 550 },
    isRestDay: false,
  });
  assert.equal(flag, null);
});

// ── Evening brief redesign: wind-down cutoff + TONIGHT vs LET GO split ─────

test('isPastWindDownCutoff: true at/after 9:00pm local, false before it', () => {
  assert.equal(isPastWindDownCutoff(new Date('2026-07-29T21:00:00-04:00'), 'America/New_York'), true);
  assert.equal(isPastWindDownCutoff(new Date('2026-07-29T23:30:00-04:00'), 'America/New_York'), true);
  assert.equal(isPastWindDownCutoff(new Date('2026-07-29T20:59:00-04:00'), 'America/New_York'), false);
  assert.equal(isPastWindDownCutoff(new Date('2026-07-29T14:00:00-04:00'), 'America/New_York'), false);
});

test('required: a missed afternoon meditation late at night is released to LET GO, not framed as a quick win', () => {
  const openHabits = [{ metric: 'afternoon_tm', label: 'Afternoon TM' }];
  const { tonight, letGo } = classifyOpenHabits(openHabits, { pastCutoff: true });
  assert.deepEqual(tonight, []);
  assert.deepEqual(letGo, ['Afternoon TM']);
});

test('required: exercise past the wind-down cutoff is released to LET GO — it competes with winding down, never an urgent quick win', () => {
  const openHabits = [{ metric: 'exercise', label: 'Exercise' }];
  const { tonight, letGo } = classifyOpenHabits(openHabits, { pastCutoff: true });
  assert.deepEqual(tonight, []);
  assert.deepEqual(letGo, ['Exercise']);
});

test('gratitude stays genuinely worth doing tonight even past the wind-down cutoff — calm and restorative, not competing with sleep', () => {
  const openHabits = [{ metric: 'gratitude', label: 'Gratitude journal' }];
  const { tonight, letGo } = classifyOpenHabits(openHabits, { pastCutoff: true });
  assert.deepEqual(tonight, ['Gratitude journal']);
  assert.deepEqual(letGo, []);
});

test('before the wind-down cutoff, all still-open habits are genuinely reachable tonight — none released yet', () => {
  const openHabits = [
    { metric: 'afternoon_tm', label: 'Afternoon TM' },
    { metric: 'exercise', label: 'Exercise' },
    { metric: 'gratitude', label: 'Gratitude journal' },
  ];
  const { tonight, letGo } = classifyOpenHabits(openHabits, { pastCutoff: false });
  assert.deepEqual(tonight.sort(), ['Afternoon TM', 'Exercise', 'Gratitude journal'].sort());
  assert.deepEqual(letGo, []);
});

test('a mixed still-open list splits correctly: gratitude stays TONIGHT, the rest move to LET GO past cutoff', () => {
  const openHabits = [
    { metric: 'gratitude', label: 'Gratitude journal' },
    { metric: 'afternoon_tm', label: 'Afternoon TM' },
    { metric: 'exercise', label: 'Exercise' },
  ];
  const { tonight, letGo } = classifyOpenHabits(openHabits, { pastCutoff: true });
  assert.deepEqual(tonight, ['Gratitude journal']);
  assert.deepEqual(letGo.sort(), ['Afternoon TM', 'Exercise'].sort());
});
