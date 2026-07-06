const test = require('node:test');
const assert = require('node:assert/strict');
const { filterQuoteLines } = require('../src/services/googleDoc');

test('filterQuoteLines: drops a numbered chapter heading with no ending punctuation', () => {
  const lines = filterQuoteLines(['03   Adversity Is the Curriculum']);
  assert.deepEqual(lines, []);
});

test('filterQuoteLines: keeps a real quote even if it starts with a digit', () => {
  const lines = filterQuoteLines(['3 things matter more than comfort: courage, honesty, and presence.']);
  assert.deepEqual(lines, ['3 things matter more than comfort: courage, honesty, and presence.']);
});

test('filterQuoteLines: keeps an ordinary long quote', () => {
  const quote = 'Presence is a choice you make about where your attention goes right now, not a mood you wait for.';
  assert.deepEqual(filterQuoteLines([quote]), [quote]);
});

test('filterQuoteLines: still drops short lines, decorative headers, and intro fragments', () => {
  const lines = filterQuoteLines([
    'Too short',
    '★ Section Header That Is Definitely Long Enough To Pass The Length Check',
    'An intro fragment that trails off into a colon like this one right here:',
  ]);
  assert.deepEqual(lines, []);
});
