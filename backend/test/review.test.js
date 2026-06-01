const test = require('node:test');
const assert = require('node:assert/strict');
const { composeReview } = require('../src/intelligence/review');

test('composeReview builds a JSON-shaped weekly-review prompt from context', () => {
  const ctx = {
    periodStart: new Date('2026-05-23T00:00:00Z'),
    periodEnd: new Date('2026-05-30T00:00:00Z'),
    metrics: [
      { label: 'Sleep', thisWeek: 6.8, lastWeek: 7.4, change: -0.08, goodWhen: 'up', isTotal: false },
      { label: 'Spending', thisWeek: 6698, lastWeek: 5000, change: 0.34, goodWhen: null, isTotal: true },
    ],
    correlations: [{ title: 'Sleep ↔ Focus: strong positive correlation [confirmed]' }],
    forecasts: [{ title: 'Hit $260k: 0% likely' }],
    leverage: [{ title: 'Protect more sleep' }],
    annotations: [{ category: 'travel', label: 'NYC trip' }],
  };
  const { system, prompt } = composeReview(ctx);

  assert.match(system, /weekly review/i);
  assert.match(prompt, /Week of 2026-05-23 to 2026-05-30/);
  assert.match(prompt, /Sleep: 6.8 \(weekly avg\) \(-8% vs last week\)/);
  // Flow metrics are labeled as weekly totals (the Wealth/Insights fix).
  assert.match(prompt, /Spending: 6698 \(weekly total\)/);
  assert.match(prompt, /Sleep ↔ Focus/);
  assert.match(prompt, /Protect more sleep/);
  assert.match(prompt, /travel: NYC trip/);
  assert.match(prompt, /"headline"/); // asks for the JSON shape
});

test('composeReview tolerates an empty week', () => {
  const { prompt } = composeReview({
    periodStart: new Date('2026-05-23T00:00:00Z'),
    periodEnd: new Date('2026-05-30T00:00:00Z'),
    metrics: [], correlations: [], forecasts: [], leverage: [], annotations: [],
  });
  assert.match(prompt, /not enough data/i);
  assert.match(prompt, /none confirmed/i);
});
