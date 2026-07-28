// Wealth severity/reliability cleanup, required 5 — "loading a connected
// source never renders 'Connect Monarch'". The bug: App.tsx's Wealth tab
// showed the disconnected CTA whenever `landing` was merely falsy, which
// fires on ANY transient gap (first-load timing, a scoped rebuild that
// doesn't touch wealth, a momentary fetch hiccup) — not just genuine
// disconnection. The fix reads the canonical source-health authority
// (landing.sourceHealth.configured) instead of inferring disconnection from
// "no data yet". This is a source-level regression guard, same pattern as
// wealthNoDuplication.test.ts: it reads the actual App.tsx text and asserts
// the EmptyNote gate can never fire from `!landing` alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_TSX = join(process.cwd(), 'App.tsx');

function wealthTabBlock(): string {
  const src = readFileSync(APP_TSX, 'utf8');
  const start = src.indexOf("case 'wealth': {");
  assert.ok(start >= 0, 'expected to find the Wealth tab case block in App.tsx');
  const end = src.indexOf("case 'wisdom':", start);
  assert.ok(end > start, 'expected to find the following tab case to bound the Wealth block');
  return src.slice(start, end);
}

test('required 5 — the "Connect Monarch" EmptyNote is never gated on `!landing` alone', () => {
  const block = wealthTabBlock();
  // The old bug: `{!landing && (<EmptyNote ... "Connect Monarch" .../>)}`
  // with no other condition. Assert that exact shape is gone.
  assert.doesNotMatch(
    block,
    /\{!landing\s*&&\s*\(\s*<EmptyNote/,
    'the disconnected CTA must not be gated on `!landing` alone — that fires on ANY transient gap, not just real disconnection'
  );
});

test('required 5 — the disconnected CTA references the canonical source-health authority (sourceHealth.configured)', () => {
  const block = wealthTabBlock();
  assert.match(
    block,
    /sourceHealth\.configured\s*===\s*false/,
    'the disconnected CTA must be driven by landing.sourceHealth.configured, the canonical source-health authority — never inferred from whether a response happened to contain rows'
  );
});

test('required 5 — the EmptyNote render condition includes both the genuinely-disconnected case and the never-loaded case, not a bare falsy check', () => {
  const block = wealthTabBlock();
  const emptyNoteGate = block.match(/\{[^{}]*sourceDisconnected[^{}]*\}\s*&&\s*[\s\S]{0,20}<EmptyNote/) || block.match(/sourceDisconnected \|\| neverLoaded/);
  assert.ok(emptyNoteGate, 'expected an explicit sourceDisconnected/neverLoaded gate, not a single `!landing` check');
});
