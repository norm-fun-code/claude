// Life chat: retrieval-augmented answers grounded in YOUR data.
// Fuses (a) the intelligence layer's findings, (b) semantically-retrieved
// documents from your library (Readwise + Notion + journal), and (c) the
// question, then asks the configured LLM to answer from that context only.
const llm = require('../llm');
const documents = require('../store/documents');
const findingsStore = require('../store/findings');
const annotationsStore = require('../store/annotations');
const metricsStore = require('../store/metrics');
const intentionsStore = require('../store/intentions');
const { query: dbQuery } = require('../db');

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
- Cite the library items you draw on by their number, like (1) or (2, 5), matching the numbered "RELEVANT FROM YOUR LIBRARY" list.
- Be honest: if the context is thin, say what's missing. Correlations are associations, not proof of cause — flag that when relevant.

Aim for depth and usefulness over brevity, but never pad with filler.`;

// Cheap intent check: does the question seem to be about the user's own life /
// data / planning (vs. a pure idea/concept lookup)? Personal questions get the
// goals + metrics snapshot injected; idea questions stay library-only so we
// don't shoehorn personal numbers into "what did Seneca say about anger?".
const PERSONAL_RE = /\b(i|i'm|im|my|me|myself|mine|we|our|us)\b|\bshould i\b|\bam i\b|\bhow('?s| is| am| are)\b.*\b(my|me|i)\b|\b(focus|prioriti|goal|habit|sleep|hrv|energy|mood|spend|budget|save|saving|net worth|weight|train|workout|recover|quarter|this week|this month|this year|right now|today|lately|progress|on track)\b/i;

function isPersonalQuestion(q) {
  return PERSONAL_RE.test(q || '');
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
    for (const { domain, metric } of keys.slice(0, 25)) {
      const [recent, prior] = await Promise.all([
        metricsStore.dailyAggregate({ domain, metric, from: d7, agg: 'avg' }),
        metricsStore.dailyAggregate({ domain, metric, from: d14, to: d7, agg: 'avg' }),
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
            const goalsStr = Array.isArray(it.goals) && it.goals.length ? ` Focus goals: ${it.goals.join('; ')}.` : '';
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
function buildPrompt({ question, findings = [], docs = [], annotations = [], history = [], snapshot = null }) {
  const parts = [];

  // Personal goals + metric trends first (only present for personal questions).
  if (snapshot) {
    const block = renderSnapshot(snapshot);
    if (block) parts.push(block);
  }

  if (findings.length) {
    parts.push(
      'WHAT YOUR DATA CURRENTLY SHOWS (findings):\n' +
        findings.map((f) => `- [${f.type}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`).join('\n')
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

async function ask(question, { history = [], k = 14 } = {}) {
  if (!question || !question.trim()) throw new Error('question is required');

  // Hybrid retrieval: semantic search for themes + keyword search on author/title
  // for named entities (e.g. "Sahil Bloom") that embeddings alone miss.
  let docs = [];
  try {
    const [qVec] = await llm.embed([question]);
    const [semantic, keyword] = await Promise.all([
      qVec ? documents.searchSimilar(qVec, { k: 12 }) : Promise.resolve([]),
      documents.searchText(queryTerms(question), { k: 8 }),
    ]);
    // Keyword (named-entity) hits first so they're never crowded out.
    docs = mergeUnique(keyword, semantic).slice(0, k);
  } catch (err) {
    console.error('[chat] retrieval failed:', err.message);
  }

  // Pull current findings + recent life context.
  let findings = [];
  let annotations = [];
  try {
    findings = await findingsStore.listFindings({ status: 'open' });
  } catch {
    /* findings optional */
  }
  try {
    const from = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    annotations = await annotationsStore.listAnnotations({ from, limit: 20 });
  } catch {
    /* annotations optional */
  }

  // For personal/planning questions, ground the answer in real goals + metric
  // trends. Idea/concept questions skip this so we don't shoehorn in numbers.
  let snapshot = null;
  if (isPersonalQuestion(question)) {
    try {
      snapshot = await personalSnapshot();
    } catch (err) {
      console.error('[chat] snapshot failed:', err.message);
    }
  }

  const { system, prompt } = buildPrompt({ question, findings, docs, annotations, history, snapshot });
  const answer = await llm.generateText({ system, prompt, temperature: 0.3, maxTokens: 1600 });

  return {
    answer,
    sources: docs.map((d) => ({
      title: d.title,
      author: d.author,
      url: d.url,
      similarity: d.similarity,
    })),
  };
}

module.exports = { ask, buildPrompt, isPersonalQuestion, personalSnapshot, renderSnapshot };
