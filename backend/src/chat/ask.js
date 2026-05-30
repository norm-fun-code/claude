// Life chat: retrieval-augmented answers grounded in YOUR data.
// Fuses (a) the intelligence layer's findings, (b) semantically-retrieved
// documents from your library (Readwise + Notion + journal), and (c) the
// question, then asks the configured LLM to answer from that context only.
const llm = require('../llm');
const documents = require('../store/documents');
const findingsStore = require('../store/findings');

const SYSTEM = `You are NormOS — the user's personal chief of staff, executive coach, and data scientist.
Answer using ONLY the context provided (their own metrics, findings, and library).
Be concise, specific, and honest. Cite which source supports each claim (e.g. "[finding]" or the document title).
If the context is insufficient to answer, say so plainly and suggest what data would help.
Correlations are associations, not proof of cause — flag that when relevant.`;

function snippet(text, n = 400) {
  if (!text) return '';
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

/** Pure: assemble the prompt from retrieved context. Exported for testing. */
function buildPrompt({ question, findings = [], docs = [], history = [] }) {
  const parts = [];

  if (findings.length) {
    parts.push(
      'WHAT YOUR DATA CURRENTLY SHOWS (findings):\n' +
        findings.map((f) => `- [${f.type}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`).join('\n')
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

async function ask(question, { history = [], k = 8 } = {}) {
  if (!question || !question.trim()) throw new Error('question is required');

  // Retrieve library context via semantic search (best-effort).
  let docs = [];
  try {
    const [qVec] = await llm.embed([question]);
    if (qVec) docs = await documents.searchSimilar(qVec, { k });
  } catch (err) {
    console.error('[chat] retrieval failed:', err.message);
  }

  // Pull current findings as data context.
  let findings = [];
  try {
    findings = await findingsStore.listFindings({ status: 'open' });
  } catch {
    /* findings optional */
  }

  const { system, prompt } = buildPrompt({ question, findings, docs, history });
  const answer = await llm.generateText({ system, prompt, temperature: 0.3, maxTokens: 900 });

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
