// Item from the deep product critique's "relay, don't restate" finding: a
// life-chapter fact (e.g. Nancy's pregnancy) is threaded into every surface
// that touches the user's life — the brief, goals, forecasts, and Ask. The
// critique's fix wasn't fewer mentions (the threading itself is the moat),
// it's that each surface should relay the fact forward (a next step, a
// timely implication) rather than just restating the bare fact the user
// already knows. This confirms the Ask assistant's system prompt carries
// that instruction whenever a life chapter is present.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const lifeChaptersStore = require('../../src/store/lifeChapters');
const llm = require('../../src/llm');
const { ask } = require('../../src/chat/ask');

const LABEL = `Nancy pregnant (relay-test ${Date.now()})`;
let chapterId;

after(async () => {
  if (chapterId) await lifeChaptersStore.deactivate(chapterId).catch(() => {});
  await closeDb();
});

test('Ask system prompt tells the model to relay life-chapter facts forward, not just restate them', async (t) => {
  const created = await lifeChaptersStore.create({
    kind: 'pregnancy', label: LABEL, keyDate: '2027-01-06', keyDateLabel: 'due',
  });
  chapterId = created.id;

  let capturedSystem = null;
  const originalGenerateText = llm.generateText;
  const originalEmbed = llm.embed;
  t.after(() => {
    llm.generateText = originalGenerateText;
    llm.embed = originalEmbed;
  });
  // No embeddings API in this test env — ask() already tolerates embed()
  // throwing (falls back to empty retrieval), so make that explicit rather
  // than relying on a real network call failing.
  llm.embed = async () => { throw new Error('no embeddings in test env'); };
  llm.generateText = async ({ system }) => {
    capturedSystem = system;
    return 'A plain-language answer with no special formatting needed here.';
  };

  await ask('How is my week looking overall?', {});

  assert.ok(capturedSystem, 'expected the full-reasoning LLM call to have fired');
  assert.match(capturedSystem, new RegExp(LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the chapter fact must reach the prompt');
  assert.match(
    capturedSystem,
    /don't just restate it here too/,
    'the relay-not-restate instruction must accompany the LIFE CHAPTERS block'
  );
});
