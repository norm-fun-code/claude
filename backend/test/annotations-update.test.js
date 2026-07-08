// Editing a context annotation (e.g. "Correction: it's my cold, not Nancy's")
// must update the SAME row in place — every downstream reader (analyze.js's
// health-anomaly "Context: ..." labeling, the briefing's annotationsContext,
// wealth-insights' spend-context filter) queries the annotations table live
// on each build, so a correction is only visible on the next read if the SQL
// actually targets the existing row rather than inserting a new one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAnnotationUpdate } = require('../src/store/annotations');

test('label-only edit updates just the label, param order matches placeholders', () => {
  const built = buildAnnotationUpdate({ label: '  fixed text  ', category: undefined, id: 'abc-123' });
  assert.equal(built.sql, 'UPDATE annotations SET label = $1 WHERE id = $2');
  assert.deepEqual(built.params, ['fixed text', 'abc-123']); // trimmed
});

test('category-only edit updates just the category', () => {
  const built = buildAnnotationUpdate({ label: undefined, category: 'illness', id: 'abc-123' });
  assert.equal(built.sql, 'UPDATE annotations SET category = $1 WHERE id = $2');
  assert.deepEqual(built.params, ['illness', 'abc-123']);
});

test('editing both label and category in one call keeps placeholders in sync with params', () => {
  const built = buildAnnotationUpdate({ label: 'new label', category: 'life', id: 'xyz-789' });
  assert.equal(built.sql, 'UPDATE annotations SET label = $1, category = $2 WHERE id = $3');
  assert.deepEqual(built.params, ['new label', 'life', 'xyz-789']);
});

test('neither field provided returns null (nothing to update)', () => {
  assert.equal(buildAnnotationUpdate({ label: undefined, category: undefined, id: 'x' }), null);
  assert.equal(buildAnnotationUpdate({ label: null, category: null, id: 'x' }), null);
});

test('this is the SAME-ROW edit, not an insert — the WHERE clause targets id, never appears in an INSERT', () => {
  const built = buildAnnotationUpdate({ label: 'x', id: 'the-id' });
  assert.match(built.sql, /^UPDATE annotations SET/);
  assert.match(built.sql, /WHERE id = \$\d+$/);
});
