// Gemini provider (chat + 768-dim embeddings via text-embedding-004).
const axios = require('axios');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

function key() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY not set');
  return k;
}

async function generateText({ system, prompt, temperature = 0.4, maxTokens = 1024 }) {
  const model = process.env.GEMINI_CHAT_MODEL || 'gemini-3.1';
  const { data } = await axios.post(
    `${BASE}/models/${model}:generateContent?key=${key()}`,
    {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    }
  );
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
}

async function embed(texts) {
  const model = process.env.GEMINI_EMBED_MODEL || 'text-embedding-004';
  const { data } = await axios.post(`${BASE}/models/${model}:batchEmbedContents?key=${key()}`, {
    requests: texts.map((t) => ({
      model: `models/${model}`,
      content: { parts: [{ text: t }] },
    })),
  });
  return (data.embeddings || []).map((e) => e.values);
}

module.exports = { generateText, embed, embedDim: 768 };
