// On My Radar audit item 3 + required regression 8: Chief Brief and Radar
// must never disagree, and must update coherently once a pending brief
// resolves. Exercises the REAL production function
// (brain/todayCommandCenter.js's buildTodayCommandCenter), which computes
// `now` (from chiefBrief) and `radar` (from brain/radar.js) in the SAME
// synchronous call from the SAME input — there is no second code path where
// one could see a newer/older chiefBrief than the other. No DB needed:
// snapshotAt is left null so buildSinceMorning's one DB read short-circuits.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTodayCommandCenter } = require('../src/brain/todayCommandCenter');

const SNAPSHOT_ID = 'snap_coherence_1';

test('required 8a — NOW and RADAR share the exact same snapshotId in one response', async () => {
  const tcc = await buildTodayCommandCenter({
    snapshotId: SNAPSHOT_ID, snapshotVersion: 3, snapshotAt: null, builtAt: 'now',
    chiefBrief: { synthesis: 'A steady day ahead.', action: 'a', risk: 'r', move: 'm' },
    chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null,
    recovery: { proxy: true, asOf: null },
  });
  assert.equal(tcc.snapshotId, SNAPSHOT_ID);
  assert.equal(tcc.now.stableId, `now:${SNAPSHOT_ID}`);
  const radarCard = tcc.radar.find((c) => c.domain === 'health');
  assert.ok(radarCard, 'expected the recovery-provisional radar card');
  assert.equal(radarCard.snapshotId, SNAPSHOT_ID, 'radar cards must carry the SAME snapshot identity as NOW, never a second one');
});

test('required 8b — while the brief is pending, Radar is still computed from real facts (never held back or ranked against garbage), but chief-brief-dependent dedup cannot fire yet', async () => {
  const tcc = await buildTodayCommandCenter({
    snapshotId: SNAPSHOT_ID, snapshotVersion: 3, snapshotAt: null, builtAt: 'now',
    chiefBrief: null, chiefBriefPending: true, chiefBriefQuality: null,
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null,
    recovery: { proxy: true, asOf: null },
  });
  assert.equal(tcc.now.headline, 'Finishing today\'s brief…');
  assert.equal(tcc.now.evidence.chiefBriefPending, true);
  // The recovery-provisional fact is real and independent of the chief
  // brief's text — it must still show up while pending, not be silently
  // held back just because the brief isn't ready yet.
  const radarCard = tcc.radar.find((c) => c.domain === 'health');
  assert.ok(radarCard, 'a real, independently-computed fact must still surface on Radar while the brief is pending');
  assert.equal(radarCard.snapshotId, SNAPSHOT_ID);
});

test('required 8c — once the pending brief resolves (SAME snapshotId), Radar recomputes coherently and drops a now-redundant card, in the SAME call that produces the fresh NOW headline', async () => {
  // Step 1: pending — the recovery-provisional card shows (as in 8b above).
  const pendingTcc = await buildTodayCommandCenter({
    snapshotId: SNAPSHOT_ID, snapshotVersion: 3, snapshotAt: null, builtAt: 'now',
    chiefBrief: null, chiefBriefPending: true, chiefBriefQuality: null,
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null,
    recovery: { proxy: true, asOf: null },
  });
  assert.ok(pendingTcc.radar.some((c) => c.domain === 'health'));

  // Step 2: the SAME scoped rebuild that resolves the brief also produces
  // text that already explains the provisional-recovery uncertainty — the
  // exact scenario a stale/independently-ranked Radar would get wrong.
  const resolvedTcc = await buildTodayCommandCenter({
    snapshotId: SNAPSHOT_ID, snapshotVersion: 3, snapshotAt: null, builtAt: 'now-later',
    chiefBrief: {
      synthesis: 'Recovery is provisional today — self-reported, Eight Sleep did not sync overnight.',
      action: 'a', risk: 'r', move: 'm',
    },
    chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null,
    recovery: { proxy: true, asOf: null },
  });
  assert.equal(resolvedTcc.snapshotId, SNAPSHOT_ID, 'the resolved response is still the SAME snapshot identity');
  assert.notEqual(resolvedTcc.now.headline, 'Finishing today\'s brief…', 'NOW must reflect the now-resolved brief');
  assert.equal(
    resolvedTcc.radar.some((c) => c.domain === 'health'),
    false,
    'RADAR must be recomputed in lockstep — a card the now-resolved brief already explains must not linger from the pending response'
  );
});
