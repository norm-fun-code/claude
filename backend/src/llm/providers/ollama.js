// Ollama provider — fully local LLM + embeddings, so your most sensitive data
// never leaves the machine. Run `ollama serve` with a model pulled.
const axios = require('axios');

function baseUrl() {
  return process.env.OLLAMA_URL || 'http://localhost:11434';
}

async function generateText({ system, prompt, temperature = 0.4, jsonMode = false }) {
  const model = process.env.OLLAMA_MODEL || 'llama3.1';
  const { data } = await axios.post(`${baseUrl()}/api/generate`, {
    model,
    system,
    prompt,
    stream: false,
    options: { temperature },
    // Constrains sampling to syntactically valid JSON — see gemini.js's
    // equivalent responseMimeType for why this matters.
    ...(jsonMode ? { format: 'json' } : {}),
  });
  return data.response ?? '';
}

async function embed(texts) {
  const model = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
  const out = [];
  for (const t of texts) {
    const { data } = await axios.post(`${baseUrl()}/api/embeddings`, { model, prompt: t });
    out.push(data.embedding);
  }
  return out;
}

module.exports = { generateText, embed, embedDim: 768 };
