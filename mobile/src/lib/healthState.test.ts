// Health tab redesign (audit rec #4) — required scenarios 1, 2, 3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHealthState } from './healthState.ts';

const GREEN = { score: 82, band: 'green' as const, parts: {}, detail: 'x', rawHrv: 60, rawRhr: 50 };
const YELLOW = { score: 52, band: 'yellow' as const, parts: {}, detail: 'x', rawHrv: 45, rawRhr: 55 };
const RED = { score: 30, band: 'red' as const, parts: {}, detail: 'x', rawHrv: 30, rawRhr: 62 };
const SELF_REPORT_GOOD = { score: 75, band: 'green' as const, parts: {}, detail: 'x', proxy: true, category: 'Good' };

test('required 1: current Eight Sleep (device-backed) recovery produces a device-backed state, not provisional', () => {
  const r = resolveHealthState(GREEN, { source: 'scheduled', workoutId: 'push', label: 'Push' });
  assert.equal(r.isProvisional, false);
  assert.equal(r.stateLabel, 'Ready');
  assert.equal(r.decision, 'Train as planned');
  assert.equal(r.sourceLabel, 'Eight Sleep');
});

test('required 2: self-reported recovery without current overnight data is labeled provisional, never "Ready"/"Recovered"', () => {
  const r = resolveHealthState(SELF_REPORT_GOOD, { source: 'scheduled', workoutId: 'push', label: 'Push' });
  assert.equal(r.isProvisional, true);
  assert.equal(r.stateLabel, 'Provisional');
  assert.notEqual(r.stateLabel, 'Ready');
  assert.match(r.explanation, /self-reported/i);
  assert.equal(r.sourceLabel, 'Self-reported');
});

test('required 3 (mobile-side half): no recovery reading at all never fabricates a confident state', () => {
  const r = resolveHealthState(null, { source: 'scheduled', workoutId: 'zone2', label: 'Zone 2' });
  assert.equal(r.isProvisional, true);
  assert.equal(r.stateLabel, 'Provisional');
  assert.equal(r.sourceLabel, 'Unavailable');
});

test('yellow band reduces to "Proceed with care" / "Reduce intensity"', () => {
  const r = resolveHealthState(YELLOW, { source: 'auto_downgrade', workoutId: 'zone2', label: 'Zone 2', scheduledWorkoutId: 'pull', scheduledLabel: 'Pull', recoveryBand: 'yellow' });
  assert.equal(r.stateLabel, 'Proceed with care');
  assert.equal(r.decision, 'Reduce intensity');
});

test('red band with an auto-downgrade explains the swap, decision is Recovery only (not Rest, since effective workout is not literally rest)', () => {
  const r = resolveHealthState(RED, { source: 'auto_downgrade', workoutId: 'mobility', label: 'Mobility', scheduledWorkoutId: 'push', scheduledLabel: 'Push', recoveryBand: 'red' });
  assert.equal(r.stateLabel, 'Recover');
  assert.equal(r.decision, 'Recovery only');
  assert.match(r.explanation, /Push.*Mobility|swapped/i);
});

test('red band with effective workout already rest reduces the decision to "Rest"', () => {
  const r = resolveHealthState(RED, { source: 'scheduled', workoutId: 'rest', label: 'Rest' });
  assert.equal(r.decision, 'Rest');
});

test('a self-reported proxy still carries a real decision, just labeled provisional', () => {
  const r = resolveHealthState(SELF_REPORT_GOOD, { source: 'scheduled', workoutId: 'push', label: 'Push' });
  assert.equal(r.decision, 'Train as planned');
});
