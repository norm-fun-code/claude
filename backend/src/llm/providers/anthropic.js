// Anthropic (Claude) provider — chat/reasoning quality for coaching & analysis.
// Claude has no embeddings API, so embeddings come from the embed provider.
const axios = require('axios');

async function generateText({ system, prompt, maxTokens = 4096, timeoutMs = 110000 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

  // Every caller's system prompt is a fixed string (built once per module, no
  // per-request interpolation), so it's always safe to mark as a cache
  // breakpoint — callers that repeat it verbatim (briefing, chat, review) get
  // cheap cache reads; anything below the model's minimum cacheable prefix
  // just silently doesn't cache (no error, no extra cost).
  const systemBlock = system
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : undefined;

  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      system: systemBlock,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      timeout: timeoutMs,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );

  logUsage(model, data.usage);

  // Thinking blocks have type 'thinking' — only join text blocks.
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
}

// Visibility into cost/caching — previously `usage` was discarded entirely,
// so there was no way to tell if cache_control was doing anything or which
// calls dominate spend.
function logUsage(model, usage) {
  if (!usage) return;
  const { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } = usage;
  console.log(
    `[anthropic] ${model} in=${input_tokens ?? 0} out=${output_tokens ?? 0}` +
      ` cacheWrite=${cache_creation_input_tokens ?? 0} cacheRead=${cache_read_input_tokens ?? 0}`
  );
}

module.exports = { generateText };
