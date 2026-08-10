// Reported (Aug 10 2026): "the brief gets built and then it takes a long time
// to actually show up, saying it's stale instead." Production had a
// publishable premium_fresh brief for the day at 7:20am; at 7:34am the app
// still showed the stale/waiting card.
//
// Cause: when GET /briefing finds no publishable brief for today it enqueues a
// recovery build server-side and returns its id (BriefingData.recoveryBuildId)
// precisely so the client can follow it. adoptRecoveryBuildFromResponse was
// written, documented AND unit-tested — but nothing ever called it. The server
// started the work and the app never learned it finished, so the brief only
// appeared on the next foreground or pull-to-refresh.
//
// Source-level guard (same approach as wealthNoDuplication.test.ts and
// expandableTextMeasurement.test.ts): the runner only strips TS types, it
// cannot render hooks, so the wiring is pinned by reading useBriefing's source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/hooks/useBriefing.ts'), 'utf8');

test('required: useBriefing imports AND calls adoptRecoveryBuildFromResponse — never leaves it dead', () => {
  assert.match(SRC, /import\s*\{[^}]*adoptRecoveryBuildFromResponse[^}]*\}\s*from\s*'\.\.\/lib\/rebuildResume'/,
    'the self-heal adoption helper must be imported');
  // Called, not merely imported — an import alone is what the bug looked like.
  assert.match(SRC, /adoptRecoveryBuildFromResponse\s*\(/,
    'the helper must actually be invoked, not just imported');
});

test('required: the adoption is driven by the response field the server sets', () => {
  assert.match(SRC, /data\?\.recoveryBuildId/,
    'adoption must react to BriefingData.recoveryBuildId arriving from the server');
});

test('required: the same recovery job is never adopted twice', () => {
  assert.match(SRC, /adoptedRecoveryRef/,
    'a guard is required so re-renders cannot re-adopt (and re-poll) one job repeatedly');
});

test('required: an empty-state re-check exists so a brief landing while the app is open is noticed', () => {
  // Without this the hook only fetches on mount, foreground (throttled) and
  // pull-to-refresh — a brief published while the user sits on the screen is
  // never picked up.
  assert.match(SRC, /setInterval/, 'expected a bounded re-check timer for the empty state');
  assert.match(SRC, /MAX_ATTEMPTS/, 'the re-check must be bounded, never an unbounded poll');
  assert.match(SRC, /if \(data\?\.chiefBrief\) return;/,
    'the re-check must stop as soon as there is a brief to show');
});
