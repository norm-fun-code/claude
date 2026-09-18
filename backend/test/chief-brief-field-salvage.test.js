// A destroyed field is recovered from an attempt we already paid for, rather
// than stubbed.
//
// The reported symptom — "clicking the notification only surfaces the one-line
// brief" — is this mechanism failing. Neutralization strips whole SENTENCES,
// and the synthesis is typically ONE sentence, so a single flagged claim
// destroys the entire headline. ensureRequiredFieldsPresent then backstops it
// with a six-word grounded stub ("Recovery is red at 35 today."), while
// action/risk/move from the same response are untouched and good — which is
// exactly what the screenshot showed.
//
// Violations are per-field, so an earlier attempt that tripped only on `move`
// still holds a perfectly good synthesis. Finalizing one attempt wholesale
// threw it away. Adopting it costs no extra LLM call and weakens nothing: the
// candidate is re-validated against the same facts and rejected if it carries
// any violation of its own or is itself a stub.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const SRC = readFileSync(require.resolve('../src/services/briefing-ai'), 'utf8');
const BLOCK = SRC.slice(
  SRC.indexOf('Before stubbing a destroyed field'),
  SRC.indexOf('Backstop: guarantee no required field shipped blank')
);

test('salvage runs BEFORE the grounded stub is applied', () => {
  // Ordering is the whole feature. After ensureRequiredFieldsPresent the field
  // is no longer empty — it holds a stub — so salvage would never fire.
  assert.ok(BLOCK.length > 0, 'the salvage block must exist');
  assert.ok(
    SRC.indexOf('Before stubbing a destroyed field') < SRC.indexOf('out = ensureRequiredFieldsPresent'),
    'salvage must precede the backstop'
  );
});

test('only a field that was actually destroyed is replaced', () => {
  assert.match(BLOCK, /const destroyed = typeof current !== 'string' \|\| !current\.trim\(\)/);
  assert.match(BLOCK, /if \(!destroyed\) continue;/, 'a good field must never be swapped out');
});

test('a candidate is re-validated, and rejected if it carries its own violation', () => {
  // Without this the salvage would reintroduce exactly the contradictions the
  // finalize path exists to remove.
  assert.match(BLOCK, /findFalseGoalCompletions\(probe, openGoals\)/);
  assert.match(BLOCK, /validateChiefBriefClaims\(probe, snapshotFacts\)/);
  assert.match(BLOCK, /if \(gv\.length \|\| cv2\.some\(\(v\) => v\.field === field\)\) continue;/);
});

test('a candidate that is itself a grounded stub is never adopted', () => {
  // Swapping one stub for another would be pure churn and would still show the
  // one-line brief.
  assert.match(BLOCK, /isGroundedFallbackText\(field, candidate, snapshotFacts\)/);
});

test('the attempt that still holds good fields is passed in as the alternate', () => {
  // The failing production path is semantic_correction_retry_contradicted: the
  // RETRY is finalized, so attempt 1/2 is the candidate worth mining.
  assert.match(
    SRC,
    /finalizeSafe\(retry, 'semantic_correction_retry_contradicted', \[result\]\)/,
    'the earlier attempt must be offered as an alternate'
  );
  assert.match(
    SRC,
    /finalizeSafe\(result, 'quality_retry_contradicted', \[qualityRetry\]\)/,
    'the discarded quality retry may still hold a clean field'
  );
});

test('salvage covers every required field, not just synthesis', () => {
  assert.match(BLOCK, /for \(const field of REQUIRED_BRIEF_FIELDS\)/);
});
