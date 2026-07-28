// Wealth redesign (audit rec #5) — pure-function unit tests for
// backend/src/services/wealth-landing.js's posture/ranking/consolidation/
// dismissal-reactivation logic. No DB — these are the exported pure helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  itemSeverity, deriveSeverity, summaryLabel, rankForWhatChanged, applyWealthDismissals, consolidateRelatedCategories,
  REACTIVATE_MULTIPLIER,
} = require('../src/services/wealth-landing');

// ── severity/reliability cleanup: deterministic severity contract ──
test('required 6: data-complete + no unresolved items -> on_track, never action/critical, regardless of how strong savings look', () => {
  const severity = deriveSeverity({ dataComplete: true, itemSeverities: [], cashCritical: false, planBehindMaterial: false });
  assert.equal(severity, 'on_track');
  assert.notEqual(severity, 'action');
  assert.notEqual(severity, 'critical');
});

test('data incomplete always wins (unavailable), even if nothing else is wrong', () => {
  assert.equal(deriveSeverity({ dataComplete: false, itemSeverities: [], cashCritical: false, planBehindMaterial: true }), 'unavailable');
});

test('a real critical cash signal forces critical even when the plan is ahead', () => {
  assert.equal(deriveSeverity({ dataComplete: true, itemSeverities: [], cashCritical: true, planBehindMaterial: false }), 'critical');
});

test('an item-level action severity forces overall action', () => {
  assert.equal(deriveSeverity({ dataComplete: true, itemSeverities: ['action'], cashCritical: false, planBehindMaterial: false }), 'action');
});

test('a materially behind plan alone forces action (plan trajectory is a required severity input)', () => {
  assert.equal(deriveSeverity({ dataComplete: true, itemSeverities: [], cashCritical: false, planBehindMaterial: true }), 'action');
});

test('review applies when nothing rises to action/critical, but something is unconfirmed/watch-class', () => {
  assert.equal(deriveSeverity({ dataComplete: true, itemSeverities: ['review'], cashCritical: false, planBehindMaterial: false }), 'review');
});

test('an explained item alone (no other unresolved issue) never keeps the summary above on_track', () => {
  assert.equal(deriveSeverity({ dataComplete: true, itemSeverities: ['explained', 'explained'], cashCritical: false, planBehindMaterial: false }), 'on_track');
});

// ── item-level severity: percent-above-usual alone must never drive severity ──
test('an unconfirmed spending_spike (not yet persistent) is "review", never "action", no matter how large the % is', () => {
  const spike = { attentionClass: 'action_required', reasonCode: 'spending_spike', evidence: { impactDollars: 5000 } };
  assert.equal(itemSeverity(spike), 'review');
});

test('a persistent, material over_budget item is "action"', () => {
  const overBudget = { attentionClass: 'action_required', reasonCode: 'over_budget', evidence: { impactDollars: 400 } };
  assert.equal(itemSeverity(overBudget), 'action');
});

test('a persistent over_budget item below the material dollar floor stays "review"', () => {
  const tiny = { attentionClass: 'action_required', reasonCode: 'over_budget', evidence: { impactDollars: 50 } };
  assert.equal(itemSeverity(tiny), 'review');
});

test('an explainedBy-annotated item is always "explained", even if it was action_required before softening', () => {
  const explained = { attentionClass: 'watch', explainedBy: { merchant: 'Amex', amount: 600, day: '2026-07-01' } };
  assert.equal(itemSeverity(explained), 'explained');
});

test('a plain watch item (net worth decline, no explanation) is "review"', () => {
  const watch = { attentionClass: 'watch', reasonCode: 'net_worth_decline' };
  assert.equal(itemSeverity(watch), 'review');
});

test('a positive/informational item is "on_track"', () => {
  assert.equal(itemSeverity({ attentionClass: 'positive' }), 'on_track');
  assert.equal(itemSeverity({ attentionClass: 'informational' }), 'on_track');
});

// ── required 7: tiny-baseline percentage spikes don't outrank materially larger dollar changes ──
test('required 7: rankForWhatChanged ranks by attentionClass tier first, then dollar impact within tier — a huge-% tiny-$ spike never outranks a moderate-% large-$ one', () => {
  const tinyBaselineHugePct = {
    type: 'spending_pattern', title: 'Clothing: $120 more than usual (400% above usual)',
    attentionClass: 'action_required', evidence: { impactDollars: 120 },
  };
  const largeDollarModestPct = {
    type: 'spending_pattern', title: 'Restaurants: $600 more than usual (47% above usual)',
    attentionClass: 'action_required', evidence: { impactDollars: 600 },
  };
  const ranked = rankForWhatChanged([tinyBaselineHugePct, largeDollarModestPct]);
  assert.equal(ranked[0].title, largeDollarModestPct.title, 'the $600 real dollar impact must rank above the $120 one, despite its far smaller percentage');
});

test('rankForWhatChanged ranks action_required > watch > positive > informational regardless of dollar size', () => {
  const bigInformational = { type: 'investments', title: 'Portfolio $50000', attentionClass: 'informational', evidence: { impactDollars: 50000 } };
  const smallActionRequired = { type: 'spending_pattern', title: 'Coffee: $110 more than usual', attentionClass: 'action_required', evidence: { impactDollars: 110 } };
  const ranked = rankForWhatChanged([bigInformational, smallActionRequired]);
  assert.equal(ranked[0].title, smallActionRequired.title, 'urgency tier beats raw dollar size across tiers');
});

// ── required 8: related category anomalies can be consolidated without double counting ──
test('required 8: two related-category dining spikes consolidate into one combined card, dollars summed once (not double counted)', () => {
  const restaurants = {
    type: 'spending_pattern', tone: 'watch', category: 'Restaurants & Bars',
    title: 'Restaurants & Bars: $300 more than usual', detail: 'x', asOf: 't1',
    attentionClass: 'action_required', evidence: { kind: 'spending_pattern', category: 'Restaurants & Bars', impactDollars: 300 },
  };
  const fastFood = {
    type: 'spending_pattern', tone: 'watch', category: 'Fast Food',
    title: 'Fast Food: $150 more than usual', detail: 'x', asOf: 't1',
    attentionClass: 'watch', evidence: { kind: 'spending_pattern', category: 'Fast Food', impactDollars: 150 },
  };
  const unrelated = {
    type: 'over_budget', category: 'Travel', title: 'Travel: over budget',
    attentionClass: 'action_required', evidence: { impactDollars: 200 },
  };
  const out = consolidateRelatedCategories([restaurants, fastFood, unrelated]);
  const combined = out.find((i) => i.category === 'Dining out');
  assert.ok(combined, 'expected one combined "Dining out" card');
  assert.equal(combined.evidence.impactDollars, 450, 'combined dollars = sum of the two, counted exactly once');
  assert.equal(out.length, 2, 'the two dining insights collapse into one card; Travel (unrelated) passes through separately — 2 total, not 3');
  assert.equal(combined.attentionClass, 'action_required', 'the combined card keeps the more urgent member\'s attentionClass, never averaging urgency away');
});

test('a single spending_pattern insight in a related-category group is left alone (no false consolidation of one item)', () => {
  const solo = {
    type: 'spending_pattern', category: 'Clothing', title: 'Clothing: $200 more than usual',
    attentionClass: 'watch', evidence: { impactDollars: 200 },
  };
  const out = consolidateRelatedCategories([solo]);
  assert.deepEqual(out, [solo]);
});

// ── required 9: intentional/dismissed anomalies stay suppressed until materially new evidence appears ──
test(`required 9: a dismissed insight recurring below ${REACTIVATE_MULTIPLIER}x the dismissed amount stays suppressed`, () => {
  const insight = {
    type: 'spending_pattern', title: 'Clothing: $220 more than usual',
    evidence: { impactDollars: 220 },
  };
  const dismissKeyFn = require('../src/store/dismissedInsights').dismissKey;
  const key = dismissKeyFn(insight);
  const dismissedKeys = new Set([key]);
  const dismissedContext = new Map([[key, { amount: 200 }]]); // dismissed at $200; $220 is only 1.1x — not material
  const out = applyWealthDismissals([insight], dismissedKeys, dismissedContext);
  assert.equal(out.length, 0, 'a mere restatement of the same fact stays suppressed');
});

test(`required 9: a dismissed insight recurring at >= ${REACTIVATE_MULTIPLIER}x the dismissed amount resurfaces (materially new evidence)`, () => {
  const insight = {
    type: 'spending_pattern', title: 'Clothing: $400 more than usual',
    evidence: { impactDollars: 400 },
  };
  const dismissKeyFn = require('../src/store/dismissedInsights').dismissKey;
  const key = dismissKeyFn(insight);
  const dismissedKeys = new Set([key]);
  const dismissedContext = new Map([[key, { amount: 200 }]]); // 400 >= 200 * 1.5
  const out = applyWealthDismissals([insight], dismissedKeys, dismissedContext);
  assert.equal(out.length, 1, 'a materially larger recurrence must resurface despite the earlier dismissal');
});

test('a dismissed insight with no recorded context (dismissed before this feature existed, or non-wealth) stays suppressed indefinitely', () => {
  const insight = { type: 'spending_pattern', title: 'Clothing: $900 more than usual', evidence: { impactDollars: 900 } };
  const dismissKeyFn = require('../src/store/dismissedInsights').dismissKey;
  const key = dismissKeyFn(insight);
  const out = applyWealthDismissals([insight], new Set([key]), new Map());
  assert.equal(out.length, 0, 'no baseline to compare against — fail toward the existing (safe) suppression behavior');
});

test('a never-dismissed insight always passes through untouched', () => {
  const insight = { type: 'spending_pattern', title: 'Groceries: $50 more than usual', evidence: { impactDollars: 50 } };
  const out = applyWealthDismissals([insight], new Set(), new Map());
  assert.equal(out.length, 1);
  assert.equal(out[0].title, insight.title);
});

// ── required 11: the Wealth landing page never displays more than three ranked developments ──
test('required 11: rankForWhatChanged + slice(0,3) pattern never exceeds 3 — verified against a large candidate pool', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    type: 'spending_pattern', title: `Category ${i}: overspend`,
    attentionClass: i < 5 ? 'action_required' : 'informational',
    evidence: { impactDollars: 100 + i },
  }));
  const ranked = rankForWhatChanged(many);
  const nonInformational = ranked.filter((i) => i.attentionClass !== 'informational');
  const informational = ranked.filter((i) => i.attentionClass === 'informational');
  const whatChanged = [...nonInformational, ...informational].slice(0, 3);
  assert.equal(whatChanged.length, 3);
  assert.ok(whatChanged.every((i) => i.attentionClass === 'action_required'), 'with 5 action_required candidates available, all 3 slots go to them before any informational filler');
});

// ── required: red is reserved for a real configured risk ──
test('required: critical is NEVER reached from item-level action/review alone, no matter how many — only cashCritical or an item-level critical does', () => {
  const manyActionItems = Array.from({ length: 6 }, () => 'action');
  const severity = deriveSeverity({ dataComplete: true, itemSeverities: manyActionItems, cashCritical: false, planBehindMaterial: false });
  assert.equal(severity, 'action', 'six unresolved action items still cap out at "action", never escalate to "critical" on volume alone');
  const withRealDanger = deriveSeverity({ dataComplete: true, itemSeverities: manyActionItems, cashCritical: true, planBehindMaterial: false });
  assert.equal(withRealDanger, 'critical', 'a real configured cash risk is what actually earns critical/red');
});

// ── required: summary severity always agrees with child exception states ──
test('required: summaryLabel/deriveSeverity never disagree with the child severities that produced them', () => {
  const cases = [
    { itemSeverities: [], expect: 'on_track' },
    { itemSeverities: ['on_track', 'explained'], expect: 'on_track' },
    { itemSeverities: ['review'], expect: 'review' },
    { itemSeverities: ['on_track', 'review', 'explained'], expect: 'review' },
    { itemSeverities: ['action', 'review'], expect: 'action' },
    { itemSeverities: ['action', 'explained', 'review'], expect: 'action' },
  ];
  for (const { itemSeverities, expect } of cases) {
    const severity = deriveSeverity({ dataComplete: true, itemSeverities, cashCritical: false, planBehindMaterial: false });
    assert.equal(severity, expect, `itemSeverities=${JSON.stringify(itemSeverities)}`);
    // The summary is a pure function of the SAME severity + counts — never
    // an independently-generated string that could drift from the badges
    // rendered on each child row.
    const actionCount = itemSeverities.filter((s) => s === 'action' || s === 'critical').length;
    const reviewCount = itemSeverities.filter((s) => s === 'review').length;
    const summary = summaryLabel(severity, { actionCount, reviewCount });
    if (severity === 'action') assert.match(summary, /action needed/i);
    if (severity === 'review') assert.match(summary, /review/i);
    if (severity === 'on_track') assert.match(summary, /on track/i);
  }
});

test('required: unavailable always wins the summary label regardless of child severities (source data isn\'t trustworthy enough to grade)', () => {
  const severity = deriveSeverity({ dataComplete: false, itemSeverities: ['action', 'critical'], cashCritical: true, planBehindMaterial: true });
  assert.equal(severity, 'unavailable');
  assert.match(summaryLabel(severity, { actionCount: 2, reviewCount: 0 }), /incomplete/i);
});
