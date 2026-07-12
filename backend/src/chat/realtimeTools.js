// The Realtime voice agent's tool layer — narrowly scoped, compact,
// voice-friendly. Every tool here is a thin wrapper over an EXISTING store or
// EXISTING brain (ask.js's validateAction/executeAction, chat/ask.js's ask()
// itself for deep_ask) — this file adds no new intelligence, just a small,
// strictly allowlisted surface the Realtime model is allowed to call.
//
// TOOL_SCHEMAS is what gets handed to OpenAI at session-mint time (the
// model only ever sees these names/descriptions/parameter shapes). runTool()
// is the ONLY dispatcher — routes/realtime.js's POST /voice/realtime/tool
// rejects any name not in TOOL_SCHEMAS before this file is even consulted, so
// a Realtime session can never reach an arbitrary backend function.
const { query: dbQuery } = require('../db');

function snippet(text, n = 240) {
  if (!text) return '';
  const s = String(text);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---- get_today_context --------------------------------------------------
async function getTodayContext() {
  const [briefing, workout, recovery] = await Promise.all([
    require('../store/briefings').latestBriefing('daily').catch(() => null),
    Promise.resolve().then(() => { try { return require('../services/workout').getTodayWorkout(); } catch { return null; } }),
    require('../intelligence/recovery').liveRecovery().catch(() => null),
  ]);
  const cb = briefing?.content?.chiefBrief;
  return {
    synthesis: cb?.synthesis ?? null,
    action: cb?.action ?? null,
    risk: cb?.risk ?? null,
    workout: workout?.type ? { type: workout.type, duration: workout.duration ?? null } : null,
    recovery: recovery ? { score: recovery.score ?? null, band: recovery.band ?? null } : null,
  };
}

// ---- get_current_recovery -----------------------------------------------
async function getCurrentRecovery() {
  const r = await require('../intelligence/recovery').liveRecovery().catch(() => null);
  if (!r) return { available: false };
  return { available: true, score: r.score ?? null, band: r.band ?? null, detail: snippet(r.detail, 300) };
}

// ---- get_active_goals_and_commitments ------------------------------------
async function getActiveGoalsAndCommitments() {
  const [goalsRes, commitments, intention] = await Promise.all([
    dbQuery(`SELECT domain, title, metric, target_value, unit, target_date FROM goals WHERE status = 'active' ORDER BY target_date NULLS LAST LIMIT 8`).catch(() => ({ rows: [] })),
    require('../store/commitments').listActive({ limit: 8 }).catch(() => []),
    require('../store/intentions').currentIntention().catch(() => null),
  ]);
  return {
    goals: goalsRes.rows.map((g) => ({
      domain: g.domain, title: g.title,
      target: g.target_value != null ? `${g.target_value}${g.unit ? ' ' + g.unit : ''}` : null,
      by: g.target_date ? new Date(g.target_date).toISOString().slice(0, 10) : null,
    })),
    commitments: commitments.map((c) => ({ id: c.id, title: c.title, dueAt: c.due_at ? new Date(c.due_at).toISOString() : null })),
    weeklyIntention: intention?.context ? snippet(intention.context, 300) : null,
  };
}

// ---- get_recent_findings -------------------------------------------------
async function getRecentFindings() {
  const findings = await require('../store/findings').listFindings({ status: 'open', limit: 8 }).catch(() => []);
  return { findings: findings.map((f) => ({ type: f.type, title: f.title, detail: snippet(f.detail, 200) })) };
}

// ---- search_beliefs -------------------------------------------------------
async function searchBeliefs({ query: q } = {}) {
  const beliefs = await require('../store/beliefs').listActive({ limit: 100 }).catch(() => []);
  const term = String(q || '').toLowerCase().trim();
  const matches = term
    ? beliefs.filter((b) => String(b.statement || '').toLowerCase().includes(term))
    : beliefs;
  return { beliefs: matches.slice(0, 6).map((b) => ({ kind: b.kind, statement: snippet(b.statement, 240) })) };
}

// ---- query_metric -----------------------------------------------------
const METRIC_DAYS_MAX = 90;
async function queryMetric({ domain, metric, days = 7 } = {}) {
  if (!domain || !metric) return { error: 'domain and metric are required' };
  const metricsStore = require('../store/metrics');
  const clampedDays = Math.max(1, Math.min(METRIC_DAYS_MAX, Number(days) || 7));
  const [latest, series] = await Promise.all([
    metricsStore.latest({ domain, metric }).catch(() => null),
    metricsStore.dailyAggregate({ domain, metric, from: new Date(Date.now() - clampedDays * 864e5), agg: 'avg' }).catch(() => []),
  ]);
  const values = series.map((r) => Number(r.value)).filter(Number.isFinite);
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return {
    latest: latest ? { value: latest.value, ts: new Date(latest.ts).toISOString(), unit: latest.unit ?? null } : null,
    trailingAvg: avg != null ? Math.round(avg * 100) / 100 : null,
    days: clampedDays,
    points: values.length,
  };
}

// ---- search_personal_library ---------------------------------------------
async function searchPersonalLibrary({ query: q } = {}) {
  if (!q || !String(q).trim()) return { results: [] };
  const documents = require('../store/documents');
  const llm = require('../llm');
  let semantic = [];
  try {
    const [vec] = await llm.embed([q]);
    if (vec) semantic = await documents.searchSimilar(vec, { k: 5 });
  } catch { /* embedding optional — keyword fallback below still runs */ }
  const keyword = await documents.searchText([String(q)], { k: 5 }).catch(() => []);
  const seen = new Set();
  const merged = [];
  for (const d of [...keyword, ...semantic]) {
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    merged.push(d);
    if (merged.length >= 5) break;
  }
  return {
    results: merged.map((d) => ({
      title: d.title || 'Untitled', author: d.author || null,
      snippet: snippet(d.content, 260),
    })),
  };
}

// ---- execute_normos_action --------------------------------------------
// Reuses chat/ask.js's OWN validated-action allowlist verbatim — the exact
// same set typed and push-to-talk Ask already execute today. No new
// mutation surface: every action here is an internal, reversible write to
// the user's own data (habit/checkin/weight/reminder/etc.); none reach an
// external system, so this tool cannot become an unreviewed external-write
// path. The Realtime session's own instructions (routes/realtime.js) tell
// the model to confirm the specific values conversationally before calling
// this — the same "acknowledge, then act" pattern the text/voice Ask path
// already uses, just spoken instead of a single response.
async function executeNormosAction(args) {
  const { validateAction } = require('./ask');
  const { executeAction } = require('./executeAction');
  const validated = validateAction(args);
  if (!validated) return { done: false, description: 'That action was not recognized or was missing required fields.' };
  const result = await executeAction(validated);
  return result ?? { done: false, description: 'No matching action handler.' };
}

// ---- deep_ask --------------------------------------------------------
// Falls through to the FULL ask() engine (RAG + findings + snapshot +
// reasoning) for anything beyond what the fast-path tools above can answer
// from already-loaded session context. Persists both turns to the SAME
// shared Ask conversation as every other surface (voice.js, chat.js).
async function deepAsk({ question } = {}) {
  if (!question || !String(question).trim()) return { answer: '', sources: [] };
  const { ask } = require('./ask');
  const { executeAction } = require('./executeAction');
  const chatStore = require('../store/chat');

  const historyRows = await chatStore.recentMessages({ limit: 20 }).catch(() => []);
  const result = await ask(String(question), {
    history: historyRows.map((m) => ({ role: m.role, content: m.content })),
    voice: true,
  });

  const executedList = [];
  for (const a of (result.actions ?? (result.action ? [result.action] : []))) {
    executedList.push(await executeAction(a));
  }

  const convId = await chatStore.ensureActiveConversation();
  chatStore.saveMessage({ role: 'user', content: question, embedding: result.questionEmbedding ?? null, conversationId: convId })
    .catch((e) => console.error('[realtime deep_ask] save user failed:', e.message));
  chatStore.saveMessage({ role: 'assistant', content: result.answer, sources: result.sources ?? [], conversationId: convId })
    .catch((e) => console.error('[realtime deep_ask] save assistant failed:', e.message));

  return {
    answer: result.answer,
    sources: (result.sources ?? []).slice(0, 4).map((s) => ({ title: s.title, author: s.author ?? null })),
    executed: executedList.filter(Boolean).map((e) => e.description),
  };
}

// ---- registry --------------------------------------------------------
// JSON Schema for each tool's parameters, in the shape OpenAI's Realtime
// session config expects (function tools). Descriptions are written for the
// MODEL (when to call this), not for a human reader.
const TOOL_SCHEMAS = [
  {
    type: 'function', name: 'get_today_context',
    description: "Compact snapshot of today: the morning brief's synthesis/action/risk, today's planned workout, and current recovery band. Call this first for any \"how am I doing today / what should I focus on\" style question, before reaching for deep_ask.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function', name: 'get_current_recovery',
    description: "The user's live recovery score/band (HRV, resting HR, sleep-derived) right now.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function', name: 'get_active_goals_and_commitments',
    description: 'Active goals with targets, open commitments the user made, and this week\'s stated intention/focus.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function', name: 'get_recent_findings',
    description: "Currently-open findings the intelligence layer has surfaced (trends, anomalies, forecasts) — what the user's data currently shows.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function', name: 'search_beliefs',
    description: 'Search durable beliefs NormOS holds about this person (stated preferences, dismissal patterns, standing facts) by keyword.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'keyword or short phrase to search for' } },
      required: ['query'], additionalProperties: false,
    },
  },
  {
    type: 'function', name: 'query_metric',
    description: 'Look up a specific tracked metric\'s latest value and trailing-average trend (e.g. domain "health", metric "hrv").',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'e.g. health, wellbeing, habits, wealth' },
        metric: { type: 'string', description: 'e.g. hrv, sleep_hours, resting_hr, weight' },
        days: { type: 'number', description: 'trailing window in days, default 7, max 90' },
      },
      required: ['domain', 'metric'], additionalProperties: false,
    },
  },
  {
    type: 'function', name: 'search_personal_library',
    description: "Search the user's saved highlights/notes/books (Readwise, Notion, journal) for relevant ideas.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'], additionalProperties: false,
    },
  },
  {
    type: 'function', name: 'execute_normos_action',
    description:
      'Take a concrete, already-supported app action the user just told you to do (log a habit, swap today\'s workout, log mood/energy/focus, log weight, log gratitude, set a reminder, log/add day context, add a life chapter). ' +
      'ALWAYS restate what you are about to do in one short sentence before calling this, so the user can correct you if you misheard. Only call for a clear statement of fact/intent, never for a question. ' +
      'Pass EXACTLY one action shaped like: {"type":"swap_workout","workoutId":"push|pull|zone2|mobility|intervals|rest"} | {"type":"log_habit","habit":"morningTM|afternoonTM|gratitude|coldShower|exercise"} | {"type":"log_activity","activityType":"...","durationMin":number,"label":"...","noWatch":boolean} | {"type":"log_checkin","mood":1-5,"energy":1-5,"focus":1-5} | {"type":"log_weight","weightLb":number} | {"type":"log_gratitude_text","text":"..."} | {"type":"add_context","text":"..."} | {"type":"log_day_context","text":"..."} | {"type":"set_reminder","text":"...","at":"YYYY-MM-DDTHH:MM or null"} | {"type":"add_chapter","kind":"pregnancy|countdown|note","label":"...","keyDate":"YYYY-MM-DD or null","keyDateLabel":"..."}',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        workoutId: { type: 'string' }, habit: { type: 'string' }, activityType: { type: 'string' },
        durationMin: { type: 'number' }, label: { type: 'string' }, noWatch: { type: 'boolean' },
        mood: { type: 'number' }, energy: { type: 'number' }, focus: { type: 'number' },
        weightLb: { type: 'number' }, text: { type: 'string' }, at: { type: 'string' },
        kind: { type: 'string' }, keyDate: { type: 'string' }, keyDateLabel: { type: 'string' },
      },
      required: ['type'], additionalProperties: false,
    },
  },
  {
    type: 'function', name: 'deep_ask',
    description:
      'For anything requiring real retrieval, longitudinal analysis, or cross-domain reasoning beyond what the other tools give you directly — a genuinely deep question. ' +
      'This takes a few seconds; ALWAYS say something natural first ("let me look across your history…") before calling it, never go silent. ' +
      'Pass the user\'s full question, verbatim.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'], additionalProperties: false,
    },
  },
];

const HANDLERS = {
  get_today_context: getTodayContext,
  get_current_recovery: getCurrentRecovery,
  get_active_goals_and_commitments: getActiveGoalsAndCommitments,
  get_recent_findings: getRecentFindings,
  search_beliefs: searchBeliefs,
  query_metric: queryMetric,
  search_personal_library: searchPersonalLibrary,
  execute_normos_action: executeNormosAction,
  deep_ask: deepAsk,
};

const TOOL_NAMES = new Set(Object.keys(HANDLERS));

/** Run a tool by name. Throws for an unknown name — routes/realtime.js
 *  catches this and returns a 400, so an unlisted name never silently no-ops
 *  its way into looking like success. */
async function runTool(name, args = {}) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`unknown tool: ${name}`);
  return handler(args || {});
}

module.exports = { TOOL_SCHEMAS, TOOL_NAMES, runTool };
