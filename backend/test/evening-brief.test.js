const test = require('node:test');
const assert = require('node:assert/strict');
const { composeFallback } = require('../src/notify/evening-brief');

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

test('signals are passed through for the card chips', () => {
  const c = composeFallback(sig({ tone: 'mild', hrv: 38, hrvBaseline: 42, rhr: 58, rhrBaseline: 55 }, { steps: 12000 }));
  assert.equal(c.signals.hrv, 38);
  assert.equal(c.signals.rhr, 58);
  assert.equal(c.signals.steps, 12000);
});

test('reflection: recent gratitude → echo, none → invite', () => {
  const withG = composeFallback({ ...sig({ tone: 'settled' }), gratitude: [{ log_date: '2026-07-01', text: 'a quiet morning' }] });
  assert.match(withG.reflection, /grateful for/i);
  const none = composeFallback(sig({ tone: 'settled' }));
  assert.match(none.reflection, /grateful/i);
  assert.notEqual(withG.reflection, none.reflection);
});

// ── Rest day: lower steps + no exercise habit are expected, not a shortfall ──

test('rest day: lower steps framed as expected, not "under norm"', () => {
  const c = composeFallback({
    ...sig({ tone: 'settled' }, { steps: 5392, stepsBaseline: 12731 }),
    isRestDay: true,
  });
  assert.match(c.today, /5,392/);
  assert.match(c.today, /rest day/i);
  assert.doesNotMatch(c.today, /under your/i);
});

test('non-rest day still frames steps against the norm as before', () => {
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
