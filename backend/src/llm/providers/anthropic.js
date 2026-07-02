// Anthropic (Claude) provider — chat/reasoning quality for coaching & analysis.
// Claude has no embeddings API, so embeddings come from the embed provider.
const axios = require('axios');

async function generateText({ system, prompt, maxTokens = 4096, timeoutMs = 110000 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

  // Always safe to mark the system prompt as a cache breakpoint, whether or
  // not it happens to repeat verbatim: a prefix that changes call to call
  // (e.g. chat/review, which append a periodically-regenerated self-model
  // string) just misses the cache like it always did; anything below the
  // model's minimum cacheable prefix silently doesn't cache either — neither
  // case is an error or adds cost. It only pays off for callers whose prompt
  // is genuinely byte-identical across calls (e.g. briefing-ai.js's SYSTEM).
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
