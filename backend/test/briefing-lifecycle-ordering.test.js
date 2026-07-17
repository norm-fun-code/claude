// Build lifecycle (#6): wealth recomputation must finish BEFORE the state
// snapshot is cut and the brief is persisted — never after. A post-persist
// wealth recompute is exactly the "serve a brief, then immediately recompute
// newer totals that contradict it" window we're closing. This is a structural
// regression guard on the builder's ordering (source-level, deterministic — the
// full build needs an LLM + DB to run end-to-end, which CI's integration job
// exercises; this pins the invariant cheaply on every unit run).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '../src/routes/briefing.js'), 'utf8');

test('the full build recomputes wealth flows BEFORE persisting the brief', () => {
  const recomputeIdx = SRC.indexOf('recompute-wealth pre-cut');
  const saveIdx = SRC.indexOf('saveBriefing({ kind: \'daily\', content: response })');
  assert.ok(recomputeIdx !== -1, 'a pre-cut wealth recompute must exist');
  assert.ok(saveIdx !== -1, 'the full-build persist must exist');
  assert.ok(recomputeIdx < saveIdx, 'wealth recompute must run before the brief is persisted');
});

test('the post-persist background chain does NOT recompute wealth flows', () => {
  const saveIdx = SRC.indexOf('saveBriefing({ kind: \'daily\', content: response })');
  const afterSave = SRC.slice(saveIdx);
  assert.ok(!/recomputeWealthFlows\s*\(/.test(afterSave),
    'no recomputeWealthFlows() may run after the brief is persisted (it would invalidate the just-served brief)');
});

test('the snapshot id + snapshot time on the response come from the real BrainSnapshot, not a re-minted id', () => {
  // The response must reference the cut BrainSnapshot's identity, not build its
  // own snap_ string independently.
  assert.match(SRC, /snapshotId:\s*brainSnapshot\?\.snapshotId/);
  assert.match(SRC, /snapshotAt:\s*snapshotAtIso/);
  // And the old independently-minted id string is gone.
  assert.ok(!/snapshotId:\s*`snap_\$\{new Date\(\)/.test(SRC),
    'the route must not mint its own snapshot id anymore');
});
