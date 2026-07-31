// User-statement extraction — the one LLM step in the learning layer. The
// Legacy user-statement extraction. New production writes compile directly
// into context_assertions at capture time; this helper remains only to repair
// old data, never as a nightly competing memory authority. These tests pin
// its parsing/sanitization plus that production promotion does not invoke it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseExtractedStatements, buildExtractPrompt } = require('../src/intelligence/beliefs');

test('parseExtractedStatements sanitizes slugs and builds stated: dedup keys', () => {
  const out = parseExtractedStatements([
    { slug: 'Cold Showers When Sick!!', statement: 'They skip cold showers when sick — an explained pause, not a lapse.' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'user_statement');
  assert.equal(out[0].dedupKey, 'stated:cold-showers-when-sick');
  assert.equal(out[0].confidence, 0.85);
});

test('malformed items are dropped: missing statement, tiny statement, missing slug, non-array input', () => {
  assert.equal(parseExtractedStatements(null).length, 0);
  assert.equal(parseExtractedStatements({ slug: 'x', statement: 'valid enough statement' }).length, 0, 'object, not array');
  const out = parseExtractedStatements([
    { slug: 'ok', statement: 'short' },              // too short
    { slug: '', statement: 'a perfectly fine durable statement' }, // empty slug
    { statement: 'no slug at all here either way' },  // missing slug
    { slug: 'good-one', statement: 'Friday evenings are Sabbath — never schedule over them.' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].dedupKey, 'stated:good-one');
});

test('extraction is capped at 5 statements per run — a chatty day cannot flood the belief store', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ slug: `s-${i}`, statement: `A durable statement number ${i} long enough.` }));
  assert.equal(parseExtractedStatements(items).length, 5);
});

test('the prompt carries existing statements as a do-not-repeat list and truncates long entries', () => {
  const prompt = buildExtractPrompt(
    [{ entry_date: '2026-07-10', text: 'x'.repeat(600) }],
    ['They skip cold showers when sick.']
  );
  assert.match(prompt, /EXISTING \(already captured/);
  assert.match(prompt, /- They skip cold showers when sick\./);
  assert.match(prompt, /\[2026-07-10\]/);
  assert.ok(!prompt.includes('x'.repeat(501)), 'entry text truncated to 500 chars');
});

test('extractStatementBeliefs: skips the LLM entirely when no fresh journal entries exist', async () => {
  const dayJournal = require('../src/store/dayJournal');
  const llm = require('../src/llm');
  const origRecent = dayJournal.recent;
  const origGen = llm.generateText;
  let llmCalled = false;
  dayJournal.recent = async () => [];
  llm.generateText = async () => { llmCalled = true; return '[]'; };
  try {
    const r = await require('../src/intelligence/beliefs').extractStatementBeliefs();
    assert.equal(r.skipped, 'no_recent_entries');
    assert.equal(llmCalled, false, 'a quiet day must cost zero LLM calls');
  } finally {
    dayJournal.recent = origRecent;
    llm.generateText = origGen;
  }
});

test('extractStatementBeliefs: an unparseable LLM response degrades to zero extractions, not a throw', async () => {
  const dayJournal = require('../src/store/dayJournal');
  const llm = require('../src/llm');
  const origRecent = dayJournal.recent;
  const origGen = llm.generateText;
  const beliefsStore = require('../src/store/beliefs');
  const origList = beliefsStore.listActive;
  dayJournal.recent = async () => [{ entry_date: '2026-07-10', text: 'Talked about my day.' }];
  beliefsStore.listActive = async () => [];
  llm.generateText = async () => 'Sorry, I cannot help with that.';
  try {
    const r = await require('../src/intelligence/beliefs').extractStatementBeliefs();
    assert.equal(r.extracted, 0);
    assert.equal(r.skipped, 'unparseable_response');
  } finally {
    dayJournal.recent = origRecent;
    llm.generateText = origGen;
    beliefsStore.listActive = origList;
  }
});

test('normal belief promotion never re-extracts user statements from raw journal text', async () => {
  const dayJournal = require('../src/store/dayJournal');
  const dismissed = require('../src/store/dismissedInsights');
  const attention = require('../src/store/attention');
  const originalRecent = dayJournal.recent;
  const originalDismissed = dismissed.listDismissed;
  const originalOutcomes = attention.outcomeCounts;
  let journalRead = false;
  dayJournal.recent = async () => { journalRead = true; return []; };
  dismissed.listDismissed = async () => [];
  attention.outcomeCounts = async () => [];
  try {
    const result = await require('../src/intelligence/beliefs').promoteBeliefs();
    assert.equal(result.errors.length, 0);
    assert.equal(journalRead, false, 'raw journal text is not a second production memory write path');
  } finally {
    dayJournal.recent = originalRecent;
    dismissed.listDismissed = originalDismissed;
    attention.outcomeCounts = originalOutcomes;
  }
});
