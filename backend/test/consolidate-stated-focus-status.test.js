// Bug: the chief brief described an OPEN weekly goal ("Valuation presentation
// to Steffan") as done. Part of the root cause: the self-model's STATED FOCUS
// line (consolidate.js's buildModelText) rendered bare goal text with NO
// [OPEN]/[DONE] status — `intention.goals.map(g => g.text).join(', ')` — so
// every downstream prompt that reads the self-model (the chief brief among
// them) had no completion signal for that goal AT ALL, leaving the model free
// to guess from something weaker (a calendar event, a prior brief's wording).
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildModelText } = require('../src/intelligence/consolidate');

const base = {
  wellbeing: {}, health: {}, habits: {}, wealth: {},
  goals: [], experiments: { completed: [], running: [] },
  findings: { correlations: [], leverage: [] },
  annotations: [], dayContext: [], beliefs: [],
};

test('STATED FOCUS retains [OPEN]/[DONE] status per goal, not bare text', () => {
  const text = buildModelText({
    ...base,
    intention: {
      weekStart: '2026-07-13',
      goals: [
        { text: 'Valuation presentation to Steffan', achieved: false },
        { text: 'Finish the Q3 board deck', achieved: true },
      ],
      context: '',
    },
  });
  assert.match(text, /\[OPEN\] Valuation presentation to Steffan/);
  assert.match(text, /\[DONE\] Finish the Q3 board deck/);
});

test('a legacy plain-string goal (no achieved field) defaults to OPEN, never DONE', () => {
  const text = buildModelText({
    ...base,
    intention: { weekStart: '2026-07-13', goals: ['Ship the release'], context: '' },
  });
  assert.match(text, /\[OPEN\] Ship the release/);
  assert.doesNotMatch(text, /\[DONE\] Ship the release/);
});

test('no intention → no STATED FOCUS line at all', () => {
  const text = buildModelText({ ...base, intention: null });
  assert.doesNotMatch(text, /STATED FOCUS/);
});
