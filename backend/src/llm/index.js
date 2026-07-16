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

function getChatProvider(name) {
  const providerName = name || chatProviderName();
  const p = CHAT[providerName];
  if (!p) throw new Error(`Unknown LLM_PROVIDER: ${providerName}`);
  return p;
}

function getEmbedProvider() {
  const p = EMBED[embedProviderName()];
  if (!p || !p.embed) throw new Error(`Embed provider '${embedProviderName()}' unavailable`);
  return p;
}

// `opts.provider` pins a single call to a specific provider regardless of the
// global LLM_PROVIDER — for a call that depends on a feature only one
// provider has (e.g. briefing-ai.js's chief-brief call needs Anthropic's
// Structured Outputs + adaptive thinking), routing through whichever
// provider happens to be globally configured would silently break or
// misbehave. Callers pass the provider by name (e.g. `provider: 'anthropic'`)
// instead of importing a provider module directly, so this remains the one
// place that resolves provider names to implementations.
async function generateText({ provider, ...opts } = {}) {
  return getChatProvider(provider).generateText(opts);
}

async function embed(texts) {
  if (!texts || texts.length === 0) return [];
  return getEmbedProvider().embed(texts);
}

// Re-exported so callers that specifically target the Anthropic provider
// (e.g. briefing-ai.js's chief-brief call) can distinguish a refusal or a
// max_tokens truncation from a generic failure without reaching into
// './providers/anthropic' directly.
const { AnthropicRefusalError, AnthropicMaxTokensError } = anthropic;

module.exports = {
  generateText, embed, chatProviderName, embedProviderName,
  AnthropicRefusalError, AnthropicMaxTokensError,
};
