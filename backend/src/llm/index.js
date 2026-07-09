// Unified LLM interface. Chat and embeddings can use different providers:
//   LLM_PROVIDER   chat/reasoning  — anthropic | gemini
//   EMBED_PROVIDER embeddings      — gemini  (must be 768-dim)
//
// Defaults: Claude for chat if ANTHROPIC_API_KEY is set, else Gemini; Gemini for
// embeddings (text-embedding-004 matches the documents.embedding vector(768)).
const gemini = require('./providers/gemini');
const anthropic = require('./providers/anthropic');

const CHAT = { gemini, anthropic };
const EMBED = { gemini };

function chatProviderName() {
  if (process.env.LLM_PROVIDER) return process.env.LLM_PROVIDER;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'gemini';
}

function embedProviderName() {
  return process.env.EMBED_PROVIDER || 'gemini';
}

function getChatProvider() {
  const p = CHAT[chatProviderName()];
  if (!p) throw new Error(`Unknown LLM_PROVIDER: ${chatProviderName()}`);
  return p;
}

function getEmbedProvider() {
  const p = EMBED[embedProviderName()];
  if (!p || !p.embed) throw new Error(`Embed provider '${embedProviderName()}' unavailable`);
  return p;
}

async function generateText(opts) {
  return getChatProvider().generateText(opts);
}

async function embed(texts) {
  if (!texts || texts.length === 0) return [];
  return getEmbedProvider().embed(texts);
}

module.exports = { generateText, embed, chatProviderName, embedProviderName };
