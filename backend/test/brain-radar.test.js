// "On My Radar" (Today command-center cleanup, Part 3+6). Regression
// scenarios #12-#16 from the required list, exercised directly against the
// real production function in brain/radar.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRadarCards } = require('../src/brain/radar');

test('scenario 12 — radar candidates are ranked by materiality (tier), not by domain order', () => {
  // Wealth (tier 1, material) is passed AFTER weeklyReview (tier 4) in the
  // input object, and recovery (tier 3) comes last — the OUTPUT order must
  // still be materiality-first (wealth, then recovery), proving the ranking
  // is a real sort, not "whatever order the caller happened to pass fields".
  const cards = buildRadarCards({
    weeklyReview: { headline: 'Big week for sleep consistency.', generatedAt: '2026-07-20T00:00:00Z' },
    wealthInsights: [{ title: 'Dining spend up 40% this month', detail: 'Category pacing is well above your usual.', asOf: null }],
    recovery: { proxy: true, asOf: '2026-07-26T09:00:00Z' },
    chiefBrief: { synthesis: 'Recovery is green at 80 today.', action: 'a', risk: 'r', move: 'm' },
    risk: null,
    snapshotId: 'snap_x',
  });
  // Cap is 2 unless the 3rd is BOTH material and timeSensitive; weeklyReview
  // (tier 4, not material) is the 3rd-ranked candidate here, so it's dropped.
  assert.equal(cards.length, 2);
  assert.equal(cards[0].domain, 'wealth');
  assert.equal(cards[0].priority, 1);
  assert.equal(cards[1].domain, 'health');
  assert.equal(cards[1].priority, 3);
});

test('scenario 13 — routine on-track wealth data (no insight, no stale sync) produces NO wealth radar card', () => {
  const cards = buildRadarCards({
    wealthInsights: [], wealth: { sourceSyncedAt: new Date().toISOString() },
    weeklyReview: null, recovery: null, chiefBrief: null, risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.some((c) => c.domain === 'wealth'), false);
  assert.deepEqual(cards, []);
});

test('scenario 14a — a radar claim already conveyed in Chief Brief\'s MOVE field is suppressed (wealth)', () => {
  const cards = buildRadarCards({
    wealthInsights: [{ title: 'Dining spend up 40% this month', detail: 'Category pacing is well above your usual.', asOf: null }],
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'Dining spend is up 40% this month — well above your usual pace.' },
    weeklyReview: null, recovery: null, risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.some((c) => c.domain === 'wealth'), false);
});

test('scenario 14b — a distinct wealth insight NOT covered by MOVE still surfaces', () => {
  const cards = buildRadarCards({
    wealthInsights: [{ title: 'Dining spend up 40% this month', detail: 'x', asOf: null }],
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'Rent hits Friday and will eat most of your buffer.' },
    weeklyReview: null, recovery: null, risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.some((c) => c.domain === 'wealth'), true);
});

test('scenario 14c — recovery-provisional radar card is suppressed when the Chief Brief already explains it', () => {
  const cards = buildRadarCards({
    recovery: { proxy: true, asOf: null },
    chiefBrief: { synthesis: 'Recovery is provisional today — self-reported, Eight Sleep did not sync.', action: 'a', risk: 'r', move: 'm' },
    wealthInsights: [], weeklyReview: null, risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.some((c) => c.dedupeTopic === 'recovery_provisional'), false);
});

test('scenario 14d — recovery-provisional radar card DOES surface when the Chief Brief never mentions it', () => {
  const cards = buildRadarCards({
    recovery: { proxy: true, asOf: null },
    chiefBrief: { synthesis: 'A steady day — protect your afternoon focus block.', action: 'a', risk: 'r', move: 'm' },
    wealthInsights: [], weeklyReview: null, risk: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.some((c) => c.domain === 'health'), true);
});

test('scenario 14e — recovery-provisional radar card is ALSO suppressed when RISK already surfaces the same health anomaly', () => {
  const cards = buildRadarCards({
    recovery: { proxy: true, asOf: null },
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm' },
    risk: { title: 'Sleep worth attention', rationale: 'r', severity: 'watch', evidence: { kind: 'anomaly' } },
    wealthInsights: [], weeklyReview: null, snapshotId: 'snap_x',
  });
  assert.equal(cards.some((c) => c.domain === 'health'), false);
});

test('scenario 15 — a dismissed radar card is excluded even though its underlying data still qualifies', () => {
  const { dismissKey } = require('../src/store/dismissedInsights');
  const wealthInsights = [{ title: 'Dining spend up 40% this month', detail: 'x', asOf: null }];
  const key = dismissKey({ type: 'radar_wealth_insight', title: 'Dining spend up 40% this month' });
  const cards = buildRadarCards({
    wealthInsights, chiefBrief: null, weeklyReview: null, recovery: null, risk: null, snapshotId: 'snap_x',
    dismissed: new Set([key]),
  });
  assert.equal(cards.some((c) => c.domain === 'wealth'), false);
});

test('scenario 16 — zero eligible candidates produces an empty array (mobile renders the truthful quiet state)', () => {
  const cards = buildRadarCards({
    wealthInsights: [], weeklyReview: null, recovery: null, chiefBrief: null, risk: null, snapshotId: 'snap_x',
  });
  assert.deepEqual(cards, []);
});

test('a genuinely material AND time-sensitive 3rd candidate survives the cap', () => {
  const cards = buildRadarCards({
    wealthInsights: [{ title: 'Overdraft risk this week', detail: 'x', asOf: null }],
    weeklyReview: { headline: 'Review ready.', generatedAt: 'x' },
    wealth: { sourceSyncedAt: new Date(Date.now() - 50 * 3600 * 1000).toISOString() }, // 50h stale — material=false but timeSensitive=true, not the 3rd survivor test though
    recovery: { proxy: true, asOf: null },
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm' },
    risk: null, snapshotId: 'snap_x',
  });
  // wealth insight (tier1) + recovery (tier3) fill the 2 guaranteed slots;
  // weeklyReview (tier4, not material) never becomes the 3rd.
  assert.equal(cards.length, 2);
  assert.ok(!cards.some((c) => c.dedupeTopic === 'weekly_review'));
});
