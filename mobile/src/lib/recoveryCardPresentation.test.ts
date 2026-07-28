import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRecoveryPresentation, type RecoveryCardColors } from './recoveryCardPresentation.ts';

const colors: RecoveryCardColors = {
  subtext: '#8E8E93',
  green: '#34C759',
  warmGreen: '#8BC34A',
  amber: '#FF9F0A',
  red: '#FF3B30',
  yellow: '#FF9F0A',
};

test('proxy (self-reported) reading is forced to neutral gray, never a red/amber/green verdict color', () => {
  const result = deriveRecoveryPresentation(
    { proxy: true, category: 'Good', band: 'green', presentation: { tier: 'ready', label: 'Recovered' } },
    colors
  );
  assert.equal(result.bandColor, colors.subtext);
  assert.equal(result.gradientKey, 'neutral');
  assert.notEqual(result.bandColor, colors.green);
});

test('proxy reading label gets an explicit "· provisional" suffix using the self-reported category', () => {
  const result = deriveRecoveryPresentation(
    { proxy: true, category: 'Good', band: 'green' },
    colors
  );
  assert.equal(result.displayBandLabel, 'Good · provisional');
});

test('proxy reading with no category falls back to the band label, still suffixed', () => {
  const result = deriveRecoveryPresentation(
    { proxy: true, category: null, band: 'yellow', presentation: { label: 'Moderate' } },
    colors
  );
  assert.equal(result.displayBandLabel, 'Moderate · provisional');
});

test('a confirmed low (bad) reading is visually distinct from a confirmed provisional one — different color AND no suffix', () => {
  const bad = deriveRecoveryPresentation({ proxy: false, band: 'red', presentation: { tier: 'low', label: 'Low' } }, colors);
  const provisional = deriveRecoveryPresentation({ proxy: true, category: 'Fair', band: 'red', presentation: { tier: 'low', label: 'Low' } }, colors);
  assert.equal(bad.bandColor, colors.red);
  assert.notEqual(bad.bandColor, provisional.bandColor);
  assert.ok(!bad.displayBandLabel.includes('provisional'));
  assert.ok(provisional.displayBandLabel.includes('provisional'));
});

test('confirmed reading: solid_near_green tier gets its own warm-green tone, distinct from plain moderate yellow', () => {
  const nearGreen = deriveRecoveryPresentation({ proxy: false, band: 'yellow', presentation: { tier: 'solid_near_green', label: 'Solid' } }, colors);
  const moderate = deriveRecoveryPresentation({ proxy: false, band: 'yellow', presentation: { tier: 'moderate', label: 'Moderate' } }, colors);
  assert.equal(nearGreen.bandColor, colors.warmGreen);
  assert.equal(moderate.bandColor, colors.amber);
  assert.notEqual(nearGreen.bandColor, moderate.bandColor);
  assert.equal(nearGreen.gradientKey, 'warmGreen');
  assert.equal(moderate.gradientKey, 'amber');
});

test('confirmed reading with no presentation tier falls back to the raw band color (old 3-label behavior)', () => {
  const green = deriveRecoveryPresentation({ proxy: false, band: 'green', presentation: null }, colors);
  const yellow = deriveRecoveryPresentation({ proxy: false, band: 'yellow', presentation: null }, colors);
  const red = deriveRecoveryPresentation({ proxy: false, band: 'red', presentation: null }, colors);
  assert.equal(green.bandColor, colors.green);
  assert.equal(yellow.bandColor, colors.yellow);
  assert.equal(red.bandColor, colors.red);
  assert.equal(green.displayBandLabel, 'Recovered');
});

test('missing band and presentation falls back to neutral subtext, not a crash', () => {
  const result = deriveRecoveryPresentation({}, colors);
  assert.equal(result.bandColor, colors.subtext);
  assert.equal(result.gradientKey, 'neutral');
  assert.equal(result.displayBandLabel, 'Recovery');
});
