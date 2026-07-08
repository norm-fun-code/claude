const test = require('node:test');
const assert = require('node:assert/strict');
const { eveningHabitsToTrack, detectDeviceDataGap, isSickDay } = require('../src/intelligence/evening-readiness');

test('non-rest day tracks all evening habits, including Exercise', () => {
  const habits = eveningHabitsToTrack(false).map((h) => h.metric);
  assert.ok(habits.includes('exercise'));
  assert.ok(habits.includes('gratitude'));
  assert.ok(habits.includes('afternoon_tm'));
  assert.ok(habits.includes('cold_shower'));
});

test('rest day excludes Exercise — there was no planned session to have done', () => {
  const habits = eveningHabitsToTrack(true).map((h) => h.metric);
  assert.ok(!habits.includes('exercise'));
  // The rest of the stack is unaffected — a rest day doesn't excuse gratitude/TM/shower.
  assert.ok(habits.includes('gratitude'));
  assert.ok(habits.includes('afternoon_tm'));
  assert.ok(habits.includes('cold_shower'));
});

// User report: logged "not feeling well, getting sick" 30 minutes before the
// evening brief built, but it still nagged "Still open: Cold shower, Exercise —
// quick wins before bed." A sick day should get the same treatment a rest day
// gives exercise — extended to cold shower too, since neither is a good idea
// while unwell.
test('sick day excludes BOTH Exercise and Cold shower — neither is a quick win while unwell', () => {
  const habits = eveningHabitsToTrack(false, true).map((h) => h.metric);
  assert.ok(!habits.includes('exercise'));
  assert.ok(!habits.includes('cold_shower'));
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
