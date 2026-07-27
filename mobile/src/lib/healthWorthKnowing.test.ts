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

test('required 9: two emissions of the SAME sleep->HRV observation (same type, same driver+outcome evidence) consolidate into the higher-confidence one', () => {
  const strong = ins({
    title: 'Poor sleep linked to lower HRV', type: 'sleep_impact', confidence: 0.7,
    evidence: { driver: 'health:sleep_duration', outcome: 'health:hrv' },
  });
  const weak = ins({
    title: 'Poor sleep linked to lower HRV (redo)', type: 'sleep_impact', confidence: 0.4,
    evidence: { driver: 'health:sleep_duration', outcome: 'health:hrv' },
  });
  const deduped = dedupeSleepAutonomicInsights([strong, weak]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].title, strong.title, 'the higher-confidence emission of the identical observation is kept');
});

test('a distinct resting-HR finding is never suppressed merely because an HRV sleep finding also fired — different evidence.outcome, different observation', () => {
  const hrvFinding = ins({
    title: 'Poor sleep linked to lower HRV', type: 'sleep_impact', confidence: 0.7,
    evidence: { driver: 'health:sleep_duration', outcome: 'health:hrv' },
  });
  const rhrFinding = ins({
    title: 'Poor sleep linked to higher resting HR', type: 'sleep_impact', confidence: 0.6,
    evidence: { driver: 'health:sleep_duration', outcome: 'health:resting_hr' },
  });
  const deduped = dedupeSleepAutonomicInsights([hrvFinding, rhrFinding]);
  assert.equal(deduped.length, 2, 'HRV and resting-HR are different metrics — both must survive');
});

test('dedup never removes unrelated insights, or a lone finding with nothing to dedupe against', () => {
  const solo = ins({
    title: 'HRV trending up this month', type: 'sleep_impact', confidence: 0.7,
    evidence: { driver: 'health:sleep_duration', outcome: 'health:hrv' },
  });
  const unrelated = ins({ title: 'Spending spike in dining', type: 'over_budget', confidence: 0.8 });
  assert.deepEqual(dedupeSleepAutonomicInsights([solo, unrelated]), [solo, unrelated]);
});

test('findings with no resolvable evidence identity are never deduped against each other, even with matching type/text', () => {
  const a = ins({ title: 'Poor sleep linked to lower HRV', type: 'sleep_impact', confidence: 0.7 });
  const b = ins({ title: 'Poor sleep linked to lower HRV', type: 'sleep_impact', confidence: 0.6 });
  assert.deepEqual(dedupeSleepAutonomicInsights([a, b]), [a, b], 'no evidence shape to key on — never risk a false merge');
});

test('an unrecognized/unknown finding type defaults to the lowest (informational) tier, never the milestone tier', () => {
  const unknown = ins({ title: 'Something new', type: 'a_brand_new_type_never_seen_before', confidence: 0.9 });
  const milestone = ins({ title: 'Consistency streak', type: 'habit_consistency', confidence: 0.5 });
  const top = selectWorthKnowing([unknown, milestone], 2);
  assert.equal(top[0].title, milestone.title, 'a real milestone must outrank an unrecognized type despite lower confidence');
});

test('daytime_cardio (Apple Watch daytime HRV/RHR vs lifestyle levers) is classified as a confirmed pattern (tier 2), not demoted by the unknown-type fallback', () => {
  const daytime = ins({ title: 'Eating well: daytime HRV higher', type: 'daytime_cardio', confidence: 0.6 });
  const deviation = ins({ title: 'HRV dropped sharply', type: 'anomaly', confidence: 0.6 });
  const milestone = ins({ title: 'Consistency streak', type: 'habit_consistency', confidence: 0.9 });
  const top = selectWorthKnowing([milestone, daytime, deviation], 3);
  assert.deepEqual(top.map((i) => i.title), [deviation.title, daytime.title, milestone.title], 'tier order: deviation > pattern > milestone');
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
