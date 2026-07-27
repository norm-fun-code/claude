// Health tab redesign (audit rec #4) — required scenarios 8, 9, 10 (10's
// exact-target-drill-in is a UI wiring concern, verified by the component
// reusing `dismissKey`/title identity this module preserves through ranking).
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWorthKnowing, dedupeSleepAutonomicInsights } from './healthWorthKnowing.ts';
import type { Insight } from '../hooks/useBriefing';

function ins(overrides: Partial<Insight>): Insight {
  return { type: 'trend', title: 't', detail: 'd', confidence: 0.5, ...overrides } as Insight;
}

test('required 8: the landing page never surfaces more than 2 ranked developments, however many the server sent', () => {
  const many = Array.from({ length: 8 }, (_, i) => ins({ title: `insight ${i}`, type: 'anomaly', confidence: 0.9 - i * 0.05 }));
  const top = selectWorthKnowing(many);
  assert.equal(top.length, 2);
});

test('a live deviation (anomaly/strain) always outranks an evergreen data-quality flag', () => {
  const deviation = ins({ title: 'HRV dropped sharply', type: 'anomaly', confidence: 0.6 });
  const dataQuality = ins({ title: 'Sleep debt building', type: 'sleep_debt', confidence: 0.95 });
  const top = selectWorthKnowing([dataQuality, deviation], 2);
  assert.equal(top[0].title, 'HRV dropped sharply', 'tier must beat raw confidence');
});

test('required 9: a duplicate sleep→HRV and sleep→resting-HR observation for the same night is consolidated into one', () => {
  const hrvOne = ins({ title: 'Poor sleep linked to lower HRV', type: 'sleep_impact', confidence: 0.7 });
  const rhrOne = ins({ title: 'Poor sleep linked to higher resting HR', type: 'sleep_impact', confidence: 0.6 });
  const deduped = dedupeSleepAutonomicInsights([hrvOne, rhrOne]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].title, hrvOne.title, 'the more sensitive HRV-based reading is kept over the RHR duplicate');
});

test('dedup never removes unrelated insights, or a lone HRV/RHR mention with nothing to dedupe against', () => {
  const solo = ins({ title: 'HRV trending up this month', type: 'sleep_impact', confidence: 0.7 });
  const unrelated = ins({ title: 'Spending spike in dining', type: 'over_budget', confidence: 0.8 });
  assert.deepEqual(dedupeSleepAutonomicInsights([solo, unrelated]), [solo, unrelated]);
});

test('selectWorthKnowing is pure and total on empty/missing input', () => {
  assert.deepEqual(selectWorthKnowing(null), []);
  assert.deepEqual(selectWorthKnowing(undefined), []);
  assert.deepEqual(selectWorthKnowing([]), []);
});

test('required 10 (identity preserved through ranking): each surfaced insight keeps its original dismissKey/title so a drill-in can target the EXACT insight, not a re-derived copy', () => {
  const a = ins({ title: 'A', type: 'anomaly', dismissKey: 'key-a', confidence: 0.9 });
  const b = ins({ title: 'B', type: 'correlation', dismissKey: 'key-b', confidence: 0.8 });
  const top = selectWorthKnowing([a, b], 2);
  assert.equal(top[0], a, 'same object reference — never a copy that could drift from the deep-link target');
  assert.equal(top[1], b);
});
