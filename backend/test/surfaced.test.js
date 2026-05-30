const test = require('node:test');
const assert = require('node:assert/strict');
const { pickFresh } = require('../src/store/surfaced');

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const key = (x) => x.id;

test('pickFresh prefers items not seen recently', () => {
  const chosen = pickFresh(items, new Set(['a']), { max: 1, keyFn: key });
  assert.equal(chosen[0].id, 'b');
});

test('pickFresh returns multiple fresh items in order', () => {
  const chosen = pickFresh(items, new Set(['a']), { max: 2, keyFn: key });
  assert.deepEqual(chosen.map(key), ['b', 'c']);
});

test('pickFresh falls back to seen items rather than returning nothing', () => {
  const chosen = pickFresh(items, new Set(['a', 'b', 'c']), { max: 1, keyFn: key });
  assert.equal(chosen.length, 1); // everything seen → still surface something
});

test('pickFresh tops up with seen items to honor max', () => {
  const chosen = pickFresh(items, new Set(['b', 'c']), { max: 3, keyFn: key });
  assert.equal(chosen.length, 3);
  assert.equal(chosen[0].id, 'a'); // the only fresh one comes first
});
