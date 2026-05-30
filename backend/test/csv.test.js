const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, parseCsvObjects } = require('../src/util/csv');

test('parses simple rows', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('handles quoted fields with commas and newlines', () => {
  const text = 'name,note\n"Smith, John","line1\nline2"';
  assert.deepEqual(parseCsv(text), [['name', 'note'], ['Smith, John', 'line1\nline2']]);
});

test('handles escaped quotes', () => {
  assert.deepEqual(parseCsv('a\n"she said ""hi"""'), [['a'], ['she said "hi"']]);
});

test('strips BOM and trailing newline', () => {
  const rows = parseCsv('﻿a,b\n1,2\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('parseCsvObjects keys by trimmed header and skips blank lines', () => {
  const { headers, records } = parseCsvObjects('Date, Amount \n2026-05-01,-12.50\n\n');
  assert.deepEqual(headers, ['Date', 'Amount']);
  assert.equal(records.length, 1);
  assert.equal(records[0].Date, '2026-05-01');
  assert.equal(records[0].Amount, '-12.50');
});
