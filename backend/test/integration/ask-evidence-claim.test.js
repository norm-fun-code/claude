// EvidenceClaim v1 — Ask (chat/ask.js) end-to-end against a real Postgres:
// proves ask() itself (not just the underlying validator functions) builds
// its canonical facts packet, validates the final answer text, and
// neutralizes a contradiction before returning — with the LLM mocked (no
// new LLM call is introduced by validation itself; this only mocks the
// EXISTING generation call so the test is deterministic).
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const { ask } = require('../../src/chat/ask');
const commitmentsStore = require('../../src/store/commitments');

const ORIGINAL_GENERATE_TEXT = llm.generateText;
const ORIGINAL_EMBED = llm.embed;
const MARKER = `ask-ec-test-${Date.now()}`;

afterEach(async () => {
  llm.generateText = ORIGINAL_GENERATE_TEXT;
  llm.embed = ORIGINAL_EMBED;
});
after(async () => { await closeDb(); });

test('ask() neutralizes an answer that falsely describes a real, still-open commitment as done', async () => {
  llm.embed = async () => [null];
  llm.generateText = async () => `Nice work — ${MARKER} call the accountant is done, great follow-through this week.`;
  const row = await commitmentsStore.create({ title: `${MARKER} call the accountant`, source: 'test' });
  try {
    const result = await ask('how am I doing on my commitments this week?');
    assert.equal(result.answer, "I don't have a reliable, confirmed number for that right now — let me know if you'd like me to look closer.");
    assert.deepEqual(result.debugEvidence, ['commitment_completion']);
  } finally {
    await db.query('DELETE FROM commitments WHERE id = $1', [row.id]);
  }
});

test('ask() leaves a clean, canonically-accurate answer untouched (no debugEvidence field at all)', async () => {
  llm.embed = async () => [null];
  llm.generateText = async () => `${MARKER} call the accountant is still open — worth getting to before the week ends.`;
  const row = await commitmentsStore.create({ title: `${MARKER} call the accountant`, source: 'test' });
  try {
    const result = await ask('how am I doing on my commitments this week?');
    assert.equal(result.answer, `${MARKER} call the accountant is still open — worth getting to before the week ends.`);
    assert.equal('debugEvidence' in result, false);
  } finally {
    await db.query('DELETE FROM commitments WHERE id = $1', [row.id]);
  }
});
