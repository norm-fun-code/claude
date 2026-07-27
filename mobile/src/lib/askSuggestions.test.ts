import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAskSuggestions } from './askSuggestions.ts';

const BANNED_PATTERNS = [/predict/i, /typically gets in the way/i, /\bconfirmed\b/i, /why was my .* lower/i];

test('required: suggested prompts never contain unsupported causal/predictive language, with or without a snapshot', () => {
  const withSnapshot = buildAskSuggestions({
    health: { hrv: { cur: 40, prior: 50 }, sleep_hours: { cur: 6, prior: 7 } },
    wellbeing: { energy: { cur: 2, prior: 3 }, mood: { cur: 4, prior: 4 } },
    habits: { coldShower: { rate: 20, label: 'Cold shower', streak: 0 }, exercise: { rate: 100, label: 'Exercise', streak: 5 } },
    topFindings: [{ title: 'Sleep and next-day energy move together' }],
    experiments: { completed: [], running: [{ hypothesis: 'Zone 2 before 9am raises HRV' }] },
  });
  const noSnapshot = buildAskSuggestions(null);
  for (const list of [withSnapshot, noSnapshot]) {
    assert.ok(list.length > 0);
    for (const s of list) {
      for (const re of BANNED_PATTERNS) {
        assert.equal(re.test(s.text), false, `"${s.text}" matched banned pattern ${re}`);
      }
    }
  }
});

test('a finding-derived suggestion uses hedged "noticed" language, never "confirmed"', () => {
  const list = buildAskSuggestions({ topFindings: [{ title: 'Late meals precede worse sleep' }] });
  const found = list.find((s) => s.text.includes('Late meals precede worse sleep'));
  assert.ok(found);
  assert.match(found!.text, /noticed/i);
});

test('required: a suggestion disappears once its underlying condition no longer holds (recomputed fresh, not cached)', () => {
  const withGap = buildAskSuggestions({ wellbeing: { energy: { cur: 2, prior: 2 }, mood: { cur: 4, prior: 4 } } });
  assert.ok(withGap.some((s) => s.text.includes('trailing my mood')));

  const gapClosed = buildAskSuggestions({ wellbeing: { energy: { cur: 4, prior: 4 }, mood: { cur: 4, prior: 4 } } });
  assert.equal(gapClosed.some((s) => s.text.includes('trailing my mood')), false);
});

test('every suggestion carries a valid intent tag (understand|decide|act)', () => {
  const list = buildAskSuggestions({ wellbeing: { energy: { cur: 2, prior: 2 } } });
  for (const s of list) {
    assert.ok(['understand', 'decide', 'act'].includes(s.intent));
  }
});

test('always returns at least the safe fallback suggestions when the snapshot is empty', () => {
  const list = buildAskSuggestions(null);
  assert.equal(list.length, 5);
  assert.ok(list.some((s) => s.text === 'What matters most today?'));
});
