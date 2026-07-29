// Wealth hierarchy redesign — required regression tests for the overall
// monthly-position tone/formatting helpers used by WealthPostureCard.
// Run: node --experimental-strip-types --test src/lib/wealthPositionTone.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { positionTone, compactMoney } from './wealthPositionTone.ts';
import { colors as themeColors } from '../theme.ts';

test('required: a healthy below-typical headline reads green, never amber/red', () => {
  assert.equal(positionTone('Discretionary spending is comfortably below typical'), themeColors.green);
  assert.equal(positionTone('Discretionary spending is slightly below typical'), themeColors.green);
  assert.equal(positionTone('Savings and plan pace look healthy so far this month — historical spending comparison unavailable'), themeColors.green);
});

test('required: a well-above-typical headline reads red', () => {
  assert.equal(positionTone('Discretionary spending is running well above typical'), themeColors.red);
});

test('required: an above-typical or mixed-signal headline reads amber, not red', () => {
  assert.equal(positionTone('Discretionary spending is slightly above typical'), themeColors.amber);
  assert.equal(positionTone('Discretionary spending is slightly above typical, and other signals are mixed'), themeColors.amber);
  assert.equal(positionTone('A few financial signals are off pace this month — historical spending comparison unavailable'), themeColors.amber);
});

test('required: a neutral/in-line headline reads the neutral subtext color, not amber', () => {
  assert.equal(positionTone('Discretionary spending is in line with typical pace'), themeColors.subtext);
  assert.equal(positionTone('Not enough spending history yet for a confident monthly read — historical comparison unavailable'), themeColors.subtext);
});

test('required: the exact reported production bug — an 11%-below (slightly_below) headline never reads the same as a genuinely comfortably-below one, but both still read green', () => {
  const slightly = positionTone('Discretionary spending is slightly below typical');
  const comfortably = positionTone('Discretionary spending is comfortably below typical');
  assert.equal(slightly, themeColors.green);
  assert.equal(comfortably, themeColors.green);
});

test('compactMoney formats large amounts as "$X.XK"/"$X.XXM" without changing the underlying value', () => {
  assert.equal(compactMoney(77800), '$77.8K');
  assert.equal(compactMoney(-77800), '-$77.8K');
  assert.equal(compactMoney(1330000), '$1.33M');
  assert.equal(compactMoney(500), '$500');
});
