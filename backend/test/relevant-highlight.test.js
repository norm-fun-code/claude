const test = require('node:test');
const assert = require('node:assert/strict');
const rh = require('../src/intelligence/relevant-highlight');

test('buildRelevanceQuery uses situation, not a generic fallback', () => {
  const q = rh.buildRelevanceQuery({ goals: ['Close the seed round'], lifeContext: ['fundraising'], themes: 'focus' });
  assert.match(q, /Close the seed round/);
  assert.match(q, /fundraising/);
  assert.match(q, /focus/);
});

test('buildRelevanceQuery falls back to evergreen themes when empty', () => {
  const q = rh.buildRelevanceQuery({});
  assert.ok(q.length > 0);
  assert.doesNotMatch(q, /Working toward/);
});

test('buildPrompt lists candidates and asks for index/reason/relevance JSON', () => {
  const p = rh.buildPrompt('Raising a seed round', [
    { content: 'Neediness reads as weakness', author: 'Klaff', title: 'Pitch Anything' },
    { content: 'Independence is the goal', author: 'Housel', title: 'Psychology of Money' },
  ]);
  assert.match(p, /\[0\]/);
  assert.match(p, /\[1\]/);
  assert.match(p, /relevance/);
  assert.match(p, /index/);
});

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(rh.extractJson('```json\n{"index":1,"reason":"x","relevance":"high"}\n```'), { index: 1, reason: 'x', relevance: 'high' });
  assert.deepEqual(rh.extractJson('Sure: {"index":0,"relevance":"low","reason":""} done'), { index: 0, relevance: 'low', reason: '' });
  assert.equal(rh.extractJson('not json'), null);
});
