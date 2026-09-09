'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { isExploration, EXPLORATION_PREFIX } = require('../src/chat/exploration');

test('Studio handoff matches the backend exploration contract', () => {
  const client = readFileSync(join(__dirname, '../../mobile/src/lib/nextMove.ts'), 'utf8');
  assert.ok(client.includes(EXPLORATION_PREFIX));
  assert.equal(isExploration(`${EXPLORATION_PREFIX}\n\nOption A: log my exercise`), true);
  assert.equal(isExploration('Log my exercise'), false);
  assert.equal(isExploration(`Explain what ${EXPLORATION_PREFIX} means`), false);
  assert.equal(isExploration(null), false);
});

test('real chat route cannot execute or propose actions in an exploration, even if reasoning returns one', async () => {
  const express = require('express');
  const request = require('supertest');
  const modules = ['../src/chat/ask', '../src/chat/executeAction', '../src/store/chat', '../src/routes/chat'];
  const saved = new Map(modules.map(p => { const id = require.resolve(p); return [id, require.cache[id]]; }));
  let executions = 0;
  let storedQuestion;
  function stub(p, exports) { const id = require.resolve(p); require.cache[id] = { id, filename: id, loaded: true, exports }; }
  try {
    stub('../src/chat/ask', { ask: async () => ({ answer: 'Compare the options.', actions: [{ action: 'log_habit', habit: 'exercise' }] }), validateAction: () => null });
    stub('../src/chat/executeAction', { executeAction: async () => { executions++; return { done: true }; } });
    stub('../src/store/chat', { recentMessages: async () => [], saveTurn: async ({ question }) => { storedQuestion = question; return { conversationId: 1 }; } });
    delete require.cache[require.resolve('../src/routes/chat')];
    const { createChatRouter } = require('../src/routes/chat');
    const app = express(); app.use(express.json()); app.use(createChatRouter());
    const question = `${EXPLORATION_PREFIX}\n\nOption A: log my exercise`;
    const result = await request(app).post('/chat').send({ question });
    assert.equal(result.status, 200);
    assert.equal(executions, 0);
    assert.deepEqual(result.body.actions, []);
    assert.deepEqual(result.body.askResponse.proposedActions, []);
    assert.equal(storedQuestion, question, 'history retains the hypothetical label');
    const ordinary = await request(app).post('/chat').send({ question: 'Log my exercise' });
    assert.equal(ordinary.status, 200);
    assert.equal(executions, 1, 'ordinary explicit commands retain existing behavior');
  } finally {
    for (const [id, prior] of saved) { if (prior) require.cache[id] = prior; else delete require.cache[id]; }
  }
});
