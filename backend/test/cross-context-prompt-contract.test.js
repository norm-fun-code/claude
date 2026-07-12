// P5-B: the Cross-Domain Patterns prompt must not contradict its own rules.
// The headline EXAMPLE was 'Short sleep quietly drives your spending', which
// violates two of the prompt's own constraints: it's a wealth/spending
// connection (the prompt EXCLUDES "ANY connection involving money, spending,
// net worth, income") and it's phrased causally ("drives", where the prompt
// requires "tends to / is associated with"). A contradictory few-shot example
// invites exactly the output the rules forbid.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt } = require('../src/intelligence/crossContext');

// Pull out the example headline the prompt shows the model.
function exampleHeadline(prompt) {
  const m = prompt.match(/"headline":\s*"([^"]*)"/);
  return m ? m[1] : '';
}

test('the headline example is non-financial (no wealth/money language)', () => {
  const prompt = buildPrompt([{ type: 'correlation', title: 'x', domains: ['health', 'wellbeing'] }], '');
  const example = exampleHeadline(prompt).toLowerCase();
  for (const word of ['spend', 'spending', 'money', 'net worth', 'income', 'dollar', 'budget', 'cash']) {
    assert.ok(!example.includes(word), `the example headline must not reference wealth ("${word}"): ${example}`);
  }
});

test('the headline example is non-causal (no "drives"/"causes"/"makes you")', () => {
  const prompt = buildPrompt([{ type: 'correlation', title: 'x', domains: ['health', 'wellbeing'] }], '');
  const example = exampleHeadline(prompt).toLowerCase();
  for (const causal of ['drives', 'causes', 'makes you', 'leads to', 'results in']) {
    assert.ok(!example.includes(causal), `the example headline must not use causal language ("${causal}"): ${example}`);
  }
});

test('the example still models a real cross-domain, associative connection', () => {
  const prompt = buildPrompt([{ type: 'correlation', title: 'x', domains: ['health', 'wellbeing'] }], '');
  const example = exampleHeadline(prompt);
  assert.ok(example.length > 0, 'there is still a concrete example to anchor the format');
  // Associative phrasing that matches the prompt's own "tends to / associated with" rule.
  assert.match(example.toLowerCase(), /tend|associat|track/, 'the example uses associative, not causal, phrasing');
});
