// Ask's PRECEDENT block — the framing is the risk, not the numbers.
//
// Handing a model "recovery averaged +7 after the lighter days and −5 after
// the harder ones" and nothing else reliably produces "so you should take it
// easy today" — a causal recommendation from an observational split of a
// dozen days. The block therefore ships its interpretation rule alongside its
// facts, the same way recoveryContext() ships "use the label, not the raw
// band". These tests pin that rule, and pin that the block reaches the prompt
// at all (an unwired context builder is a silent no-op — the exact defect
// mobile's recoveryBuildAdoption test exists to catch on the client).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { buildPrompt } = require('../src/chat/ask');

const SRC = readFileSync(join(__dirname, '../src/chat/ask.js'), 'utf8');

test('the precedent block reaches the prompt when present', () => {
  const { prompt } = buildPrompt({
    question: 'why do I feel like this?',
    precedentInsight: 'PRECEDENT — SIMILAR PAST MORNINGS:\n- Today matches 9 past mornings.',
  });
  assert.match(prompt, /PRECEDENT — SIMILAR PAST MORNINGS/);
  assert.match(prompt, /matches 9 past mornings/);
});

test('the prompt is unchanged when there is no precedent to report', () => {
  const withNothing = buildPrompt({ question: 'why do I feel like this?' }).prompt;
  assert.ok(!/PRECEDENT/.test(withNothing), 'absent evidence must add nothing, not an empty header');
});

test('precedentContext is actually wired into ask() — not merely defined', () => {
  // It is gathered in the allSettled batch, read out of the result, and passed
  // to buildPrompt. Missing any one of the three makes the feature dead code
  // that still looks implemented.
  assert.match(SRC, /precedentResult,/, 'must be destructured from the settled batch');
  assert.match(SRC, /personal \? precedentContext\(\) : Promise\.resolve\(null\)/,
    'must be gathered, and only for personal questions');
  assert.match(SRC, /const precedentInsight = precedentResult\.status === 'fulfilled'/,
    'the settled result must be read');
  assert.match(SRC, /buildPrompt\(\{[^}]*precedentInsight[^}]*\}\)/,
    'the value must reach buildPrompt');
});

test('the block instructs against causal and predictive readings', () => {
  // Asserted against the real source rather than a copy, so rewording the
  // guidance cannot silently drop the constraint.
  const start = SRC.indexOf('async function precedentContext');
  const end = SRC.indexOf('function buildPrompt', start);
  const block = SRC.slice(start, end);
  assert.ok(start > -1 && end > start);
  assert.match(block, /NOT a causal finding/i);
  assert.match(block, /NOT a prediction/i);
  assert.match(block, /[Nn]ever present this comparison as the reason to do something/,
    'the model must be told not to convert the split into a recommendation');
  assert.match(block, /dates/i, 'the model must be told to cite the real dates');
});

test('precedentContext shares the engine memo instead of re-scanning the spine', () => {
  const start = SRC.indexOf('async function precedentContext');
  const end = SRC.indexOf('function buildPrompt', start);
  const block = SRC.slice(start, end);
  assert.match(block, /cachedPrecedent/, 'must go through the cached entry point');
  assert.ok(!/[^d]computePrecedent\(/.test(block), 'must not call the uncached scan directly');
});

test('precedentContext returns null rather than throwing when the engine fails', async () => {
  const { precedentContext } = require('../src/chat/ask');
  const enginePath = require.resolve('../src/intelligence/precedent');
  const engine = require(enginePath);
  const original = engine.cachedPrecedent;
  engine.cachedPrecedent = async () => { throw new Error('spine unavailable'); };
  try {
    assert.equal(await precedentContext(), null, 'a failed read must degrade the prompt, never the request');
  } finally {
    engine.cachedPrecedent = original;
  }
});
