// Voice router: push-to-talk chief-of-staff (audio in -> transcript ->
// optional action -> Ask brain -> spoken answer out) and standalone
// speech-to-text. Eighteenth router extraction out of server.js's monolith
// (see the engineering review's #1+#6 recommendation) — a straight move,
// verified line-by-line against the original before removing it from
// server.js.
const express = require('express');
const voiceService = require('../services/voice');
const { ask, looksLikeCommand } = require('../chat/ask');
const { executeAction } = require('../chat/executeAction');
const { asyncHandler } = require('../middleware/asyncHandler');

function createVoiceRouter() {
  const router = express.Router();

  // Push-to-talk: audio in → transcript → (optional action) → Ask brain →
  // spoken answer out. Persists to the same chat thread as typed Ask.
  router.post('/voice/ask', asyncHandler(async (req, res) => {
    // Per-stage timing so a "this felt slow" report can be diagnosed from the
    // logs instead of guessed at — the fast-command-model work only sped up the
    // LLM stage; STT and TTS are each a separate full network round trip to
    // Gemini and were never specifically profiled until now.
    const t0 = Date.now();
    const marks = {};
    const mark = (label) => { marks[label] = Date.now() - t0; };
    const { audio, mime } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'audio (base64) is required' });

    const chatStore = require('../store/chat');
    // History doesn't depend on the transcript, so fetch it in parallel with
    // STT instead of after it — one fewer round trip on the critical path.
    const [question, historyRows] = await Promise.all([
      voiceService.transcribe(String(audio), mime || 'audio/wav'),
      chatStore.recentMessages({ limit: 20 }).catch(() => []),
    ]);
    mark('sttMs');
    if (!question) return res.status(422).json({ error: 'no_speech', message: "Couldn't hear anything in that." });

    // One brain call: ask() both answers AND decides any action inline (no
    // separate routing round-trip — that was the main latency cost). voice:true
    // asks the model for a short, spoken-style answer directly — faster to
    // generate AND faster to synthesize than truncating a chat-length answer
    // after the fact.
    const result = await ask(question, {
      history: historyRows.map((m) => ({ role: m.role, content: m.content })),
      voice: true,
    });
    mark('llmMs');
    const executedList = [];
    for (const a of (result.actions ?? (result.action ? [result.action] : []))) {
      executedList.push(await executeAction(a));
    }
    const executed = executedList.find(Boolean) ?? null;
    mark('actionMs');

    // Persist to the shared thread (same as the typed /api/chat path).
    const convId = await chatStore.ensureActiveConversation();
    chatStore.saveMessage({ role: 'user', content: question, embedding: result.questionEmbedding ?? null, conversationId: convId })
      .catch((e) => console.error('[voice chat] save user failed:', e.message));
    chatStore.saveMessage({ role: 'assistant', content: result.answer, sources: result.sources ?? [], conversationId: convId })
      .catch((e) => console.error('[voice chat] save assistant failed:', e.message));

    // Speak the answer (trimmed as a safety cap; full text still returned).
    let audioOut = null;
    try {
      const spoken = voiceService.speakable(result.answer).slice(0, 900);
      const t = await voiceService.synthesize(spoken);
      audioOut = { data: t.audio.toString('base64'), mime: t.mime };
    } catch (err) {
      console.error('[voice tts] failed (returning text only):', err.message);
    }
    mark('ttsMs');

    console.log(
      `[voice/ask timing] total=${Date.now() - t0}ms stt=${marks.sttMs}ms ` +
      `llm=${marks.llmMs - marks.sttMs}ms action=${marks.actionMs - marks.llmMs}ms ` +
      `tts=${marks.ttsMs - marks.actionMs}ms (fast=${looksLikeCommand(question)})`
    );

    res.json({
      question,
      answer: result.answer,
      action: executed,
      actions: executedList.filter(Boolean),
      audio: audioOut?.data ?? null,
      audioMime: audioOut?.mime ?? null,
    });
  }));

  // Speech-to-text only, no ask()/TTS round trip — for voice INPUT into an
  // existing text flow (e.g. answering the brief's one question by voice)
  // rather than a full voice conversation turn.
  router.post('/voice/transcribe', asyncHandler(async (req, res) => {
    const { audio, mime } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'audio (base64) is required' });
    const text = await voiceService.transcribe(String(audio), mime || 'audio/wav');
    res.json({ text });
  }));

  return router;
}

module.exports = { createVoiceRouter };
