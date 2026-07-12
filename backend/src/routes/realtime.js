// Talk to NormOS: the server-side half of the OpenAI Realtime voice mode.
// The mobile client connects DIRECTLY to OpenAI over WebRTC using the
// ephemeral secret minted here — this router never sees or proxies live
// audio. Its jobs: (1) mint a scoped session with a compact personal-context
// system prompt and the tool allowlist baked in, (2) execute a tool call the
// client relayed from its own data channel (the only place a function-call
// event can be received, since the WebRTC connection is client<->OpenAI
// directly), (3) persist completed turns to the same shared Ask thread every
// other surface uses, (4) log latency/usage events — never raw audio.
const express = require('express');
const crypto = require('crypto');
const realtimeService = require('../services/realtime');
const { TOOL_SCHEMAS, TOOL_NAMES, runTool } = require('../chat/realtimeTools');
const realtimeMetrics = require('../store/realtimeMetrics');
const { asyncHandler } = require('../middleware/asyncHandler');

const PERSONA = process.env.REALTIME_PERSONA_STYLE ||
  'You are NormOS, this person\'s trusted personal chief of staff — present, warm, grounded, optimistic, and genuinely curious about their life. ' +
  'This is a LIVE SPOKEN conversation, not a chat transcript: keep answers to 1-3 short sentences by default, and only go deeper when they ask for more. ' +
  'Never use Markdown, bullet points, headers, or any formatting meant for reading — everything you say is heard, not read. ' +
  'Remember what was said earlier in this session and refer back to it naturally. ' +
  'Never claim you did something (logged a habit, set a reminder, swapped a workout) until the tool call actually returns success — if a tool fails, say so plainly. ' +
  'For a clear statement of fact or intent ("I did my cold shower", "swap me to a walk today"), restate what you\'re about to do in one short sentence, then call execute_normos_action. For a genuine question about their data, prefer the fast get_* tools first; only reach for deep_ask when the question needs real retrieval or cross-domain reasoning, and when you do, say something natural first ("let me look across your history…") so there\'s never dead silence.';

/** Compact personal-context package — durable facts + today's snapshot only.
 *  Deliberately NOT the full Ask prompt: additional detail comes from tools,
 *  called live, so a stale session-start snapshot never substitutes for a
 *  fresh lookup. Every read is fail-soft — a missing piece just narrows
 *  context, never blocks the session from starting. */
async function buildContextPackage() {
  const [selfModel, briefing, chapters, commitments, intention, recovery] = await Promise.all([
    require('../store/selfModel').latestModelText().catch(() => null),
    require('../store/briefings').latestBriefing('daily').catch(() => null),
    require('../store/lifeChapters').listActive().catch(() => []),
    require('../store/commitments').listActive({ limit: 5 }).catch(() => []),
    require('../store/intentions').currentIntention().catch(() => null),
    require('../intelligence/recovery').liveRecovery().catch(() => null),
  ]);

  const parts = [];
  if (selfModel) parts.push(selfModel.slice(0, 2000));
  const cb = briefing?.content?.chiefBrief;
  if (cb?.synthesis) parts.push(`TODAY: ${cb.synthesis}`);
  if (cb?.action) parts.push(`Today's move: ${cb.action}`);
  const chapterText = require('../intelligence/chapters').composeChapterContext(chapters);
  if (chapterText) parts.push(`LIFE CHAPTERS:\n${chapterText}`);
  if (intention?.context) parts.push(`This week's focus: ${String(intention.context).slice(0, 300)}`);
  if (commitments.length) {
    parts.push(`OPEN COMMITMENTS: ${commitments.map((c) => c.title).slice(0, 5).join('; ')}`);
  }
  if (recovery?.band) parts.push(`Current recovery: ${recovery.band}${recovery.score != null ? ` (${recovery.score})` : ''}`);

  return parts.join('\n\n');
}

function createRealtimeRouter() {
  const router = express.Router();

  // Mint a scoped Realtime session. Returns the ephemeral client secret (NOT
  // the permanent OPENAI_API_KEY) plus a sessionId for correlating this
  // session's later /tool, /turn, and /metric calls.
  router.post('/voice/realtime/session', asyncHandler(async (req, res) => {
    if (process.env.VOICE_REALTIME_ENABLED === 'false') {
      return res.status(503).json({ error: 'realtime_disabled', fallback: true });
    }
    if (!realtimeService.isConfigured()) {
      return res.status(503).json({ error: 'openai_not_configured', fallback: true });
    }

    const context = await buildContextPackage();
    const instructions = context ? `${PERSONA}\n\nWHAT YOU KNOW ABOUT THIS PERSON RIGHT NOW:\n${context}` : PERSONA;

    let session;
    try {
      session = await realtimeService.createEphemeralSession({ instructions, tools: TOOL_SCHEMAS });
    } catch (err) {
      const reason = err.reason || 'session_mint_failed';
      // Full diagnostic detail server-side only (stage, HTTP status from
      // OpenAI, sanitized provider error) — the client only ever gets the
      // stable reason CODE, never this detail, and never the key.
      console.error(
        `[realtime session] mint failed: reason=${reason} providerStatus=${err.providerStatus ?? 'n/a'} ` +
        `providerCode=${err.providerCode ?? 'n/a'} providerType=${err.providerType ?? 'n/a'} message=${err.message}`
      );
      return res.status(502).json({ error: reason, fallback: true });
    }

    const sessionId = crypto.randomUUID();
    res.json({
      sessionId,
      clientSecret: session.clientSecret,
      expiresAt: session.expiresAt,
      model: session.model,
      voice: session.voice,
    });
  }));

  // Relay point for a function-call event the mobile client received on its
  // OWN data channel (the WebRTC connection is client<->OpenAI directly, so
  // this backend never sees the call arrive — the client posts it here,
  // gets the result, and sends it back to OpenAI over that same channel).
  router.post('/voice/realtime/tool', asyncHandler(async (req, res) => {
    const { sessionId, name, arguments: args } = req.body || {};
    if (!sessionId || !name) return res.status(400).json({ error: 'sessionId and name required' });
    if (!TOOL_NAMES.has(name)) return res.status(400).json({ error: `unknown tool: ${name}` });

    const t0 = Date.now();
    try {
      const result = await runTool(name, args || {});
      const valueMs = Date.now() - t0;
      // Awaited (not fire-and-forget): logEvent is itself fail-soft (never
      // throws), and the insert is a single fast round trip — awaiting it
      // means a caller polling right after this response sees the row,
      // rather than racing an in-flight write.
      await realtimeMetrics.logEvent({
        sessionId, type: name === 'deep_ask' ? 'deep_ask' : 'fast_path', valueMs, meta: { tool: name },
      });
      res.json({ result });
    } catch (err) {
      console.error(`[realtime tool:${name}] failed:`, err.message);
      await realtimeMetrics.logEvent({ sessionId, type: 'error', meta: { tool: name, message: err.message } });
      res.status(500).json({ error: 'tool_failed', message: err.message });
    }
  }));

  // Persist a completed turn to the SAME shared Ask conversation every other
  // surface writes to. Only for turns the CLIENT resolved itself (a fast-path
  // tool call + the model's own spoken answer, or a plain conversational
  // turn with no tool at all) — a deep_ask turn already persists itself
  // (chat/realtimeTools.js's deepAsk), so the client must not call this for
  // those or the turn would be saved twice.
  router.post('/voice/realtime/turn', asyncHandler(async (req, res) => {
    const { question, answer } = req.body || {};
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
    const chatStore = require('../store/chat');
    const convId = await chatStore.ensureActiveConversation();
    await Promise.all([
      chatStore.saveMessage({ role: 'user', content: String(question).slice(0, 4000), conversationId: convId }),
      chatStore.saveMessage({ role: 'assistant', content: String(answer).slice(0, 4000), conversationId: convId }),
    ]);
    res.json({ ok: true });
  }));

  // Client-observed timing events that only the client can measure (session
  // connect time, speech-end-to-first-audio latency, whether a barge-in
  // interruption actually landed, transport errors/reconnects). Never
  // includes audio — value_ms + small metadata only.
  router.post('/voice/realtime/metric', asyncHandler(async (req, res) => {
    const { sessionId, type, valueMs, meta } = req.body || {};
    if (!sessionId || !type) return res.status(400).json({ error: 'sessionId and type required' });
    const ALLOWED = new Set(['connect', 'first_audio', 'interruption', 'error', 'reconnect']);
    if (!ALLOWED.has(type)) return res.status(400).json({ error: `unknown metric type: ${type}` });
    await realtimeMetrics.logEvent({ sessionId, type, valueMs, meta });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createRealtimeRouter, buildContextPackage, PERSONA };
