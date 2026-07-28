// Wealth redesign (audit rec #5), required 12 — "mobile performs no
// duplicate financial derivation." The canonical contract is that every
// number on the Wealth landing page comes pre-computed from
// BriefingData.wealthLanding (backend/src/services/wealth-landing.js); the
// mobile components must only READ those fields, never recompute
// spend-vs-income percentages, MTD sums, savings rate, plan variance, or
// net-worth deltas themselves.
//
// This is a source-level regression guard: it reads the actual component
// files and asserts they contain none of the arithmetic patterns the OLD
// WealthCard.tsx used to compute client-side (spendPct = spending/income*100,
// Math.abs(netWorth - plan), etc.) — a real derivation reappearing in a
// future edit would fail this test even though it "typechecks fine."
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// process.cwd(), not import.meta.url — this file is type-checked by tsc
// under the app's CommonJS-era `module` setting (see tsconfig.json's
// comment on *.test.ts), which rejects `import.meta`; `npm test` always
// runs from the `mobile/` package root (see package.json's "test" script).
const COMPONENTS_DIR = join(process.cwd(), 'src/components');
const WEALTH_FILES = [
  'WealthPostureCard.tsx',
  'WealthWhatChangedCard.tsx',
  'WealthActionCard.tsx',
  'WealthExploreScreen.tsx',
];

// Patterns that would indicate a client-side re-derivation of a number the
// backend already computed (division to get a rate/percentage, or dollar
// arithmetic combining two raw fields). `money()`/display-only helpers
// (Math.round/Math.abs/toLocaleString for FORMATTING) are explicitly fine —
// only actual cross-field arithmetic is forbidden.
const FORBIDDEN_PATTERNS: RegExp[] = [
  /spending\s*\/\s*income/i,
  /income\s*\/\s*spending/i,
  /\.spending\s*\/\s*numbers\./i,
  /100\s*-\s*spendPct/i,
  /netWorth\s*-\s*plan/i,
  /planLiquidAtPace/i, // that computation belongs ONLY to wealth-landing.js server-side
];

test('required 12: no Wealth landing component recomputes spend/income percentages, savings rate, or plan variance client-side', () => {
  for (const file of WEALTH_FILES) {
    const src = readFileSync(join(COMPONENTS_DIR, file), 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.doesNotMatch(src, pattern, `${file} appears to recompute a canonical wealth number client-side (matched ${pattern})`);
    }
  }
});

test('required 12: WealthPostureCard reads numbers.savingsRate.ratePct/healthy directly rather than deriving them', () => {
  const src = readFileSync(join(COMPONENTS_DIR, 'WealthPostureCard.tsx'), 'utf8');
  assert.match(src, /numbers\.savingsRate\.ratePct/, 'expected a direct read of the server-computed ratePct');
  assert.match(src, /numbers\.savingsRate\.healthy/, 'expected a direct read of the server-computed healthy flag, not a client-side positive/negative check');
});

test('required 12: WealthPostureCard reads numbers.planPace.delta/ahead directly rather than diffing netWorth against a plan figure itself', () => {
  const src = readFileSync(join(COMPONENTS_DIR, 'WealthPostureCard.tsx'), 'utf8');
  assert.match(src, /numbers\.planPace\.delta/);
  assert.match(src, /numbers\.planPace\.ahead/);
});

test('required 12: WealthWhatChangedCard and WealthActionCard render the ranked/capped list and action as given, with no local re-ranking (no .sort( calls)', () => {
  for (const file of ['WealthWhatChangedCard.tsx', 'WealthActionCard.tsx']) {
    const src = readFileSync(join(COMPONENTS_DIR, file), 'utf8');
    assert.doesNotMatch(src, /\.sort\(/, `${file} must not re-rank the server-ranked whatChanged/action list`);
  }
});
