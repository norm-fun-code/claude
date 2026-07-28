// Chat router: the typed Ask thread — question/answer, persisted history,
// saved conversations (list/open/delete/rename), self-experiment extraction,
// and the one-time embedding backfill. Seventeenth router extraction out of
// server.js's monolith (see the engineering review's #1+#6 recommendation)
// — a straight move, verified line-by-line against the original before
// removing it from server.js.
const express = require('express');
const llm = require('../llm');
const { ask, validateAction } = require('../chat/ask');
const { executeAction } = require('../chat/executeAction');
const { needsConfirmation } = require('../chat/actionPolicy');
const { buildAskResponse, currentSnapshotMeta } = require('../chat/askResponse');
const { asyncHandler } = require('../middleware/asyncHandler');
const { parseAndValidate } = require('../llm/parseJson');

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
    // recap that also gives tomorrow's context), execute them now — UNLESS the
    // action is meaningful/cross-surface-visible enough to need an explicit
    // confirm step first (chat/actionPolicy.js's per-action consent rule; see
    // POST /chat/confirm-action below). The prose already acknowledged
    // immediate ones; this makes them real.
    const actionResults = [];
    for (const a of (result.actions ?? (result.action ? [result.action] : []))) {
      if (needsConfirmation(a)) {
        actionResults.push({ action: a, executed: false, result: null });
      } else {
        actionResults.push({ action: a, executed: true, result: await executeAction(a) });
      }
    }
    const executedList = actionResults.filter((r) => r.executed).map((r) => r.result);
    const executed = executedList.find(Boolean) ?? null;

    // Append this turn so the next question remembers it. Pre-resolve the active
    // thread once (the two saves run concurrently, so this avoids both racing to
    // create it). Store the question embedding for long-term semantic recall.
    const convId = await chatStore.ensureActiveConversation();
    chatStore.saveMessage({ role: 'user', content: question, embedding: result.questionEmbedding ?? null, conversationId: convId })
      .catch((e) => console.error('[chat memory] save user failed:', e.message));
    chatStore.saveMessage({ role: 'assistant', content: result.answer, sources: result.sources ?? [], conversationId: convId })
      .catch((e) => console.error('[chat memory] save assistant failed:', e.message));

    // The structured AskResponse contract (intent, evidence w/ source+
    // confidence, uncertainties, action previews) — a pure projection of what
    // ask() already computed, see chat/askResponse.js. Additive: existing
    // fields (answer/sources/action/actions) are unchanged for back-compat.
    const askResponse = buildAskResponse({
      question, answer: result.answer, actionResults, claims: result.claims,
      conversationId: convId, ...currentSnapshotMeta(),
      isCommand: !!result.isCommand, debugEvidence: result.debugEvidence,
    });

    // Don't leak the raw embedding vector, the internal parsed actions, the
    // EvidenceClaim debug field, or the raw claims packet to the client —
    // askResponse above already curates the user-facing evidence/uncertainty
    // view of them. `action`/`actions` stay for back-compat (executed only).
    const { questionEmbedding, action: _parsed, actions: _parsedActions, debugEvidence: _debugEvidence, claims: _claims, isCommand: _isCommand, ...clientResult } = result;
    res.json({ ...clientResult, action: executed, actions: executedList.filter(Boolean), askResponse });
  }));

  // Execute a previously-proposed action that required explicit confirmation
  // (chat/actionPolicy.js's CONFIRM_REQUIRED_ACTIONS — e.g. a workout swap).
  // Re-validates the payload against the SAME strict allowlist ask() itself
  // uses (never trusts the client's shape), then runs it through the SAME
  // executeAction() every other action path uses, so a confirmed action gets
  // identical writes/invalidation to an immediately-executed one. Idempotent:
  // the underlying store writes (setWorkoutOverride, createOrReplace) are
  // already no-op-safe on a repeat call, so a double-tap can't double-apply.
  router.post('/chat/confirm-action', asyncHandler(async (req, res) => {
    const { action } = req.body || {};
    const validated = validateAction(action);
    if (!validated) return res.status(400).json({ error: 'invalid_action', message: 'That action is no longer valid — ask again to get a fresh preview.' });
    const result = await executeAction(validated);
    if (!result?.done) {
      return res.status(422).json({ ok: false, error: 'execution_failed', message: result?.description || 'Could not complete that action.' });
    }
    res.json({ ok: true, result, ...currentSnapshotMeta() });
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
      jsonMode: true,
    });

    const result = parseAndValidate(raw, {
      label: 'extract-experiment',
      validate: (parsed) => {
        if (!parsed.notActionable) {
          const validKeys = METRICS.map((m) => m.key);
          if (!validKeys.includes(parsed.metric)) parsed.metric = 'wellbeing:energy';
          if (parsed.expected !== 'down') parsed.expected = 'up';
          if (![14, 21, 28].includes(Number(parsed.testDays))) parsed.testDays = 14;
          else parsed.testDays = Number(parsed.testDays);
        }
        return parsed;
      },
    });
    if (!result) return res.status(500).json({ error: 'parse failed' });

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
