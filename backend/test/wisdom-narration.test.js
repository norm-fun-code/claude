// composeWisdomNarrationScript (services/voice.js) — the Wisdom tab's spoken
// narration, mirroring composeNarrationScript/composeEveningNarrationScript's
// existing "talk, don't read labels aloud, safe on partial content" contract.
// Deliberately narrow: only the three already-curated fields a person would
// want read aloud (quote+insight, selected Notion passage+insight, relevant
// library highlight+reason) — never the raw Notion page, a URL, or the tab's
// separate generic highlights list.
const test = require('node:test');
const assert = require('node:assert/strict');
const { composeWisdomNarrationScript } = require('../src/services/voice');

const QUOTE = { quote: 'The obstacle is the way.', quoteInsight: 'Reframe the blocker as the actual work.' };
const NOTION = { notionQuote: 'Discipline equals freedom.', notionInsight: 'Structure early in the day buys flexibility later.' };
const HIGHLIGHT = {
  id: 'h1', title: 'Atomic Habits', author: 'James Clear',
  content: 'You do not rise to the level of your goals. You fall to the level of your systems.',
  url: 'https://example.com/atomic-habits', reason: 'You mentioned wanting a steadier morning routine this week.',
  relevance: 'high', similarity: 0.91,
};

function fullContent(overrides = {}) {
  return { ...QUOTE, ...NOTION, relevantHighlight: HIGHLIGHT, ...overrides };
}

test('includes all three sections, in order: quote, notion passage, library highlight', () => {
  const script = composeWisdomNarrationScript(fullContent());
  const iQuote = script.indexOf(QUOTE.quote);
  const iNotion = script.indexOf(NOTION.notionQuote);
  const iHighlight = script.indexOf(HIGHLIGHT.content.slice(0, 50));
  assert.ok(iQuote >= 0 && iNotion >= 0 && iHighlight >= 0, `expected all three sections present, got: ${script}`);
  assert.ok(iQuote < iNotion, 'quote section must come before the Notion section');
  assert.ok(iNotion < iHighlight, 'Notion section must come before the library-highlight section');
  // Each section's insight/reason rides along with its own content.
  assert.match(script, new RegExp(QUOTE.quoteInsight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(script, new RegExp(NOTION.notionInsight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(script, new RegExp(HIGHLIGHT.reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('omits the quote section cleanly when quote or quoteInsight is missing', () => {
  const noQuote = composeWisdomNarrationScript(fullContent({ quote: null }));
  assert.doesNotMatch(noQuote, /obstacle is the way/);
  assert.match(noQuote, /Discipline equals freedom/, 'the other sections must still be present');

  const noInsight = composeWisdomNarrationScript(fullContent({ quoteInsight: null }));
  assert.doesNotMatch(noInsight, /obstacle is the way/, 'a quote with no insight must not be narrated half-formed');
});

test('omits the Notion section cleanly when notionQuote or notionInsight is missing', () => {
  const noNotion = composeWisdomNarrationScript(fullContent({ notionQuote: null }));
  assert.doesNotMatch(noNotion, /Discipline equals freedom/);
  assert.match(noNotion, /obstacle is the way/, 'the other sections must still be present');
});

test('omits the library-highlight section cleanly when relevantHighlight is absent', () => {
  const script = composeWisdomNarrationScript(fullContent({ relevantHighlight: null }));
  assert.doesNotMatch(script, /Atomic Habits/);
  assert.doesNotMatch(script, /worth revisiting/);
  assert.match(script, /obstacle is the way/);
  assert.match(script, /Discipline equals freedom/);
});

test('library highlight without a reason still narrates the excerpt, just without a "why it matters" clause', () => {
  const script = composeWisdomNarrationScript(fullContent({ relevantHighlight: { ...HIGHLIGHT, reason: null } }));
  assert.match(script, /Atomic Habits/);
  assert.match(script, /level of your systems/);
  assert.doesNotMatch(script, /steadier morning routine/, 'no reason text should appear when reason is null');
});

test('never reads the raw Notion page text, only the selected quote+insight', () => {
  const script = composeWisdomNarrationScript(fullContent({ notionText: 'A' + 'x'.repeat(5000) }));
  assert.ok(!script.includes('x'.repeat(5000)), 'the full raw Notion page must never be read aloud');
  assert.ok(script.length < 2000, 'script must stay short even if notionText is huge — it must never leak in');
});

test('never reads a URL', () => {
  const script = composeWisdomNarrationScript(fullContent());
  assert.doesNotMatch(script, /https?:\/\//, 'a URL is not something a listener wants read aloud');
});

test('never reads the tab\'s separate generic highlights list — only the curated relevantHighlight field', () => {
  // HighlightsCard (a different, unrelated Wisdom-tab card) has no backing
  // content field on the briefing object at all — composeWisdomNarrationScript
  // only ever reads relevantHighlight, so a generic `highlights` array on the
  // content object (if one existed) must be structurally impossible to reach.
  const script = composeWisdomNarrationScript({
    ...fullContent(),
    highlights: [{ title: 'Unrelated 1' }, { title: 'Unrelated 2' }, { title: 'Unrelated 3' }],
  });
  assert.doesNotMatch(script, /Unrelated/);
});

test('empty Wisdom content produces no narration', () => {
  assert.equal(composeWisdomNarrationScript({}), '');
  assert.equal(composeWisdomNarrationScript(null), '');
  assert.equal(composeWisdomNarrationScript(undefined), '');
  assert.equal(composeWisdomNarrationScript({ quote: 'only a quote, no insight' }), '');
});

test('does not read mechanical section headings — uses natural spoken transitions', () => {
  const script = composeWisdomNarrationScript(fullContent());
  assert.doesNotMatch(script, /^Quote:/i);
  assert.doesNotMatch(script, /Notion Passage:/i);
  assert.doesNotMatch(script, /Library Highlight:/i);
});

test('stays well under the 60-90s target (roughly 1400 chars, far below the other composers\' 3800-char cap)', () => {
  const longHighlight = { ...HIGHLIGHT, content: 'y'.repeat(3000), reason: 'z'.repeat(500) };
  const script = composeWisdomNarrationScript(fullContent({ relevantHighlight: longHighlight }));
  assert.ok(script.length <= 1400, `expected a concise script, got ${script.length} chars`);
});
