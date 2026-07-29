// Wealth hierarchy redesign — required regression tests for the overall
// monthly-position tone/formatting helpers used by WealthPostureCard.
// Run: node --experimental-strip-types --test src/lib/wealthPositionTone.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { positionTone, compactMoney } from './wealthPositionTone.ts';
import { colors as themeColors } from '../theme.ts';

test('required: a healthy below-pace headline reads green, never amber/red', () => {
  assert.equal(positionTone('Spending is comfortably below pace'), themeColors.green);
  assert.equal(positionTone('Savings and plan pace look healthy so far this month'), themeColors.green);
});

test('required: a well-above-pace headline reads red', () => {
  assert.equal(positionTone('Spending is running well above pace'), themeColors.red);
});

test('required: an above-pace or mixed-signal headline reads amber, not red', () => {
  assert.equal(positionTone('Spending is running a bit above pace'), themeColors.amber);
  assert.equal(positionTone('Spending is running above pace, and other signals are mixed'), themeColors.amber);
  assert.equal(positionTone('A few financial signals are off pace this month'), themeColors.amber);
});

test('required: a neutral/near-typical headline reads the neutral subtext color, not amber', () => {
  assert.equal(positionTone('Spending is tracking close to typical pace'), themeColors.subtext);
  assert.equal(positionTone('Not enough spending history yet for a confident monthly read'), themeColors.subtext);
});

test('compactMoney formats large amounts as "$X.XK"/"$X.XXM" without changing the underlying value', () => {
  assert.equal(compactMoney(77800), '$77.8K');
  assert.equal(compactMoney(-77800), '-$77.8K');
  assert.equal(compactMoney(1330000), '$1.33M');
  assert.equal(compactMoney(500), '$500');
});
