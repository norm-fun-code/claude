// Chat router: the typed Ask thread — question/answer, persisted history,
// saved conversations (list/open/delete/rename), self-experiment extraction,
// and the one-time embedding backfill. Seventeenth router extraction out of
// server.js's monolith (see the engineering review's #1+#6 recommendation)
// — a straight move, verified line-by-line against the original before
// removing it from server.js.
const express = require('express');
const llm = require('../llm');
const { ask } = require('../chat/ask');
const { executeAction } = require('../chat/executeAction');
const { asyncHandler } = require('../middleware/asyncHandler');

function createChatRouter() {
  const router = express.Router();

  // Life chat — ask questions across your data + library.
  router.post('/chat', asyncHandler(async (req, res) => {
    const { question, history } = req.body || {};
    const chatStore = require('../store/chat');

    // Persistent memory: if the client doesn't supply history, load the recent
    // conversation tail from the DB so threads survive app restarts. A client
    // that sends its own history (back-compat) overrides this.
    let priorHistory = Array.isArray(history) ? history : [];
    if (!priorHistory.length) {
      try {
        const rows = await chatStore.recentMessages({ limit: 20 });
        priorHistory = rows.map((m) => ({ role: m.role, content: m.content }));
      } catch (e) {
        console.error('[chat memory] load failed:', e.message);
      }
    }

    const result = await ask(question, { history: priorHistory });

    // The chief of staff DOES things: if the answer emitted inline action(s)
    // (natural language — "I switched to a walk", "log my cold shower", or a day
    // recap that also gives tomorrow's context), execute them now. The prose
    // already acknowledged them; this makes them real.
    const executedList = [];
    for (const a of (result.actions ?? (result.action ? [result.action] : []))) {
      executedList.push(await executeAction(a));
    }
    const executed = executedList.find(Boolean) ?? null;

    // Append this turn so the next question remembers it. Pre-resolve the active
    // thread once (the two saves run concurrently, so this avoids both racing to
    // create it). Store the question embedding for long-term semantic recall.
    const convId = await chatStore.ensureActiveConversation();
    chatStore.saveMessage({ role: 'user', content: question, embedding: result.questionEmbedding ?? null, conversationId: convId })
      .catch((e) => console.error('[chat memory] save user failed:', e.message));
    chatStore.saveMessage({ role: 'assistant', content: result.answer, sources: result.sources ?? [], conversationId: convId })
      .catch((e) => console.error('[chat memory] save assistant failed:', e.message));

    // Don't leak the raw embedding vector or the internal parsed actions to the
    // client; surface executed-action summaries instead. `action` stays for
    // back-compat (the first executed); `actions` is the full list.
    const { questionEmbedding, action: _parsed, actions: _parsedActions, ...clientResult } = result;
    res.json({ ...clientResult, action: executed, actions: executedList.filter(Boolean) });
  }));

  // Read the persisted conversation (for the app to render prior turns on open).
  router.get('/chat/history', asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await require('../store/chat').recentMessages({ limit });
    res.json({ messages: rows });
  }));

  // Discard the active thread without saving ("Clear").
  router.post('/chat/clear', asyncHandler(async (req, res) => {
    const removed = await require('../store/chat').clearActiveConversation();
    res.json({ ok: true, removed });
  }));

  // Save (archive) the active thread, then start fresh. Optional { title }.
  router.post('/chat/save', asyncHandler(async (req, res) => {
    const { title = null } = req.body || {};
    const saved = await require('../store/chat').saveActiveConversation({ title });
    res.json({ ok: true, conversation: saved });
  }));

  // Extract a self-experiment from a chat conversation using Claude.
  router.post('/chat/extract-experiment', asyncHandler(async (req, res) => {
    const { messages = [] } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'messages required' });
    }

    const METRICS = [
      { key: 'health:hrv', label: 'HRV (ms)' },
      { key: 'health:sleep_hours', label: 'Sleep duration (hours)' },
      { key: 'health:sleep_score', label: 'Sleep score (0-100)' },
      { key: 'health:resting_hr', label: 'Resting heart rate (bpm)' },
      { key: 'habits:cold_shower', label: 'Cold shower (yes/no daily)' },
      { key: 'habits:exercise', label: 'Exercise (yes/no daily)' },
      { key: 'habits:eat_healthy', label: 'Eating healthy (1-5 daily score)' },
      { key: 'wellbeing:mood', label: 'Mood (1-10)' },
      { key: 'wellbeing:energy', label: 'Energy (1-10)' },
      { key: 'wellbeing:focus', label: 'Focus (1-10)' },
    ];

    const transcript = messages
      .slice(-20)
      .map((m) => `${m.role === 'user' ? 'User' : 'NormOS'}: ${m.content}`)
      .join('\n\n');

    const metricsList = METRICS.map((m) => `  - ${m.key}: ${m.label}`).join('\n');

    const prompt = `Extract ONE concrete self-experiment from this conversation.

CONVERSATION:
${transcript}

TRACKABLE METRICS (use only these exact keys):
${metricsList}

Return ONLY valid JSON — no markdown, no explanation.

If an experiment is extractable:
{"hypothesis":"...","metric":"health:hrv","lever":"...","expected":"up","protocol":"...","testDays":14}

If the conversation has no clear experimental idea to track:
{"notActionable":true,"reason":"..."}

Rules:
- expected must be "up" or "down"
- testDays must be 14, 21, or 28
- metric must be one of the keys above
- hypothesis should be one clear sentence`;

    const raw = await llm.generateText({
      system: 'You extract self-experiments from conversations. Return only valid JSON.',
      prompt,
      maxTokens: 400,
    });

    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'parse failed', raw: cleaned.slice(0, 300) });
    }

    if (!result.notActionable) {
      const validKeys = METRICS.map((m) => m.key);
      if (!validKeys.includes(result.metric)) result.metric = 'wellbeing:energy';
      if (result.expected !== 'down') result.expected = 'up';
      if (![14, 21, 28].includes(Number(result.testDays))) result.testDays = 14;
      else result.testDays = Number(result.testDays);
    }

    res.json(result);
  }));

  // List saved conversations for the sidebar.
  router.get('/chat/conversations', asyncHandler(async (req, res) => {
    res.json({ conversations: await require('../store/chat').listConversations() });
  }));

  // Resume a saved conversation (make it the live thread); returns its messages.
  router.post('/chat/conversations/:id/open', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const messages = await require('../store/chat').openConversation(id);
    res.json({ ok: true, messages });
  }));

  // Delete a saved conversation and its messages.
  router.delete('/chat/conversations/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const removed = await require('../store/chat').deleteConversation(id);
    res.json({ ok: true, removed });
  }));

  // Rename a saved conversation.
  router.patch('/chat/conversations/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const { title } = req.body || {};
    if (typeof title !== 'string') return res.status(400).json({ error: 'title required' });
    const updated = await require('../store/chat').updateConversationTitle(id, title);
    res.json({ ok: true, updated });
  }));

  // One-time backfill: embed any past user questions saved before long-term recall
  // existed, so they become semantically retrievable. Safe to re-run (idempotent).
  router.post('/chat/reindex', asyncHandler(async (req, res) => {
    const chatStore = require('../store/chat');
    const pending = await chatStore.unembeddedQuestions({ limit: 500 });
    let embedded = 0;
    // Embed in small batches to respect provider limits.
    for (let i = 0; i < pending.length; i += 32) {
      const batch = pending.slice(i, i + 32);
      const vecs = await llm.embed(batch.map((m) => m.content)).catch(() => []);
      for (let j = 0; j < batch.length; j++) {
        if (vecs[j]) { await chatStore.setEmbedding(batch[j].id, vecs[j]); embedded++; }
      }
    }
    res.json({ ok: true, pending: pending.length, embedded });
  }));

  return router;
}

module.exports = { createChatRouter };
