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
const { needsConfirmation } = require('../chat/actionPolicy');
const { buildAskResponse, currentSnapshotMeta } = require('../chat/askResponse');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireFields } = require('../middleware/validate');
const { classifyTranscript } = require('../chat/transcriptQuality');
const { resolveSelection, describeSelection } = require('../chat/voiceContext');
const voiceIdempotency = require('../chat/voiceIdempotency');
const realtimeMetrics = require('../store/realtimeMetrics');

function createVoiceRouter() {
  const router = express.Router();

  // Push-to-talk: audio in → transcript → (optional action) → Ask brain →
  // spoken answer out. Persists to the same chat thread as typed Ask.
  //
  // Also accepts the unified voice-session contract's fields (activeTab,
  // selection, localDateTime, sessionId, language) — same shape Realtime's
  // session mint takes — so a push-to-talk turn is bound to the same
  // canonical selection/local-time as a Realtime one, and both surfaces log
  // to the SAME realtimeMetrics ledger under `surface`.
  router.post('/voice/ask', asyncHandler(async (req, res) => {
    // Per-stage timing so a "this felt slow" report can be diagnosed from the
    // logs instead of guessed at — the fast-command-model work only sped up the
    // LLM stage; STT and TTS are each a separate full network round trip to
    // Gemini and were never specifically profiled until now.
    const t0 = Date.now();
    const marks = {};
    const mark = (label) => { marks[label] = Date.now() - t0; };
    const { audio, mime, activeTab, selection, localDateTime, sessionId, language, turnId } = req.body || {};
    if (!requireFields(req.body, ['audio'], res)) return;

    const localNow = typeof localDateTime === 'string' ? new Date(localDateTime) : new Date();
    const now = Number.isNaN(localNow.getTime()) ? new Date() : localNow;

    const chatStore = require('../store/chat');
    // History doesn't depend on the transcript, so fetch it in parallel with
    // STT instead of after it — one fewer round trip on the critical path.
    const [question, historyRows] = await Promise.all([
      voiceService.transcribe(String(audio), mime || 'audio/wav'),
      chatStore.recentMessages({ limit: 20 }).catch(() => []),
    ]);
    mark('sttMs');
    if (!question) return res.status(422).json({ error: 'no_speech', message: "Couldn't hear anything in that." });

    // Transcript-quality guard: the mirror of Realtime's client-side
    // transcriptGuard.ts — push-to-talk's transcript DOES pass through this
    // backend, so it gets its own instance of the same phantom/noise
    // heuristic instead of trusting any non-empty STT output verbatim
    // (previously the ONLY signal here was empty-string).
    const quality = classifyTranscript(question, { language: language || 'en' });
    if (!quality.accepted) {
      if (sessionId) await realtimeMetrics.logEvent({ sessionId, type: 'error', meta: { surface: 'push_to_talk', reason: quality.reason } }).catch(() => {});
      return res.status(422).json({ error: 'no_speech', reason: quality.reason, message: "Couldn't hear anything clear in that." });
    }

    // Bind "this"/"that" to a stable, server-resolved canonical fact — never
    // to the words the user said. Delivered as a prefixed context note
    // (rather than a separate structured field) so it flows through ask()
    // unchanged; the note itself is built entirely from canonical selectors
    // (chat/voiceContext.js), never from client-supplied text.
    const resolvedSelection = await resolveSelection(selection).catch(() => ({ found: false, summary: null }));
    const selectionNote = describeSelection(resolvedSelection);
    const questionForAsk = selectionNote ? `[Context: the user is viewing ${selectionNote}] ${question}` : question;

    // One brain call: ask() both answers AND decides any action inline (no
    // separate routing round-trip — that was the main latency cost). voice:true
    // asks the model for a short, spoken-style answer directly — faster to
    // generate AND faster to synthesize than truncating a chat-length answer
    // after the fact.
    const result = await ask(questionForAsk, {
      history: historyRows.map((m) => ({ role: m.role, content: m.content })),
      voice: true,
    });
    mark('llmMs');
    // Same per-action consent policy as typed Ask (chat/actionPolicy.js): a
    // meaningful, cross-surface-visible action (workout swap, life chapter)
    // is proposed but not executed here — the mobile client shows a confirm
    // card and calls POST /api/chat/confirm-action, the SAME endpoint the
    // typed flow uses, so voice and text can never diverge on which actions
    // need a tap-to-confirm.
    //
    // Idempotency: keyed by (sessionId, turnId, action) so a client retry of
    // this whole request (e.g. after a timeout) can never double-execute a
    // non-confirm-gated action.
    const actionResults = [];
    for (const a of (result.actions ?? (result.action ? [result.action] : []))) {
      if (needsConfirmation(a)) {
        actionResults.push({ action: a, executed: false, result: null });
      } else {
        const key = voiceIdempotency.keyFor({ sessionId, turnId, action: a.action, argsHash: voiceIdempotency.hashArgs(a) });
        const { result: execResult, fromCache } = await voiceIdempotency.once(key, () => executeAction(a, { now }));
        if (fromCache) console.warn(`[voice/ask] duplicate action call for key=${key} — returning cached result`);
        actionResults.push({ action: a, executed: true, result: execResult });
      }
    }
    const executedList = actionResults.filter((r) => r.executed).map((r) => r.result);
    const executed = executedList.find(Boolean) ?? null;
    mark('actionMs');

    // Persist to the shared thread (same as the typed /api/chat path).
    const convId = await chatStore.ensureActiveConversation();
    chatStore.saveMessage({ role: 'user', content: question, embedding: result.questionEmbedding ?? null, conversationId: convId })
      .catch((e) => console.error('[voice chat] save user failed:', e.message));
    chatStore.saveMessage({ role: 'assistant', content: result.answer, sources: result.sources ?? [], conversationId: convId })
      .catch((e) => console.error('[voice chat] save assistant failed:', e.message));

    const askResponse = buildAskResponse({
      question, answer: result.answer, actionResults, claims: result.claims,
      conversationId: convId, ...currentSnapshotMeta(),
      isCommand: !!result.isCommand, debugEvidence: result.debugEvidence,
    });

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

    const timing = {
      totalMs: Date.now() - t0,
      sttMs: marks.sttMs,
      llmMs: marks.llmMs - marks.sttMs,
      actionMs: marks.actionMs - marks.llmMs,
      ttsMs: marks.ttsMs - marks.actionMs,
      fast: looksLikeCommand(question),
    };
    console.log(
      `[voice/ask timing] total=${timing.totalMs}ms stt=${timing.sttMs}ms ` +
      `llm=${timing.llmMs}ms action=${timing.actionMs}ms ` +
      `tts=${timing.ttsMs}ms (fast=${timing.fast}${result.fastPathError ? ', fastPathError=' + result.fastPathError : ''})`
    );
    // Unify with Realtime's latency ledger — same table, `surface` in meta
    // distinguishes push-to-talk from Realtime turns, so total/tool-exec
    // latency is comparable across both surfaces instead of living in two
    // disconnected instrumentation schemes (this console.log + Realtime's
    // DB-backed events).
    if (sessionId) {
      realtimeMetrics.logEvent({
        sessionId, type: 'turn_total', valueMs: timing.totalMs,
        meta: { surface: 'push_to_talk', activeTab: activeTab || null, fast: timing.fast, sttMs: timing.sttMs, llmMs: timing.llmMs, actionMs: timing.actionMs, ttsMs: timing.ttsMs },
      }).catch(() => {});
    }

    // timing + fastPathError ride along on the response so a "this felt slow"
    // or "this didn't work" report is diagnosable from the client alone — no
    // server log access needed. fastPathError is only present when the quick
    // command model threw and ask() silently fell back to the slower full
    // reasoning path (see ask.js); it explains latency that timing.fast=true
    // wouldn't otherwise account for.
    res.json({
      question,
      answer: result.answer,
      action: executed,
      actions: executedList.filter(Boolean),
      askResponse,
      audio: audioOut?.data ?? null,
      audioMime: audioOut?.mime ?? null,
      timing,
      ...(result.fastPathError ? { fastPathError: result.fastPathError } : {}),
    });
  }));

  // Speech-to-text only, no ask()/TTS round trip — for voice INPUT into an
  // existing text flow (e.g. answering the brief's one question by voice)
  // rather than a full voice conversation turn.
  router.post('/voice/transcribe', asyncHandler(async (req, res) => {
    const { audio, mime } = req.body || {};
    if (!requireFields(req.body, ['audio'], res)) return;
    const text = await voiceService.transcribe(String(audio), mime || 'audio/wav');
    res.json({ text });
  }));

  return router;
}

module.exports = { createVoiceRouter };
