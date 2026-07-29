// Evening brief redesign — required regression: steps must never be shown
// twice (once as a metric chip, once in the "today" prose block). The
// backend's "today" field (evening-brief.js composeFallback/buildPrompt)
// always states the exact step count in prose when steps are known, so the
// mobile card must never ALSO chip a raw step count next to it.
//
// Source-level regression guard (same pattern as wealthNoDuplication.test.ts):
// reads the actual component file and asserts the chip-building code never
// reads `s.steps`/`signals.steps` into a chip — a duplicate reintroduced in a
// future edit fails this test even though it "typechecks fine" and even
// though this repo's test runner can't render JSX to check visually.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CARD_PATH = join(process.cwd(), 'src/components/EveningBriefCard.tsx');

test('required: EveningBriefCard never chips steps (today prose already states the count)', () => {
  const src = readFileSync(CARD_PATH, 'utf8');
  const chipsBlockMatch = src.match(/const chips:[\s\S]*?\n\n/);
  assert.ok(chipsBlockMatch, 'expected to find the chips-array-building block');
  const chipsBlock = chipsBlockMatch[0];
  assert.doesNotMatch(chipsBlock, /s\.steps/, 'steps must not be pushed into the chip row — "today" already states the exact count in prose');
});

test('required: EveningBriefCard chips only HRV/RHR, not steps', () => {
  const src = readFileSync(CARD_PATH, 'utf8');
  assert.match(src, /s\.hrv/);
  assert.match(src, /s\.rhr/);
  assert.doesNotMatch(src, /label:\s*'steps'/);
});
