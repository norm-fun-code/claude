import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from './format.ts';

test('formatMoney: null/undefined render as an em dash, never as $0 or NaN', () => {
  assert.equal(formatMoney(null), '—');
  assert.equal(formatMoney(undefined), '—');
});

test('formatMoney: positive amounts get a $ prefix and thousands separators', () => {
  assert.equal(formatMoney(0), '$0');
  assert.equal(formatMoney(42), '$42');
  assert.equal(formatMoney(1234), '$1,234');
  assert.equal(formatMoney(1234567), '$1,234,567');
});

test('formatMoney: negative amounts get a leading minus before the $, not a trailing one', () => {
  assert.equal(formatMoney(-42), '-$42');
  assert.equal(formatMoney(-1234), '-$1,234');
});

test('formatMoney: rounds to the nearest whole dollar', () => {
  assert.equal(formatMoney(42.4), '$42');
  assert.equal(formatMoney(42.6), '$43');
  assert.equal(formatMoney(-42.6), '-$43');
});
