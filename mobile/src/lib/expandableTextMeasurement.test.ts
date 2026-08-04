// Source-level regression guard for ExpandableText's measurement contract
// (same pattern as wealthNoDuplication.test.ts — this project's test runner
// only strips TS types, it cannot render JSX, so the invariant is pinned by
// reading the component source).
//
// The bug this exists to prevent: `onTextLayout` on a <Text numberOfLines={N}>
// reports only the CLAMPED lines on iOS, so `lines.length > collapsedLines`
// measured against the visible (already-clamped) Text is never true. That made
// `truncated` permanently false — no More/Less affordance, and the wrapping
// TouchableOpacity stayed `disabled`, so tapping truncated text anywhere in the
// app (Since This Morning, Worth a look, Experiments) silently did nothing.
// The true line count MUST be measured from an unclamped copy of the text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/components/ExpandableText.tsx'), 'utf8');

test('required: onTextLayout is never attached to a Text that also clamps with numberOfLines', () => {
  // Find every JSX <Text ...> opening tag and assert none carries BOTH
  // onTextLayout and numberOfLines — that pairing is precisely the broken
  // measurement (clamped lines can never exceed the clamp).
  const textTags = SRC.match(/<Text\b[\s\S]*?>/g) ?? [];
  assert.ok(textTags.length > 0, 'expected to find <Text> elements to inspect');
  for (const tag of textTags) {
    const measures = tag.includes('onTextLayout');
    const clamps = tag.includes('numberOfLines');
    assert.ok(
      !(measures && clamps),
      `a <Text> that clamps with numberOfLines can never report more lines than the clamp — measure from an unclamped copy instead. Offending tag: ${tag}`
    );
  }
});

test('required: the component still measures line count from some onTextLayout source', () => {
  assert.match(SRC, /onTextLayout/, 'expected an onTextLayout-based measurement');
  assert.match(
    SRC,
    /lines\.length\s*>\s*collapsedLines/,
    'expected the truncation verdict to compare the measured line count against collapsedLines'
  );
});

test('required: the hidden measurer is kept out of layout flow and out of the accessibility tree', () => {
  assert.match(SRC, /position:\s*'absolute'/, 'the measurer must be absolutely positioned so it adds no height');
  assert.match(SRC, /opacity:\s*0/, 'the measurer must be invisible');
  assert.match(SRC, /accessible=\{false\}/, 'the measurer must not be announced to screen readers as duplicate text');
});
