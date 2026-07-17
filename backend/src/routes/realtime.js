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
  'For a clear statement of fact or intent ("I did my cold shower", "swap me to a walk today"), restate what you\'re about to do in one short sentence, then call execute_normos_action. For a genuine question about their data, prefer the fast get_* tools first; only reach for deep_ask when the question needs real retrieval or cross-domain reasoning, and when you do, say something natural first ("let me look across your history…") so there\'s never dead silence. ' +
  'If the person rephrases or repeats themselves right after you already confirmed an action succeeded (a self-correction, a pause, background noise mistaken for a new turn), that is almost always the SAME instruction, not a second one — do not call execute_normos_action again for it. Only call it again if they clearly ask for something additional or different (a different time, a different task).';

/**
 * Purpose-built Realtime context package, split into DURABLE (timeless facts
 * about the person) and CURRENT (dated) sections. This deliberately replaces
 * the old `selfModel.slice(0, 2000)` blob: the self-model text mixes durable
 * facts with DATED journal entries and annotations, so an arbitrary 2,000-char
 * cut under a "…RIGHT NOW" header let the model narrate something logged days
 * ago as if it happened last night (the same class of error we fixed in
 * Cross-Domain Patterns, but through live voice). Every episodic item here
 * carries its own local calendar date, and nothing outside the CURRENT section
 * may be spoken of as "today". Additional history stays reachable via the live
 * get_ and deep_ask tools (Ask's historical access is unchanged) — this only
 * governs what may be ASSERTED as current state at session start.
 *
 * Every read is fail-soft: a missing store just narrows the package, never
 * blocks the session from minting.
 *
 * @returns {{ durable: string, current: string, today: string, yesterday: string }}
 */
async function buildContextPackage({ now = new Date() } = {}) {
  const tz = process.env.TZ || 'America/New_York';
  const today = now.toLocaleDateString('en-CA', { timeZone: tz });
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: tz });

  const [beliefs, goals, chapters, commitments, intention, briefing, recovery, recentJournal] = await Promise.all([
    require('../store/beliefs').listActive({ limit: 12 }).catch(() => []),
    require('../store/goals').listGoals({ status: 'active' }).catch(() => []),
    require('../store/lifeChapters').listActive().catch(() => []),
    require('../store/commitments').listActive({ limit: 5 }).catch(() => []),
    require('../store/intentions').currentIntention().catch(() => null),
    require('../store/briefings').latestBriefing('daily').catch(() => null),
    require('../intelligence/recovery').liveRecovery().catch(() => null),
    // Only the last ~2 days, and only surfaced with an explicit today/yesterday
    // label below — never as undated "current" context.
    require('../store/dayJournal').recent({ days: 2, limit: 4 }).catch(() => []),
  ]);

  // The canonical effective workout — the SAME selector the Health tab, the
  // brief, and the live get_today_context tool read, so session-start context
  // can never narrate a plan the rest of the app has already downgraded or
  // overridden. Passed the band we already have so it doesn't re-fetch recovery.
  const effectiveWorkout = await require('../services/workout')
    .getEffectiveWorkout({ asOf: now, tz, band: recovery?.band ?? null })
    .catch(() => null);

  // ── DURABLE — ongoing truths about the person. Safe to state naturally, but
  //    never with a time word ("today"/"currently").
  const durable = [];
  if (beliefs.length) {
    durable.push('DURABLE FACTS & PREFERENCES (ongoing — state these plainly, never as "today"):\n' +
      beliefs.slice(0, 8).map((b) => {
        const prov = b.evidence?.source || b.kind || null; // provenance
        return `- ${b.statement}${prov ? ` [${prov}]` : ''}`;
      }).join('\n'));
  }
  if (goals.length) {
    durable.push('ACTIVE LONG-TERM GOALS:\n' + goals.slice(0, 6).map((g) => `- ${g.title}`).join('\n'));
  }
  const chapterText = require('../intelligence/chapters').composeChapterContext(chapters);
  if (chapterText) durable.push(`ACTIVE LIFE CHAPTERS:\n${chapterText}`);
  if (intention?.context) durable.push(`THIS WEEK'S STATED FOCUS: ${String(intention.context).slice(0, 300)}`);
  if (commitments.length) {
    durable.push(`OPEN COMMITMENTS (not yet done): ${commitments.map((c) => c.title).slice(0, 5).join('; ')}`);
  }

  // ── CURRENT — each item carries its own date/label. These are the ONLY
  //    things that may be spoken of as today/yesterday.
  const current = [];
  // Today's briefing snapshot ONLY if it was actually generated today; a
  // yesterday's brief is stale and must not be narrated as "this morning".
  const briefDay = briefing?.generated_at
    ? new Date(briefing.generated_at).toLocaleDateString('en-CA', { timeZone: tz })
    : null;
  const cb = briefing?.content?.chiefBrief;
  if (cb && briefDay === today) {
    if (cb.synthesis) current.push(`TODAY (${today}) — this morning's brief: ${cb.synthesis}`);
    if (cb.action) current.push(`TODAY (${today}) — suggested move: ${cb.action}`);
  }
  // Recovery is recomputed live from the latest sleep data, so it's genuinely
  // "today's" whenever present.
  if (recovery?.band) {
    current.push(`TODAY (${today}) — recovery: ${recovery.band}${recovery.score != null ? ` (${recovery.score})` : ''}`);
  }
  // The effective workout is inherently today's plan (override > auto-downgrade
  // > scheduled), resolved by the canonical selector — not the raw schedule.
  if (effectiveWorkout?.label) {
    const adj = effectiveWorkout.source === 'auto_downgrade'
      ? ' (auto-adjusted down for recovery)'
      : (effectiveWorkout.source === 'override' ? ' (manually chosen)' : '');
    current.push(`TODAY (${today}) — today's workout: ${effectiveWorkout.label}${adj}`);
  }
  // Very recent journal notes — ONLY today's/yesterday's, each explicitly dated.
  for (const e of recentJournal || []) {
    const d = String(e.entry_date || e.entryDate || '').slice(0, 10);
    if (d !== today && d !== yesterday) continue;
    const label = d === today ? 'TODAY' : 'YESTERDAY';
    current.push(`${label} (${d}) they noted: "${String(e.text || '').slice(0, 200)}"`);
  }

  return { durable: durable.join('\n\n'), current: current.join('\n'), today, yesterday };
}

/** Assemble the full system prompt from the persona + the temporal contract +
 *  the durable/current sections. Extracted (and exported) so the temporal
 *  contract is unit-testable without minting a live session. */
function composeInstructions(pkg) {
  const temporalRules =
    `TODAY'S DATE is ${pkg.today}. The context below is in two kinds. DURABLE facts are ongoing truths about this person — say them naturally but NEVER attach a time word. ` +
    `CURRENT items each carry their own date; only those may be spoken of as "today" or "yesterday". ` +
    `Do NOT say "today", "last night", "this morning", "currently", "right now", "lately", or "again" about anything unless it appears in the CURRENT section dated today/yesterday, or a get_ tool you just called returned it. ` +
    `If you're unsure whether something is current — their recovery, sleep, spending, a mood — call the matching get_ tool instead of guessing from durable context.`;
  const sections = [PERSONA, temporalRules];
  if (pkg.durable) sections.push(`WHAT IS DURABLY TRUE ABOUT THIS PERSON (timeless — never call this "today"):\n${pkg.durable}`);
  if (pkg.current) sections.push(`CURRENT / DATED CONTEXT (the ONLY things you may call today/yesterday):\n${pkg.current}`);
  return sections.join('\n\n');
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

    const pkg = await buildContextPackage();
    const instructions = composeInstructions(pkg);

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

module.exports = { createRealtimeRouter, buildContextPackage, composeInstructions, PERSONA };
