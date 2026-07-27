// "On My Radar" — regression coverage for the semantic ranking/presentation
// contract (On My Radar audit). Exercises the real production function in
// brain/radar.js against REALISTIC insight fixtures shaped exactly like
// services/wealth-insights.js's actual output (attentionClass/material/
// timeSensitive/direction/reasonCode/evidence), never a bare {title, detail}
// stand-in — the whole point of this audit was that position/shape-blind
// candidate selection is what let a positive result render as an alert.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRadarCards } = require('../src/brain/radar');
const { dismissKey } = require('../src/store/dismissedInsights');

// A realistic informational (positive, non-material) savings-rate insight —
// the EXACT shape services/wealth-insights.js now produces for a positive
// savings rate, reused across tests so no test constructs its own ad hoc
// "positive" fixture with different field names than production.
function positiveSavingsInsight({ ratePct = 28, income = 19090, spending = 13825, title } = {}) {
  return {
    type: 'savings_rate', tone: 'win',
    title: title || `Saving ${ratePct}% of income (30d)`,
    detail: `Over the last 30 days you brought in $${income} and spent $${spending} — a savings rate of ${ratePct}%. Strong.`,
    attentionClass: 'informational', material: false, timeSensitive: false, actionable: false,
    direction: 'positive', reasonCode: 'savings_rate_healthy',
    evidence: { kind: 'savings_rate', income, spending, ratePct, windowDays: 30 },
    asOf: '2026-07-26T12:00:00Z',
  };
}

function overspendingInsight({ ratePct = -12, income = 8000, spending = 8960 } = {}) {
  return {
    type: 'savings_rate', tone: 'watch',
    title: `Spending ${Math.abs(ratePct)}% more than you earned (30d)`,
    detail: `Over the last 30 days you spent $${spending} against $${income} of income.`,
    attentionClass: 'action_required', material: true, timeSensitive: true, actionable: true,
    direction: 'negative', reasonCode: 'overspending_30d',
    evidence: { kind: 'savings_rate', income, spending, ratePct, windowDays: 30 },
    asOf: '2026-07-26T12:00:00Z',
  };
}

function overBudgetInsight({ category = 'Dining', actual = 620, budget = 400 } = {}) {
  return {
    type: 'over_budget', tone: 'watch', category,
    title: `${category}: over budget (${actual} of ${budget})`,
    detail: `${category}: $${actual} spent of $${budget} budget.`,
    attentionClass: 'action_required', material: true, timeSensitive: true, actionable: true,
    direction: 'negative', reasonCode: 'over_budget',
    evidence: { kind: 'budget_pacing', category, budget, actual, pace: actual / budget, overBudget: true, impactDollars: actual - budget },
    asOf: '2026-07-26T12:00:00Z',
  };
}

function netWorthMilestoneInsight({ monthlyChange = 1500, current = 240000 } = {}) {
  return {
    type: 'net_worth_path', tone: 'win',
    title: `Net worth growing ~$${monthlyChange}/mo`,
    detail: `Net worth is growing about $${monthlyChange}/month.`,
    attentionClass: 'positive', material: true, timeSensitive: false, actionable: false,
    direction: 'positive', reasonCode: 'net_worth_growth_milestone',
    evidence: { kind: 'net_worth_path', current, projected: current + monthlyChange * 6, monthlyChange },
    asOf: '2026-07-26T12:00:00Z',
  };
}

// ── Required regression 1+2: a strong/on-track savings rate never becomes a material alert, for arbitrary values ──
test('required 1/2 — a positive savings rate (arbitrary %, arbitrary title) never produces a material/action_required Radar card', () => {
  for (const ratePct of [5, 19, 20, 28, 41, 63]) {
    const cards = buildRadarCards({
      wealthInsights: [positiveSavingsInsight({ ratePct })],
      weeklyReview: null, recovery: null, chiefBrief: null, risk: null, snapshotId: 'snap_x',
    });
    assert.deepEqual(cards, [], `ratePct=${ratePct}: a positive, informational insight must never produce a Radar card`);
  }
});

test('required 6 — routine positive wealth information is suppressed entirely, not just recolored', () => {
  const cards = buildRadarCards({
    wealthInsights: [positiveSavingsInsight({})],
    weeklyReview: null, recovery: null, chiefBrief: null, risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.length, 0);
});

// ── Required regression 4: a real overspending anomaly remains action_required and outranks a ready review ──
test('required 4 — a real overspending anomaly is action_required and ranks ABOVE a ready weekly review', () => {
  const cards = buildRadarCards({
    wealthInsights: [overspendingInsight({})],
    weeklyReview: { headline: 'A strong week for consistency.', generatedAt: '2026-07-20T00:00:00Z' },
    recovery: null,
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm' },
    risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].domain, 'wealth');
  assert.equal(cards[0].attentionClass, 'action_required');
  assert.equal(cards[1].domain, 'review');
  assert.equal(cards[1].attentionClass, 'ready');
});

test('required 4b — an over_budget insight is also action_required and outranks a ready review', () => {
  const cards = buildRadarCards({
    wealthInsights: [overBudgetInsight({})],
    weeklyReview: { headline: 'Review ready.', generatedAt: '2026-07-20T00:00:00Z' },
    recovery: null, chiefBrief: null, risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards[0].domain, 'wealth');
  assert.equal(cards[0].attentionClass, 'action_required');
});

// ── Required regression 5: a meaningful positive milestone can render green, never red ──
test('required 5 — a genuine positive milestone (material net-worth growth) surfaces as attentionClass "positive", never "action_required"', () => {
  const cards = buildRadarCards({
    wealthInsights: [netWorthMilestoneInsight({})],
    weeklyReview: null, recovery: null, chiefBrief: null, risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].attentionClass, 'positive');
  assert.notEqual(cards[0].attentionClass, 'action_required');
  assert.notEqual(cards[0].attentionClass, 'watch');
});

// ── Required regression 3: provisional recovery + ready review, exactly those two, in that order ──
test('required 3 — provisional recovery plus a ready weekly review produce exactly those two cards, in that order, with no higher-priority issue', () => {
  const cards = buildRadarCards({
    wealthInsights: [positiveSavingsInsight({})], // informational — must not intrude
    weeklyReview: { headline: 'A strong week for sleep consistency.', generatedAt: '2026-07-20T00:00:00Z' },
    recovery: { proxy: true, asOf: '2026-07-26T09:00:00Z' },
    chiefBrief: { synthesis: 'A steady day — protect the afternoon focus block.', action: 'a', risk: 'r', move: 'm' },
    risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].domain, 'health');
  assert.equal(cards[0].attentionClass, 'watch');
  assert.equal(cards[0].headline, 'Recovery is provisional');
  assert.equal(cards[1].domain, 'review');
  assert.equal(cards[1].attentionClass, 'ready');
  assert.equal(cards[1].headline, 'Your weekly review is ready');
});

// ── Required regression 7: whyNow and evidenceSummary/evidenceItems are never duplicated ──
test('required 7 — the wealth card\'s whyNow is distinct from its evidence, and evidenceSummary is never a copy of whyNow', () => {
  const cards = buildRadarCards({
    wealthInsights: [overBudgetInsight({ category: 'Dining', actual: 620, budget: 400 })],
    weeklyReview: null, recovery: null, chiefBrief: null, risk: null, snapshotId: 'snap_x',
  });
  const card = cards[0];
  assert.ok(card.whyNow, 'expected a whyNow');
  assert.equal(card.evidenceSummary, null, 'structured evidence uses evidenceItems, not a redundant prose evidenceSummary');
  assert.ok(Array.isArray(card.evidenceItems) && card.evidenceItems.length > 0, 'expected structured evidence items');
  const evidenceText = JSON.stringify(card.evidenceItems);
  assert.notEqual(card.whyNow, evidenceText);
  // whyNow must not just be the evidence numbers restated as a sentence —
  // it names WHY it matters (a reason), evidence carries the WHAT (numbers).
  assert.match(card.whyNow, /budget/i);
});

test('required 7b — recovery-provisional whyNow and evidenceSummary are two distinct sentences, never identical', () => {
  const cards = buildRadarCards({
    wealthInsights: [], weeklyReview: null,
    recovery: { proxy: true, asOf: null },
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm' },
    risk: null, snapshotId: 'snap_x',
  });
  const card = cards.find((c) => c.domain === 'health');
  assert.ok(card);
  assert.notEqual(card.whyNow, card.evidenceSummary);
});

// ── Required regression 9: dismissal suppresses the SAME stable insight across Radar and the domain surface ──
test('required 9 — dismissing a wealth radar card uses the SAME dismissKey the Wealth tab\'s own insight list would compute (cross-surface suppression)', () => {
  const insight = overBudgetInsight({ category: 'Dining', actual: 620, budget: 400 });
  const cardsBefore = buildRadarCards({
    wealthInsights: [insight], weeklyReview: null, recovery: null, chiefBrief: null, risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cardsBefore.length, 1);
  const expectedKey = dismissKey(insight); // exactly what applyDismissals() would compute for the SAME insight in the Wealth tab
  assert.equal(cardsBefore[0].dismissKey, expectedKey, 'radar must reuse the Wealth tab\'s own dismissKey, not a radar-only derivative');

  const cardsAfter = buildRadarCards({
    wealthInsights: [insight], weeklyReview: null, recovery: null, chiefBrief: null, risk: null, snapshotId: 'snap_x',
    dismissed: new Set([expectedKey]),
  });
  assert.equal(cardsAfter.some((c) => c.domain === 'wealth'), false, 'a dismissal computed via the Wealth tab\'s own key must also suppress the Radar card');
});

test('a dismissed radar-only candidate (no domain-surface equivalent) is excluded via its radar-scoped key', () => {
  const cards = buildRadarCards({
    wealthInsights: [], weeklyReview: { headline: 'Review ready.', generatedAt: 'x' },
    recovery: null, chiefBrief: null, risk: null, snapshotId: 'snap_x',
    dismissed: new Set([dismissKey({ type: 'radar_weekly_review', title: 'Your weekly review is ready' })]),
  });
  assert.equal(cards.some((c) => c.domain === 'review'), false);
});

// ── Ranking is a real sort, not caller field order ──
test('candidates are ranked by attentionClass, not by the order fields were passed in', () => {
  const cards = buildRadarCards({
    weeklyReview: { headline: 'Big week for sleep consistency.', generatedAt: '2026-07-20T00:00:00Z' },
    wealthInsights: [overBudgetInsight({ category: 'Dining' })],
    recovery: { proxy: true, asOf: '2026-07-26T09:00:00Z' },
    chiefBrief: { synthesis: 'Recovery is green at 80 today.', action: 'a', risk: 'r', move: 'm' },
    risk: null,
    snapshotId: 'snap_x',
  });
  // Cap is 2 unless the 3rd is BOTH action_required or watch+timeSensitive;
  // weeklyReview ('ready') is the 3rd-ranked candidate here, so it's dropped.
  assert.equal(cards.length, 2);
  assert.equal(cards[0].domain, 'wealth');
  assert.equal(cards[0].attentionClass, 'action_required');
  assert.equal(cards[1].domain, 'health');
  assert.equal(cards[1].attentionClass, 'watch');
});

test('routine on-track wealth data (no eligible insight, no stale sync) produces NO wealth radar card', () => {
  const cards = buildRadarCards({
    wealthInsights: [], wealth: { sourceSyncedAt: new Date().toISOString() },
    weeklyReview: null, recovery: null, chiefBrief: null, risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.some((c) => c.domain === 'wealth'), false);
  assert.deepEqual(cards, []);
});

test('a radar claim already conveyed in Chief Brief\'s MOVE field is suppressed (wealth)', () => {
  const insight = overBudgetInsight({ category: 'Dining' });
  const cards = buildRadarCards({
    wealthInsights: [insight],
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: insight.title },
    weeklyReview: null, recovery: null, risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.some((c) => c.domain === 'wealth'), false);
});

test('a distinct wealth insight NOT covered by MOVE still surfaces', () => {
  const cards = buildRadarCards({
    wealthInsights: [overBudgetInsight({ category: 'Dining' })],
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'Rent hits Friday and will eat most of your buffer.' },
    weeklyReview: null, recovery: null, risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.some((c) => c.domain === 'wealth'), true);
});

test('recovery-provisional radar card is suppressed when the Chief Brief already explains it', () => {
  const cards = buildRadarCards({
    recovery: { proxy: true, asOf: null },
    chiefBrief: { synthesis: 'Recovery is provisional today — self-reported, Eight Sleep did not sync.', action: 'a', risk: 'r', move: 'm' },
    wealthInsights: [], weeklyReview: null, risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.some((c) => c.dedupeTopic === 'recovery_provisional'), false);
});

test('recovery-provisional radar card is ALSO suppressed when RISK already surfaces the same health anomaly', () => {
  const cards = buildRadarCards({
    recovery: { proxy: true, asOf: null },
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm' },
    risk: { title: 'Sleep worth attention', rationale: 'r', severity: 'watch', evidence: { kind: 'anomaly' } },
    wealthInsights: [], weeklyReview: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.some((c) => c.domain === 'health'), false);
});

test('zero eligible candidates produces an empty array (mobile renders the truthful quiet state)', () => {
  const cards = buildRadarCards({
    wealthInsights: [], weeklyReview: null, recovery: null, chiefBrief: null, risk: null, snapshotId: 'snap_x',
  });
  assert.deepEqual(cards, []);
});

test('a genuinely material AND time-sensitive 3rd candidate survives the cap', () => {
  const cards = buildRadarCards({
    wealthInsights: [overspendingInsight({})],
    weeklyReview: { headline: 'Review ready.', generatedAt: 'x' },
    wealth: { sourceSyncedAt: new Date(Date.now() - 50 * 3600 * 1000).toISOString() },
    recovery: { proxy: true, asOf: null },
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm' },
    risk: null, snapshotId: 'snap_x',
  });
  // wealth (action_required) + recovery (watch, timeSensitive) fill the 2
  // guaranteed slots; weeklyReview ('ready', not urgent) never becomes the 3rd.
  assert.equal(cards.length, 2);
  assert.ok(!cards.some((c) => c.dedupeTopic === 'weekly_review'));
});

test('an insight missing the semantic contract entirely defaults to informational (never a silent alert)', () => {
  // Defensive: a producer that forgot to declare attentionClass (e.g. the
  // legacy heuristic subscriptions fallback) must never be treated as
  // material by default — services/wealth-insights.js normalizes this
  // itself, but radar.js's own selection logic must also fail safe.
  const cards = buildRadarCards({
    wealthInsights: [{ type: 'subscriptions', title: 'Unclassified insight', detail: 'x' }],
    weeklyReview: null, recovery: null, chiefBrief: null, risk: null, snapshotId: 'snap_x',
  });
  assert.deepEqual(cards, []);
});
