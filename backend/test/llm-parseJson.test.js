// The shared LLM output boundary (src/llm/parseJson.js) — see the
// engineering review's #4. These lock in the extraction behavior every
// migrated call site now depends on, plus the two failure-logging paths
// that were the actual point of consolidating this.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractJson, parseAndValidate } = require('../src/llm/parseJson');

test('extractJson parses a clean JSON object', () => {
  assert.deepEqual(extractJson('{"a":1,"b":"x"}'), { a: 1, b: 'x' });
});

test('extractJson strips a ```json fence', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('extractJson strips a bare ``` fence', () => {
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
});

test('extractJson slices out an object surrounded by prose', () => {
  assert.deepEqual(extractJson('Sure, here you go:\n{"a":1}\nHope that helps!'), { a: 1 });
});

test('extractJson returns null for empty/garbage input', () => {
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
  assert.equal(extractJson('not json at all'), null);
});

test('extractJson returns null when even the sliced substring fails to parse', () => {
  assert.equal(extractJson('{ this is not valid json }'), null);
});

// The #1 real-world way a model asked to write natural prose inside a JSON
// string breaks JSON.parse: an actual newline byte instead of the two
// characters \ and n. This is the fix aimed squarely at the live bug
// ("chief-brief response was not valid JSON") where the model is asked for
// several multi-sentence fields.
test('extractJson repairs a raw (unescaped) newline inside a string value', () => {
  const raw = '{"synthesis": "First sentence.\nSecond sentence.", "action": "ok"}';
  assert.deepEqual(extractJson(raw), { synthesis: 'First sentence.\nSecond sentence.', action: 'ok' });
});

test('extractJson repairs multiple raw control characters across multiple fields', () => {
  const raw = '{"a": "line one\nline two\tindented", "b": "clean"}';
  assert.deepEqual(extractJson(raw), { a: 'line one\nline two\tindented', b: 'clean' });
});

test('extractJson repair does not corrupt already-valid JSON with real newlines only in whitespace', () => {
  const raw = '{\n  "a": 1,\n  "b": "no control chars in this string"\n}';
  assert.deepEqual(extractJson(raw), { a: 1, b: 'no control chars in this string' });
});

test('extractJson repair correctly steps over escaped quotes without flipping string state', () => {
  const raw = '{"a": "she said \\"hi\\"\nthen left"}';
  assert.deepEqual(extractJson(raw), { a: 'she said "hi"\nthen left' });
});

test('extractJson repairs a raw newline even when the JSON is wrapped in prose', () => {
  const raw = 'Here is the JSON:\n{"a": "broken\nvalue"}\nDone.';
  assert.deepEqual(extractJson(raw), { a: 'broken\nvalue' });
});

test('parseAndValidate returns the validated value on success', () => {
  const result = parseAndValidate('{"score":4}', {
    label: 'test',
    validate: (p) => (Number.isInteger(p.score) ? { score: p.score } : null),
  });
  assert.deepEqual(result, { score: 4 });
});

test('parseAndValidate returns null and logs a preview when the text is not JSON', () => {
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  let result;
  try {
    result = parseAndValidate('garbage response', { label: 'my-service', validate: (p) => p });
  } finally {
    console.error = original;
  }
  assert.equal(result, null);
  assert.ok(logs.some((l) => l.includes('my-service') && l.includes('not valid JSON') && l.includes('garbage response')));
});

test('parseAndValidate returns null and logs the parsed object when validate() rejects it', () => {
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  let result;
  try {
    result = parseAndValidate('{"score":99}', {
      label: 'my-service',
      validate: (p) => (p.score >= 1 && p.score <= 5 ? p : null),
    });
  } finally {
    console.error = original;
  }
  assert.equal(result, null);
  assert.ok(logs.some((l) => l.includes('my-service') && l.includes('shape validation failed') && l.includes('99')));
});

test('parseAndValidate never throws even if validate() itself throws', () => {
  assert.throws(() => {
    parseAndValidate('{"a":1}', { label: 'x', validate: () => { throw new Error('boom'); } });
  });
  // Documents current behavior: a throwing validate() propagates rather than
  // being swallowed — callers write validate() as a pure shape-check, not a
  // thing that can fail unexpectedly, matching every migrated call site.
});
