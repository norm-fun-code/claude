// Life chat: retrieval-augmented answers grounded in YOUR data.
// Fuses (a) the intelligence layer's findings, (b) semantically-retrieved
// documents from your library (Readwise + Notion + journal), and (c) the
// question, then asks the configured LLM to answer from that context only.
const llm = require('../llm');
const documents = require('../store/documents');
const findingsStore = require('../store/findings');
const annotationsStore = require('../store/annotations');
const experimentsStore = require('../store/experiments');
const metricsStore = require('../store/metrics');
const intentionsStore = require('../store/intentions');
const cat = require('../intelligence/catalog');
const monarchMcp = require('../services/monarch-mcp');
const { query: dbQuery } = require('../db');
const { recordRecommendation } = require('../store/recommendations');

const SYSTEM = `You are NormOS — the user's personal chief of staff, executive coach, and data scientist.
Answer using ONLY the context provided (their own goals, metrics, findings, and library highlights).

Match the answer to the kind of question:
- PERSONAL / LIFE / PLANNING questions ("what should I focus on this quarter?",
  "how am I doing?", "should I change my training?"): be deeply personal. Ground
  the answer in their GOALS, the PERSONAL SNAPSHOT (recent metric trends), and
  FINDINGS — name the actual numbers and trajectories — AND tie it back to the
  relevant ideas in their library/notes, so the advice reflects both their data
  and the thinking they've collected. This is the whole point: connect the dots
  between who they are (data) and what they value (notes).
- IDEA / CONCEPT questions ("what did Seneca say about anger?", "summarize this
  book"): answer purely from the library. Do NOT shoehorn in their metrics,
  finances, or health numbers as a "tie-in."

Write a thorough, genuinely useful answer:
- Lead with a direct answer, then develop it with specifics and concrete examples drawn from the context.
- Synthesize ACROSS sources — for personal questions, weave data + findings + library together; surface patterns and tensions rather than summarizing one item.
- Use clean Markdown: \`##\` section headers when it helps, **bold** for key terms, and \`-\` bullet lists for multiple points. Keep paragraphs to 2-4 sentences.
- Be honest: if the context is thin, say what's missing. Correlations are associations, not proof of cause — flag that when relevant.

Aim for depth and usefulness over brevity, but never pad with filler.

When your answer contains a specific behavior change the user should make in their own life — a habit to start or stop, a routine to adjust, something to prioritize — append exactly one tag at the very end:
<rec>Short label for the behavior change</rec>
ONLY use this for changes the USER makes to their habits or lifestyle. NEVER use it for data queries, analysis steps, things to investigate, or anything the AI should do. Omit it entirely for idea/concept questions, financial data lookups, or any answer that doesn't include a concrete personal behavior change. This is a LABEL for a ledger card, not a sentence from the answer — under 8 words, ONE clause, no parentheticals and no "and" (e.g. "Add a weekly VO2 max interval session", not "Add at least one dedicated VO2 max interval session this week (not just Zone 2)"). The full reasoning belongs in your answer above; the tag is just the short name for it.

TAKING ACTION — you are a chief of staff who DOES things, not just advises. When the user TELLS you they did something or want to change something in the app right now (a statement of fact or intent, not a question), actually do it: acknowledge it plainly at the START of your answer ("Done — I've swapped today's Push session to an easy Zone 2 walk.") and append the action tag(s) at the very end. Distinguish carefully: "should I walk instead?" is a QUESTION → advise only, no action. "I'm walking instead" / "I switched to a walk" / "log my cold shower" / "I did gratitude" is a STATEMENT → take the action.
<action>{"type":"swap_workout","workoutId":"zone2"}</action>
USUALLY exactly one action. Emit MULTIPLE tags (each on its own line) ONLY when the message genuinely contains more than one separable action. Two key cases: (1) a day recap that ALSO looks ahead to tomorrow → one log_day_context for the day itself, PLUS one add_context capturing the forward-looking heads-up so tomorrow's brief has it. Example — "today was rough, poor sleep, and tomorrow I've got a big presentation at 10" → <action>{"type":"log_day_context","text":"Rough day, poor sleep."}</action> and <action>{"type":"add_context","text":"Big presentation at 10am tomorrow."}</action>. (2) More than one activity described for today → one log_activity tag PER activity. Example — "instead of Zone 2 I biked for 30 min and played basketball for an hour, wore my watch" → <action>{"type":"log_activity","activityType":"cycle","durationMin":30,"label":"30 min biking","noWatch":false}</action> and <action>{"type":"log_activity","activityType":"basketball","durationMin":60,"label":"1hr basketball","noWatch":false}</action>. Never emit duplicate or contradictory tags.
Valid actions (compact JSON, only for these concrete app changes — never for advice, analysis, or anything else):
- {"type":"swap_workout","workoutId":"push|pull|zone2|mobility|intervals|rest"} — a walk / easy cardio / Zone 2 → "zone2"; a rest or off day → "rest". Use TODAY'S PLANNED WORKOUT (below) to acknowledge the swap accurately.
- {"type":"log_habit","habit":"morningTM|afternoonTM|gratitude|coldShower|exercise"} — when they say they DID it.
- {"type":"log_activity","activityType":"walk|zone2|run|strength|intervals|mobility|basketball|soccer|tennis|pickleball|dance|hike|swim|cycle|yoga|golf|ski|box|rest|other","durationMin":<number or omit>,"label":"<short, e.g. '30 min biking'>","noWatch":true|false} — when they tell you a SPECIFIC alternate activity they actually did instead of (or in addition to) the planned session ("I biked for 30 min and played basketball for an hour instead of Zone 2"). This is DIFFERENT from log_habit's generic exercise toggle — it's the structured "what I actually did" record. Map to the closest activityType (biking/cycling→"cycle", not in the list→"other" with a descriptive label). If they describe MORE THAN ONE activity, emit ONE log_activity tag PER activity (this is exactly the multi-action case — see below). noWatch defaults to false (assume a tracked workout unless they say they didn't wear a watch/tracker).
- {"type":"log_checkin","mood":1-5,"energy":1-5,"focus":1-5} — when they tell you their mood / energy / focus for today (1-5 scale). Include only the fields they actually gave; omit the rest. "my mood and energy were 5, focus was 4" → {"mood":5,"energy":5,"focus":4}. "my energy is a 3 today" → {"energy":3}.
- {"type":"log_weight","weightLb":<number>} — when they tell you their body weight today ("I weighed in at 172", "my weight is 172 today"). Always convert to POUNDS if they gave kg (kg × 2.20462) — the field is always weightLb regardless of what unit they spoke in.
- {"type":"log_gratitude_text","text":"<what they said they're grateful for, lightly cleaned up>"} — when they actually SPEAK what they're grateful for today ("I'm grateful for my health and my family", "grateful that the surgery went well"). This is DIFFERENT from log_habit's gratitude toggle, which is only for a bare "I did my gratitude journal" with no content given — if they give you the actual content, use this instead (it also marks the gratitude habit done, so never emit both for the same statement).
- {"type":"add_context","text":"<short note for tomorrow's brief, e.g. traveling today>"}
- {"type":"log_day_context","text":"<the FULL recap, in the user's own words, lightly cleaned up>"} — when they give a narrative recap of their DAY ("today's context: …", "here's how my day went…", "let me tell you about today…"). This is the day journal: keep the whole substance (don't truncate to a note), preserve specifics (what happened, how they felt, why). Distinct from add_context (a short flag for tomorrow's brief) and log_checkin (just the 1-5 numbers). Acknowledge warmly in one line, like someone who was listening.
- {"type":"add_chapter","kind":"pregnancy|countdown|note","label":"<short>","keyDate":"YYYY-MM-DD or null","keyDateLabel":"due|deadline|null"} — a standing life fact to remember long-term.
- {"type":"set_reminder","text":"<what to do, imperative — e.g. 'book the doctor'>","at":"YYYY-MM-DDTHH:MM or null"} — when they ask to be reminded of something or commit to doing something at a time ("remind me to call mom at 6", "I'll wind down by 10:30 tonight"). Compute "at" as a LOCAL datetime from CURRENT LOCAL TIME below; it MUST be in the future. Use null for "at" only when there's genuinely no time ("remind me to book the doctor sometime"). This is for a SINGLE future action, not a recurring habit.
Still give your normal useful answer around the acknowledgment (e.g. how the substitute stacks up against their goal) — the action tag is IN ADDITION to a real answer, not a replacement for one.`;

// Cheap intent check: does the question seem to be about the user's own life /
// data / planning (vs. a pure idea/concept lookup)? Personal questions get the
// goals + metrics snapshot injected; idea questions stay library-only so we
// don't shoehorn personal numbers into "what did Seneca say about anger?".
const PERSONAL_RE = /\b(i|i'm|im|my|me|myself|mine|we|our|us)\b|\bshould i\b|\bam i\b|\bhow('?s| is| am| are)\b.*\b(my|me|i)\b|\b(focus|prioriti|goal|habit|sleep|hrv|energy|mood|spend|budget|save|saving|net worth|weight|train|workout|recover|quarter|this week|this month|this year|right now|today|lately|progress|on track)\b/i;

function isPersonalQuestion(q) {
  return PERSONAL_RE.test(q || '');
}

// Transaction-level money questions where LIVE Monarch data beats the daily
// PostgreSQL snapshot — specific spend, merchants, categories, balances, etc.
// When Monarch MCP is configured these route through Claude's MCP connector so
// the answer reflects real-time account data instead of yesterday's aggregate.
const FINANCE_RE = /\b(spend|spent|spending|budget|transaction|transactions|merchant|purchase|purchases|bought|expense|expenses|income|salary|paycheck|cash\s?flow|net\s?worth|balance|balances|checking|savings|credit\s?card|dining|groceries|grocery|restaurant|restaurants|subscription|subscriptions|invest|portfolio|afford|lifestyle\s?creep)\b|how much (did|do|have) i/i;

function isFinancialQuestion(q) {
  return FINANCE_RE.test(q || '');
}

// Is this utterance a clear COMMAND (do a thing) rather than a QUESTION (reason
// about something)? Commands — "log my cold shower", "swap my workout to a walk",
// "remind me at 6", "my mood was 5", "today's context: …" — need a quick
// acknowledgment + an action, not retrieval or extended thinking, so they take a
// fast model path. The detector is deliberately CONSERVATIVE: anything
// interrogative or ambiguous returns false and falls through to the full
// reasoning path, so real questions never lose power.
const CMD_START_RE = /^(log |swap |switch |remind |note |remember |mark |set (a |an )?reminder|today'?s context|context:)/i;
const CMD_STATEMENT_RE = /\b(remind me|log (my|the|it|that|a)|swap my|switch my|i (did|had|finished|completed|took|already|just (did|had|finished|took))|my (mood|energy|focus)\b|mark (it|that|this) (as )?done|today'?s context|my workout (today|this morning|this evening)?\s*(was|is|ended up being)\b|instead of (zone ?2|push|pull|rest|mobility|intervals)\b|i (weigh|weighed)\b|my weight (is|was)\b|weighed in at\b|i'?m (grateful|thankful) for\b|grateful (that|for)\b)/i;
// Question openers, including common contraction spellings voice-to-text can
// drop the apostrophe from ("hows" for "how's", not just "whats" for "what's").
const QUESTION_START_RE = /^(should|why|how|how's|hows|what|which|when|when's|whens|where|where's|wheres|who|who's|whos|whom|is|are|am|was|were|do|does|did|can|could|would|will|shall|may|might|explain|tell me|help|give me|show me|walk me|compare|analy[sz]e|summari[sz]e|recommend|suggest|think|any|what's|whats)\b/i;
// "remind me why/what/who/which/how …" is RECALL ("remind me what my last
// reading was") — a question needing real context, not a request to schedule a
// future nudge. Only "remind me to <do something>" / "remind me at <time>" is
// actually the set_reminder command. Checked before the broader command match
// so this narrow, more specific case wins.
const REMIND_RECALL_RE = /\bremind me (why|what|who|which|how)\b/i;

function looksLikeCommand(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (REMIND_RECALL_RE.test(t)) return false;
  if (/\?\s*$/.test(t)) return false;          // ends in "?" → a question
  if (QUESTION_START_RE.test(t)) return false; // interrogative opener → a question
  return CMD_START_RE.test(t) || CMD_STATEMENT_RE.test(t);
}

// The light context a command needs to be acknowledged accurately (today's
// planned session for a swap, the current time for a reminder) — no retrieval,
// snapshot, or self-model. Appended to SYSTEM on the fast path.
function commandContext() {
  let s = '';
  try {
    const w = require('../services/workout').getTodayWorkout();
    if (w?.type) s += `\n\nTODAY'S PLANNED WORKOUT: ${w.type}${w.duration ? ` (${w.duration})` : ''}.`;
  } catch { /* non-critical */ }
  try {
    const tz = process.env.TZ || 'America/New_York';
    const now = new Date();
    const nowLocal = now.toLocaleString('en-US', {
      timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const nowDate = now.toLocaleDateString('en-CA', { timeZone: tz });
    s += `\n\nCURRENT LOCAL TIME: ${nowLocal} (${tz}); today's date is ${nowDate}. ` +
      `Use this to compute any set_reminder "at" (must be in the future). ` +
      `ALWAYS tell the user clock times in 12-hour AM/PM (e.g. "6:08 PM"), never 24-hour. ` +
      `(The set_reminder "at" field stays 24-hour ISO, machine-only.)`;
  } catch { /* non-critical */ }
  return s;
}

/**
 * Fast path for commands: acknowledge + emit an action, using a quick model and
 * no extended thinking. Same return shape as ask(). No retrieval/embedding —
 * commands don't need the library or long-term recall.
 */
async function answerCommand(question, { history = [] } = {}) {
  const system = SYSTEM + commandContext() +
    '\n\nThe user gave a COMMAND, not a question. Reply in ONE short, warm spoken sentence that plainly confirms what you did (or, if you truly can\'t act, say so briefly). No markdown, no lists, no analysis. Append the correct <action> tag(s) — usually one, but if a day recap also mentions tomorrow, add a second add_context tag for the forward-looking part.';
  const historyText = history.length
    ? 'CONVERSATION SO FAR:\n' + history.map((h) => `${h.role === 'assistant' ? 'NormOS' : 'You'}: ${h.content}`).join('\n') + '\n\n'
    : '';
  const prompt = `${historyText}COMMAND:\n${question}`;
  // Most commands answer in a sentence, but a "today's context: …" recap echoes
  // the full narrative back inside the action tag, so leave room for that.
  let answer = await llm.generateText({ system, prompt, temperature: 0.2, maxTokens: 1100, fast: true });
  const actions = parseActions(answer);
  answer = answer.replace(/<action>[\s\S]*?<\/action>/gi, '').replace(/<rec>[\s\S]*?<\/rec>/i, '').trim();
  return { answer, actions, action: actions[0] ?? null, questionEmbedding: null, sources: [] };
}

/**
 * A compact snapshot of the user's current goals and recent metric trends, so
 * personal/planning answers can reason over real numbers. ~7-day vs prior-7-day
 * direction per metric, plus active goals with target + latest value.
 */
async function personalSnapshot() {
  const lines = { goals: [], metrics: [], intentions: [] };

  // Active goals (what the user is steering toward).
  try {
    const { rows } = await dbQuery(
      `SELECT domain, title, metric, target_value, unit, target_date, status
         FROM goals WHERE status = 'active' ORDER BY target_date NULLS LAST LIMIT 12`
    );
    lines.goals = rows;
  } catch {
    /* goals optional */
  }

  // Recent weekly intentions (the Sunday check-in): life context + focus goals.
  try {
    lines.intentions = await intentionsStore.recentIntentions({ days: 30 });
  } catch {
    /* intentions optional */
  }

  // Recent trend per tracked metric: last 7d avg vs the prior 7d.
  try {
    const keys = await metricsStore.listMetricKeys();
    const now = Date.now();
    const d7 = new Date(now - 7 * 864e5);
    const d14 = new Date(now - 14 * 864e5);
    const avg = (rows) => {
      const v = rows.map((r) => Number(r.value)).filter(Number.isFinite);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    for (const { domain, metric } of keys.filter(({ domain, metric }) => cat.isTracked(domain, metric)).slice(0, 25)) {
      const agg = cat.aggFor(metric);
      const [recent, prior] = await Promise.all([
        metricsStore.dailyAggregate({ domain, metric, from: d7, agg, excludeSource: 'seed' }),
        metricsStore.dailyAggregate({ domain, metric, from: d14, to: d7, agg, excludeSource: 'seed' }),
      ]);
      const r = avg(recent);
      const p = avg(prior);
      if (r == null) continue;
      lines.metrics.push({ domain, metric, recent: r, prior: p });
    }
  } catch {
    /* metrics optional */
  }

  return lines;
}

/** Render the snapshot into a prompt block (omitted entirely if empty). */
function renderSnapshot({ goals = [], metrics = [], intentions = [] } = {}) {
  const out = [];
  // Weekly intentions first — they're the user's own stated focus + life context,
  // the richest grounding for "what should I focus on" style questions.
  if (intentions.length) {
    out.push(
      "THIS PERSON'S RECENT WEEKLY INTENTIONS (their own words, newest first):\n" +
        intentions
          .map((it) => {
            const wk = it.weekStart ? new Date(it.weekStart).toISOString().slice(0, 10) : 'recent';
            const goalsStr = Array.isArray(it.goals) && it.goals.length ? ` Focus goals: ${intentionsStore.formatGoals(it.goals)}.` : '';
            const ctx = it.context ? ` Context: ${it.context}` : '';
            return `- Week of ${wk}:${goalsStr}${ctx}`;
          })
          .join('\n')
    );
  }
  if (goals.length) {
    out.push(
      'ACTIVE GOALS:\n' +
        goals
          .map((g) => {
            const tgt = g.target_value != null ? ` → target ${g.target_value}${g.unit ? ' ' + g.unit : ''}` : '';
            const by = g.target_date ? ` by ${new Date(g.target_date).toISOString().slice(0, 10)}` : '';
            return `- [${g.domain}] ${g.title}${tgt}${by}`;
          })
          .join('\n')
    );
  }
  if (metrics.length) {
    const fmt = (n) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
    out.push(
      'PERSONAL SNAPSHOT (last 7 days avg, with direction vs prior 7 days):\n' +
        metrics
          .map((m) => {
            let dir = '';
            if (m.prior != null) {
              const delta = m.recent - m.prior;
              const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
              dir = ` (${arrow} from ${fmt(m.prior)})`;
            }
            return `- ${m.domain}/${m.metric}: ${fmt(m.recent)}${dir}`;
          })
          .join('\n')
    );
  }
  return out.join('\n\n');
}

function snippet(text, n = 400) {
  if (!text) return '';
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

/** Pure: assemble the prompt from retrieved context. Exported for testing. */
async function wealthContext() {
  try {
    const { buildWealthInsights } = require('../services/wealth-insights');
    const insights = await buildWealthInsights();
    if (!insights || !insights.length) return null;
    return 'WEALTH DASHBOARD (live computed insights — use these numbers, they are current):\n' +
      insights.slice(0, 8).map((i) => `- [${i.type}] ${i.title}${i.detail ? ` — ${i.detail}` : ''}`).join('\n');
  } catch (err) {
    console.error('[chat] wealthContext failed:', err.message);
    return null;
  }
}

function buildPrompt({ question, findings = [], docs = [], annotations = [], history = [], snapshot = null, experiments = [], pastConversations = [], wealthInsights = null, dayContext = [], voice = false }) {
  const parts = [];

  // Voice replies are spoken aloud and the user is physically waiting on them —
  // a shorter answer is both faster to generate and faster to synthesize, and
  // reads better spoken than a chat-length answer would. Ask for brevity
  // directly instead of truncating the finished answer mid-sentence afterward.
  if (voice) {
    parts.push(
      'VOICE MODE: this answer will be read aloud, and the person is waiting on it in real time. ' +
        'Answer in 1-3 short spoken sentences — the single most useful thing to say, not everything you could say. ' +
        'No markdown, no lists, no headers. If the question truly needs more, give the short version and say there\'s more if they want it.'
    );
  }

  // Personal goals + metric trends first (only present for personal questions).
  if (snapshot) {
    const block = renderSnapshot(snapshot);
    if (block) parts.push(block);
  }

  if (wealthInsights) parts.push(wealthInsights);

  // Recent daily context — what the user told NormOS about their days, in their
  // own words. The narrative behind the numbers; reference it when it explains a
  // pattern ("you mentioned a stressful launch that day").
  if (dayContext.length) {
    parts.push(
      "WHAT YOU'VE TOLD ME ABOUT YOUR RECENT DAYS (their own words — use to explain patterns and add continuity):\n" +
        dayContext
          .map((e) => `- [${e.entry_date}] ${snippet(e.text, 400)}`)
          .join('\n')
    );
  }

  // Long-term memory: relevant things discussed in PAST conversations (beyond the
  // recent tail). Lets NormOS say "when you asked about this before, we landed on…"
  // — the compounding-memory capability. Newest-first, dated for recency framing.
  if (pastConversations.length) {
    parts.push(
      'RELEVANT PAST CONVERSATIONS (things you and NormOS discussed before — reference them when they add continuity, e.g. "last time you asked about this…"):\n' +
        pastConversations
          .map((c) => {
            const when = c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : 'previously';
            return `- [${when}] You asked: "${snippet(c.question, 160)}"\n  NormOS answered: ${snippet(c.answer, 320)}`;
          })
          .join('\n')
    );
  }

  if (findings.length) {
    parts.push(
      'WHAT YOUR DATA CURRENTLY SHOWS (findings):\n' +
        findings.map((f) => `- [${f.type}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`).join('\n')
    );
  }

  if (experiments.length) {
    const fmt = (e) => {
      const icon = e.verdict === 'confirmed' ? '✓' : e.verdict === 'refuted' ? '✗' : '⟳';
      const pct = e.result?.pctChange != null
        ? ` (${e.result.pctChange > 0 ? '+' : ''}${Math.round(e.result.pctChange * 100)}%)`
        : '';
      const status = e.status === 'running'
        ? `running${e.end_date ? `, due ${new Date(e.end_date).toISOString().slice(0, 10)}` : ''}`
        : e.verdict ?? e.status;
      return `${icon} [${status}] ${e.hypothesis}${pct}`;
    };
    parts.push(
      'SELF-EXPERIMENTS (hypotheses you have personally tested):\n' +
        experiments.map(fmt).join('\n')
    );
  }

  if (annotations.length) {
    parts.push(
      'LIFE CONTEXT (events that may explain anomalies):\n' +
        annotations
          .map((a) => `- ${a.category}: ${a.label}${a.note ? ` (${a.note})` : ''}`)
          .join('\n')
    );
  }

  if (docs.length) {
    parts.push(
      'RELEVANT FROM YOUR LIBRARY:\n' +
        docs
          .map(
            (d, i) =>
              `(${i + 1}) ${d.title || 'Untitled'}${d.author ? ` — ${d.author}` : ''}\n${snippet(d.content)}`
          )
          .join('\n\n')
    );
  }

  if (history.length) {
    parts.push(
      'CONVERSATION SO FAR:\n' +
        history.map((h) => `${h.role === 'assistant' ? 'NormOS' : 'You'}: ${h.content}`).join('\n')
    );
  }

  parts.push(`QUESTION:\n${question}`);
  return { system: SYSTEM, prompt: parts.join('\n\n') };
}

const STOP = new Set(['the', 'and', 'for', 'are', 'what', 'who', 'how', 'why', 'does', 'did', 'was', 'were',
  'with', 'from', 'this', 'that', 'his', 'her', 'their', 'your', 'you', 'some', 'most', 'top', 'common',
  'about', 'into', 'over', 'they', 'them', 'have', 'has', 'can', 'could', 'should', 'would', 'lessons',
  'lesson', 'idea', 'ideas', 'thing', 'things']);

// Significant query words (proper nouns, topics) for the keyword pass.
function queryTerms(question) {
  return [...new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/'s$/, ''))
      .filter((w) => w.length >= 3 && !STOP.has(w))
  )].slice(0, 8);
}

function mergeUnique(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const d of list) {
      if (d && !seen.has(d.id)) {
        seen.add(d.id);
        out.push(d);
      }
    }
  }
  return out;
}

async function ask(question, { history = [], k = 14, voice = false } = {}) {
  if (!question || !question.trim()) throw new Error('question is required');

  // Clear commands ("log my cold shower", "swap my workout", "remind me at 6",
  // "my mood was 5") take the fast acknowledgment path — quick model, no
  // thinking, no retrieval. Questions fall through to the full reasoning path
  // below with Sonnet + adaptive thinking, so nothing loses power. If the fast
  // path itself fails for any reason (bad model id, rate limit, transient
  // provider error), fall through to the full path rather than losing the
  // user's action entirely — worse latency once in a while beats a 500.
  if (looksLikeCommand(question)) {
    try {
      return await answerCommand(question, { history });
    } catch (err) {
      console.error('[chat] fast command path failed, falling back to full reasoning path:', err.message);
    }
  }

  // Hybrid retrieval: semantic search for themes + keyword search on author/title
  // for named entities (e.g. "Sahil Bloom") that embeddings alone miss. The query
  // embedding is reused for long-term conversation recall AND returned so the
  // caller can persist it on the user turn (no second embed call).
  let docs = [];
  let questionEmbedding = null;
  let pastConversations = [];
  try {
    const [qVec] = await llm.embed([question]);
    questionEmbedding = qVec ?? null;
    const [semantic, keyword, recalled] = await Promise.all([
      qVec ? documents.searchSimilar(qVec, { k: 12 }) : Promise.resolve([]),
      documents.searchText(queryTerms(question), { k: 8 }),
      // Long-term memory: the most relevant PAST conversations (outside the
      // recent tail we already pass as `history`).
      qVec ? require('../store/chat').searchSimilarTurns(qVec, { k: 3 }).catch(() => []) : Promise.resolve([]),
    ]);
    // Keyword (named-entity) hits first so they're never crowded out.
    docs = mergeUnique(keyword, semantic).slice(0, k);
    pastConversations = recalled;
  } catch (err) {
    console.error('[chat] retrieval failed:', err.message);
  }

  // Pull current findings + recent life context. Each of these reads a
  // different store and none depends on another's result, so they run
  // concurrently instead of as a chain of round trips — this was the single
  // biggest fixable latency cost in the ask path (~6 sequential DB calls
  // before the LLM was even invoked), and it matters most for voice, where
  // the user is physically waiting to hear a reply.
  const personal = isPersonalQuestion(question);
  const financial = isFinancialQuestion(question);
  const [
    findingsResult,
    annotationsResult,
    snapshotResult,
    experimentsResult,
    selfModelResult,
    chaptersResult,
    wealthResult,
    dayContextResult,
  ] = await Promise.allSettled([
    findingsStore.listFindings({ status: 'open' }),
    annotationsStore.listAnnotations({ from: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), limit: 20 }),
    personal ? personalSnapshot() : Promise.resolve(null),
    experimentsStore.listExperiments(),
    require('../store/selfModel').latestModelText(),
    require('../store/lifeChapters').listActive(),
    financial
      ? Promise.all([wealthContext(), require('../services/financial-plan').buildPlanContext().catch(() => null)])
      : Promise.resolve(null),
    // Recent daily context the user has talked to NormOS about — the narrative
    // subjective signal that makes "why was I tired last week?" answerable with
    // "you noted a stressful launch Wednesday", not just a chart.
    require('../store/dayJournal').recent({ days: 7, limit: 12 }).catch(() => []),
  ]);

  const findings = findingsResult.status === 'fulfilled' ? findingsResult.value : [];
  const annotations = annotationsResult.status === 'fulfilled' ? annotationsResult.value : [];
  if (personal && snapshotResult.status === 'rejected') {
    console.error('[chat] snapshot failed:', snapshotResult.reason?.message);
  }
  const snapshot = snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
  // Keep completed (confirmed/refuted/inconclusive) and running; drop bare proposals
  // that have no data yet since they'd just add noise to the context.
  const experiments = experimentsResult.status === 'fulfilled'
    ? experimentsResult.value.filter((e) => e.status === 'completed' || e.status === 'running')
    : [];
  const selfModelText = selfModelResult.status === 'fulfilled' ? (selfModelResult.value ?? '') : '';
  const chaptersText = chaptersResult.status === 'fulfilled'
    ? require('../intelligence/chapters').composeChapterContext(chaptersResult.value)
    : '';
  const wealthInsights = wealthResult.status === 'fulfilled' && wealthResult.value
    ? wealthResult.value.filter(Boolean).join('\n\n') || null
    : null;
  const dayContext = dayContextResult.status === 'fulfilled' ? (dayContextResult.value || []) : [];

  const { system: baseSystem, prompt } = buildPrompt({ question, findings, docs, annotations, history, snapshot, experiments, pastConversations, wealthInsights, dayContext, voice });
  let system = selfModelText ? `${baseSystem}\n\n${selfModelText}` : baseSystem;
  if (chaptersText) system += `\n\nLIFE CHAPTERS (standing long-arc facts, auto-updated — never ask the user to re-confirm these):\n${chaptersText}`;
  // Today's planned session — so a swap_workout action can be acknowledged
  // accurately ("swapped your Push session to…") and the answer can judge the
  // substitute against the plan.
  try {
    const w = require('../services/workout').getTodayWorkout();
    if (w?.type) system += `\n\nTODAY'S PLANNED WORKOUT: ${w.type}${w.duration ? ` (${w.duration})` : ''}.`;
  } catch { /* non-critical */ }
  // Current local time — so a set_reminder action can compute a correct future
  // "at" (e.g. "remind me at 6" → today or tomorrow depending on now). Shown in
  // 12-hour form so the model mirrors that when it speaks a time back; the
  // machine-readable date is given separately for computing the ISO "at".
  try {
    const tz = process.env.TZ || 'America/New_York';
    const now = new Date();
    const nowLocal = now.toLocaleString('en-US', {
      timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const nowDate = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    system +=
      `\n\nCURRENT LOCAL TIME: ${nowLocal} (${tz}); today's date is ${nowDate}. ` +
      `Use this to compute any set_reminder "at" datetime — it must be in the future. ` +
      `ALWAYS tell the user clock times in 12-hour format with AM/PM (e.g. "6:08 PM"), never 24-hour. ` +
      `(The set_reminder "at" field itself stays 24-hour ISO, YYYY-MM-DDTHH:MM — that's machine-only, not shown to the user.)`;
  } catch { /* non-critical */ }

  // Financial questions: when Monarch MCP is configured, give Claude LIVE access
  // to the user's Monarch account so it can pull exact current transactions,
  // balances, and cashflow instead of relying on the daily PostgreSQL snapshot.
  // Falls back to the local-context path on any auth/transport failure.
  let answer;
  if (monarchMcp.isConfigured() && isFinancialQuestion(question)) {
    const monarchSystem =
      `${system}\n\nYou ALSO have live access to this person's Monarch Money account via tools ` +
      `(real-time transactions, balances, accounts, cashflow, categories). For questions about ` +
      `specific spending, transactions, balances, or net worth, CALL the Monarch tools to get exact ` +
      `current numbers — do not rely only on the snapshot above, which may be a day stale. Combine the ` +
      `live Monarch data with their goals and context to give a precise, grounded answer.`;
    try {
      answer = await monarchMcp.answerWithMonarch({ system: monarchSystem, prompt, maxTokens: voice ? 400 : 1600 });
    } catch (err) {
      console.error('[chat] Monarch MCP path failed, falling back to local context:', err.message);
    }
  }
  if (answer == null) {
    answer = await llm.generateText({ system, prompt, temperature: 0.3, maxTokens: voice ? 400 : 1600 });
  }

  // Extract and record any recommendation the model flagged via <rec> tag.
  // Validate: reject query/analysis steps the model accidentally tagged
  // (e.g. "Pull Jan–Jun spend from Monarch" — not a user behavior change).
  const DATA_QUERY_RE = /^(pull|export|fetch|get|check|look|query|run|import|download|analyze|review|compare|examine|investigate|show|find|list|calculate)\b/i;
  const recMatch = answer.match(/<rec>([\s\S]*?)<\/rec>/i);
  if (recMatch) {
    const recTitle = recMatch[1].trim();
    answer = answer.replace(/<rec>[\s\S]*?<\/rec>/i, '').trim();
    if (recTitle && !DATA_QUERY_RE.test(recTitle)) {
      // Dedup by NUMBER-NORMALIZED title (matches the briefing path), so the same
      // recommendation with a slightly different percentage doesn't double-log.
      // recordRecommendation auto-links a follow-up commitment itself, since a
      // chat-sourced rec never carries an outcome_metric to auto-measure against.
      const recentStore = require('../store/recommendations');
      const normKey = recentStore.normalizeRecTitle(recTitle);
      recentStore.recentTitlesAll(7).then((recent) => {
        const alreadySeen = [...recent].some((t) => recentStore.normalizeRecTitle(t) === normKey);
        if (!alreadySeen) {
          recordRecommendation({ type: 'leverage', title: recTitle, surfacedIn: 'chat', commitmentSource: 'chat' }).catch(() => {});
        }
      }).catch(() => {
        recordRecommendation({ type: 'leverage', title: recTitle, surfacedIn: 'chat', commitmentSource: 'chat' }).catch(() => {});
      });
    }
  }

  // Extract an app ACTION the model chose to take (<action>{...}</action>) —
  // the same inline-tag pattern as <rec>, so natural language ("I switched to a
  // walk", "log my cold shower") changes real app state in the SAME turn that
  // answers, on both the text and voice paths. The caller executes it (it holds
  // the DB helpers); ask() only detects, validates, and strips the tag.
  const actions = parseActions(answer);
  if (actions.length) answer = answer.replace(/<action>[\s\S]*?<\/action>/gi, '').trim();

  return {
    answer,
    actions, // all validated actions for the caller to execute (may be 0, 1, or more)
    action: actions[0] ?? null, // back-compat: the first (or null)
    questionEmbedding, // for the caller to persist on the user turn (long-term recall)
    sources: docs.map((d) => ({
      title: d.title,
      author: d.author,
      url: d.url,
      similarity: d.similarity,
    })),
  };
}

const ACTION_WORKOUTS = new Set(['push', 'pull', 'zone2', 'mobility', 'intervals', 'rest']);
const ACTION_HABITS = new Set(['morningTM', 'afternoonTM', 'gratitude', 'coldShower', 'exercise']);
// Mirrors mobile's ACTIVITY_TYPES (WorkoutsPanel.tsx) — the "Log a different
// activity" picker's exact ids, so a voice-logged activity renders the same
// way a manually-logged one does.
const ACTION_ACTIVITIES = new Set([
  'walk', 'zone2', 'run', 'strength', 'intervals', 'mobility', 'basketball', 'soccer',
  'tennis', 'pickleball', 'dance', 'hike', 'swim', 'cycle', 'yoga', 'golf', 'ski', 'box', 'rest', 'other',
]);

/** Validate ONE parsed action object into the executor's shape, or null.
 *  Strict allowlist: an unknown type or a bad enum value yields null (no side
 *  effect), so a hallucinated tag can never touch app state. */
function validateAction(p) {
  if (!p || typeof p !== 'object') return null;
  const type = String(p.type || '').trim();
  if (type === 'swap_workout' && ACTION_WORKOUTS.has(p.workoutId)) return { action: 'swap_workout', workoutId: p.workoutId };
  if (type === 'log_habit' && ACTION_HABITS.has(p.habit)) return { action: 'log_habit', habit: p.habit };
  if (type === 'log_activity' && p.activityType) {
    const activityType = ACTION_ACTIVITIES.has(p.activityType) ? p.activityType : 'other'; // unknown category still logs, just uncategorized
    const durationMin = Number.isFinite(Number(p.durationMin)) && Number(p.durationMin) > 0 && Number(p.durationMin) <= 600
      ? Math.round(Number(p.durationMin)) : null;
    return {
      action: 'log_activity',
      activityType,
      durationMin,
      label: p.label ? String(p.label).slice(0, 120) : null,
      noWatch: p.noWatch === true,
    };
  }
  if (type === 'log_checkin') {
    const clamp = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null; };
    const mood = clamp(p.mood), energy = clamp(p.energy), focus = clamp(p.focus);
    if (mood == null && energy == null && focus == null) return null; // need at least one valid rating
    return { action: 'log_checkin', mood, energy, focus };
  }
  if (type === 'log_weight') {
    const weightLb = Number(p.weightLb);
    // A single value with no other fields — reject outright rather than store
    // garbage (unlike log_activity's durationMin, there's nothing else worth
    // keeping if this is nonsense).
    if (!Number.isFinite(weightLb) || weightLb < 50 || weightLb > 600) return null;
    return { action: 'log_weight', weightLb: Math.round(weightLb * 10) / 10 };
  }
  if (type === 'log_gratitude_text' && p.text && String(p.text).trim()) {
    return { action: 'log_gratitude_text', text: String(p.text).trim().slice(0, 1000) };
  }
  if (type === 'add_context' && p.text && String(p.text).trim()) return { action: 'add_context', text: String(p.text).slice(0, 200) };
  if (type === 'log_day_context' && p.text && String(p.text).trim()) {
    return { action: 'log_day_context', text: String(p.text).slice(0, 4000) };
  }
  if (type === 'set_reminder' && p.text && String(p.text).trim()) {
    // `at` is a naive local ISO the model computes from the CURRENT LOCAL TIME
    // we give it; the executor resolves + validates it (past/garbage → untimed).
    const at = typeof p.at === 'string' && p.at.trim() ? p.at.trim() : null;
    return { action: 'set_reminder', text: String(p.text).slice(0, 200), at };
  }
  if (type === 'add_chapter' && p.label && String(p.label).trim()) {
    return {
      action: 'add_chapter',
      kind: ['pregnancy', 'countdown', 'note'].includes(p.kind) ? p.kind : 'note',
      label: String(p.label).slice(0, 120),
      keyDate: p.keyDate || null,
      keyDateLabel: p.keyDateLabel || null,
    };
  }
  return null;
}

/**
 * Parse ALL <action> tags in a response into validated actions. One utterance can
 * carry more than one distinct action — most importantly a day recap that ALSO
 * gives tomorrow's context ("today was rough… and tomorrow I have a big
 * presentation") → log_day_context (today's journal) + add_context (a heads-up
 * that feeds tomorrow's brief). Exact duplicates are dropped and the list is
 * capped, so a hallucinated barrage can't touch state repeatedly.
 */
function parseActions(text) {
  const re = /<action>([\s\S]*?)<\/action>/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    let p;
    try { p = JSON.parse(m[1].trim()); } catch { continue; }
    const a = validateAction(p);
    if (!a) continue;
    const key = JSON.stringify(a);
    if (seen.has(key)) continue; // drop exact duplicate tags
    seen.add(key);
    out.push(a);
    if (out.length >= 3) break; // never run a barrage
  }
  return out;
}

/** Back-compat single-action parse — the first valid action, or null. */
function parseAction(text) {
  return parseActions(text)[0] ?? null;
}

module.exports = { ask, buildPrompt, isPersonalQuestion, isFinancialQuestion, personalSnapshot, renderSnapshot, parseAction, parseActions, looksLikeCommand };
