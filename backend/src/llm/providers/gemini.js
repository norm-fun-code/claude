// Gemini provider (chat + 768-dim embeddings via gemini-embedding-001).
const axios = require('axios');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

function key() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY not set');
  return k;
}

async function generateText({ system, prompt, temperature = 0.4, maxTokens = 1024 }) {
  const model = process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash';
  const { data } = await axios.post(
    `${BASE}/models/${model}:generateContent?key=${key()}`,
    {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    },
    // Fail cleanly rather than hang forever if Gemini stalls; the caller wraps
    // this in its own budget too, but a transport timeout gives a real error.
    { timeout: Number(process.env.GEMINI_TIMEOUT_MS || 55000) }
  );
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
}

// Current Gemini embedding models (gemini-embedding-001/2) only expose
// :embedContent (the synchronous :batchEmbedContents was removed), and default
// to 3072 dims — so we request 768 to match the documents.embedding column.
// One request per text, capped concurrency to stay under rate limits; a failed
// item returns null so the caller can retry just those.
async function embed(texts) {
  const model = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
  const dim = Number(process.env.GEMINI_EMBED_DIM || 768);
  const conc = Number(process.env.GEMINI_EMBED_CONCURRENCY || 8);
  const out = [];
  for (let i = 0; i < texts.length; i += conc) {
    const chunk = texts.slice(i, i + conc);
    const vectors = await Promise.all(
      chunk.map(async (t) => {
        try {
          const { data } = await axios.post(
            `${BASE}/models/${model}:embedContent?key=${key()}`,
            { content: { parts: [{ text: t }] }, outputDimensionality: dim }
          );
          return data.embedding?.values || null;
        } catch {
          return null;
        }
      })
    );
    out.push(...vectors);
  }
  return out;
}

module.exports = { generateText, embed, embedDim: 768 };
