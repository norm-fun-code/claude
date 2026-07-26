// Today Part 4 regression #18: "Secondary navigation deep-links to the
// exact domain entity or anchor."
//   node --experimental-strip-types --test src/lib/radarNavigation.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRadarNavigation } from './radarNavigation.ts';
import type { RadarDestination } from '../hooks/useBriefing.ts';

test('resolveRadarNavigation: review surface opens the weekly-review modal, no tab switch', () => {
  const dest: RadarDestination = { surface: 'review', entityType: 'weeklyReview', entityId: 'x', anchor: null, snapshotId: null, fallbackRoute: 'review' };
  assert.deepEqual(resolveRadarNavigation(dest), { kind: 'review' });
});

test('resolveRadarNavigation: wealth surface with an entityId carries a real anchor, not just a tab switch', () => {
  const dest: RadarDestination = {
    surface: 'wealth', entityType: 'wealthInsight', entityId: 'Dining spend up 40%',
    anchor: 'Dining spend up 40%', snapshotId: null, fallbackRoute: 'wealth',
  };
  const nav = resolveRadarNavigation(dest);
  assert.equal(nav.kind, 'tab');
  if (nav.kind === 'tab') {
    assert.equal(nav.tab, 'wealth');
    assert.deepEqual(nav.anchor, { entityType: 'wealthInsight', entityId: 'Dining spend up 40%' });
  }
});

test('resolveRadarNavigation: health surface with entityId "recovery" anchors to the exact RecoveryCard', () => {
  const dest: RadarDestination = { surface: 'health', entityType: 'recovery', entityId: 'today', anchor: 'recovery', snapshotId: null, fallbackRoute: 'health' };
  const nav = resolveRadarNavigation(dest);
  assert.equal(nav.kind, 'tab');
  if (nav.kind === 'tab') assert.deepEqual(nav.anchor, { entityType: 'recovery', entityId: 'today' });
});

test('resolveRadarNavigation: a destination with NO entityId (the exact entity no longer resolvable) degrades to a plain tab switch, not a crash', () => {
  const dest: RadarDestination = { surface: 'wealth', entityType: null, entityId: null, anchor: null, snapshotId: null, fallbackRoute: 'wealth' };
  const nav = resolveRadarNavigation(dest);
  assert.equal(nav.kind, 'tab');
  if (nav.kind === 'tab') assert.equal(nav.anchor, null);
});

test('resolveRadarNavigation: an unrecognized surface falls back to fallbackRoute, never throws', () => {
  const dest = { surface: 'today', entityType: null, entityId: null, anchor: null, snapshotId: null, fallbackRoute: 'today' } as RadarDestination;
  assert.deepEqual(resolveRadarNavigation(dest), { kind: 'fallback', tab: 'today' });
});
