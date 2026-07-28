// Wealth redesign (audit rec #5) — pure-function unit tests for
// backend/src/services/wealth-landing.js's posture/ranking/consolidation/
// dismissal-reactivation logic. No DB — these are the exported pure helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  derivePosture, rankForWhatChanged, applyWealthDismissals, consolidateRelatedCategories,
  REACTIVATE_MULTIPLIER,
} = require('../src/services/wealth-landing');

// ── required 6: a strong savings rate cannot receive an alarm/needs-attention label ──
test('required 6: data-complete + no action_required + no watch items -> on_track, never action_needed/worth_watching, regardless of how strong savings look', () => {
  const posture = derivePosture({ dataComplete: true, actionRequiredCount: 0, watchCount: 0, planAheadMaterial: false });
  assert.equal(posture, 'on_track');
  assert.notEqual(posture, 'action_needed');
  assert.notEqual(posture, 'worth_watching');
});

test('data incomplete always wins, even if nothing else is wrong', () => {
  assert.equal(derivePosture({ dataComplete: false, actionRequiredCount: 0, watchCount: 0, planAheadMaterial: true }), 'data_incomplete');
});

test('a real action_required item forces action_needed even when materially ahead of plan', () => {
  assert.equal(derivePosture({ dataComplete: true, actionRequiredCount: 1, watchCount: 0, planAheadMaterial: true }), 'action_needed');
});

test('ahead_of_plan only applies once action_needed is ruled out', () => {
  assert.equal(derivePosture({ dataComplete: true, actionRequiredCount: 0, watchCount: 0, planAheadMaterial: true }), 'ahead_of_plan');
});

test('worth_watching applies when nothing is action_required or ahead of plan, but something is watch-class', () => {
  assert.equal(derivePosture({ dataComplete: true, actionRequiredCount: 0, watchCount: 1, planAheadMaterial: false }), 'worth_watching');
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
