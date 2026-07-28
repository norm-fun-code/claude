import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusColor, getColors } from './theme';

const light = getColors(false);
const dark = getColors(true);

test('statusColor: positive maps to green in both appearances', () => {
  assert.equal(statusColor('positive', light), light.green);
  assert.equal(statusColor('positive', dark), dark.green);
});

test('statusColor: watch maps to amber, not red — a moderate/provisional reading never reads as an alarm', () => {
  assert.equal(statusColor('watch', light), light.amber);
  assert.notEqual(statusColor('watch', light), light.red);
});

test('statusColor: critical maps to red', () => {
  assert.equal(statusColor('critical', light), light.red);
});

test('statusColor: info maps to purple (neutral intelligence/navigation, not a verdict)', () => {
  assert.equal(statusColor('info', light), light.purple);
  assert.notEqual(statusColor('info', light), light.green);
  assert.notEqual(statusColor('info', light), light.red);
});

test('statusColor: neutral maps to subtext gray — distinct from every verdict color', () => {
  const neutral = statusColor('neutral', light);
  assert.equal(neutral, light.subtext);
  assert.notEqual(neutral, light.green);
  assert.notEqual(neutral, light.red);
  assert.notEqual(neutral, light.amber);
});

test('statusColor: the 5 semantic statuses resolve to 5 distinct colors (no accidental collisions)', () => {
  const statuses = ['positive', 'watch', 'critical', 'info', 'neutral'] as const;
  const resolved = statuses.map((s) => statusColor(s, light));
  assert.equal(new Set(resolved).size, resolved.length);
});

test('getColors: dark mode subtextStrong stays a fixed bumped-legibility tone, not the faint default subtext', () => {
  assert.notEqual(dark.subtextStrong, dark.subtext);
});

test('getColors: inputBackground switches between the light/dark token pair', () => {
  assert.notEqual(light.inputBackground, dark.inputBackground);
});
