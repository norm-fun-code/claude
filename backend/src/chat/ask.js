// Life chat: retrieval-augmented answers grounded in YOUR data.
// Fuses (a) the intelligence layer's findings, (b) semantically-retrieved
// documents from your library (Readwise + Notion + journal), and (c) the
// question, then asks the configured LLM to answer from that context only.
const llm = require('../llm');
const documents = require('../store/documents');
const findingsStore = require('../store/findings');
const annotationsStore = require('../store/annotations');

const SYSTEM = `You are NormOS — the user's personal chief of staff, executive coach, and data scientist.
Answer using ONLY the context provided (their own metrics, findings, and library highlights).

Answer the question that was asked — and ONLY that. Do not volunteer connections
to the user's personal metrics, finances, habits, or "findings" unless the
question is explicitly about their own life or data. For a question about ideas,
people, books, or concepts, answer purely from the library and ignore the
metrics/findings context entirely. Never shoehorn in their income, spending,
net worth, or health numbers as a "tie-in."

Write a thorough, genuinely useful answer:
- Lead with a direct answer, then develop it with specifics and concrete examples drawn from the context.
- Synthesize ACROSS multiple sources — surface patterns, themes, and tensions between ideas rather than summarizing one item.
- Use clean Markdown: \`##\` section headers when it helps, **bold** for key terms, and \`-\` bullet lists for multiple points. Keep paragraphs to 2-4 sentences.
- Cite the library items you draw on by their number, like (1) or (2, 5), matching the numbered "RELEVANT FROM YOUR LIBRARY" list.
- Be honest: if the context is thin, say what's missing. Correlations are associations, not proof of cause — flag that when relevant.

Aim for depth and usefulness over brevity, but never pad with filler.`;

function snippet(text, n = 400) {
  if (!text) return '';
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

/** Pure: assemble the prompt from retrieved context. Exported for testing. */
function buildPrompt({ question, findings = [], docs = [], annotations = [], history = [] }) {
  const parts = [];

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

  const { system, prompt } = buildPrompt({ question, findings, docs, annotations, history });
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

module.exports = { ask, buildPrompt };
