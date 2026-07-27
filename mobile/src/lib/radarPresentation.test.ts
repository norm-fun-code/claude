// On My Radar audit — the server declares attentionClass; mobile must render
// it consistently and never reinterpret positive information as a warning.
//   node --experimental-strip-types --test src/lib/radarPresentation.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { presentationForAttentionClass } from './radarPresentation.ts';

test('action_required renders red / "Needs attention"', () => {
  assert.deepEqual(presentationForAttentionClass('action_required'), { colorToken: 'red', label: 'Needs attention' });
});

test('watch renders yellow / "Worth watching"', () => {
  assert.deepEqual(presentationForAttentionClass('watch'), { colorToken: 'yellow', label: 'Worth watching' });
});

test('ready renders purple / "Ready for you"', () => {
  assert.deepEqual(presentationForAttentionClass('ready'), { colorToken: 'purple', label: 'Ready for you' });
});

test('positive renders green / "Good news" — a positive result must never render as an alert', () => {
  const p = presentationForAttentionClass('positive');
  assert.equal(p.colorToken, 'green');
  assert.notEqual(p.colorToken, 'red');
  assert.equal(p.label, 'Good news');
});

test('informational (and any unrecognized/missing value) degrades to the quietest presentation, never red', () => {
  for (const value of ['informational', null, undefined, '', 'something_unexpected']) {
    const p = presentationForAttentionClass(value as any);
    assert.notEqual(p.colorToken, 'red', `attentionClass=${String(value)} must never render red`);
    assert.equal(p.colorToken, 'subtext');
  }
});
