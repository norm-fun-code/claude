// Anthropic (Claude) provider — chat/reasoning quality for coaching & analysis.
// Claude has no embeddings API, so embeddings come from the embed provider.
const axios = require('axios');
const https = require('https');

// A briefing build makes several sequential/parallel calls to this same host;
// without a keep-alive agent, axios opens a fresh TCP+TLS connection per call
// (a real, avoidable ~0.3-1s of handshake latency each time). One shared agent
// reuses the socket across calls for the lifetime of the process.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });

async function generateText({ system, prompt, maxTokens = 4096, timeoutMs = 110000, fast = false, model: modelOverride }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  // `fast` routes clear commands (log a habit, swap a workout, set a reminder)
  // to a quicker model with NO extended thinking — those need an acknowledgment,
  // not reasoning. Real questions keep the default reasoning model + adaptive
  // thinking below, so nothing loses power. Override either with env vars.
  const model = modelOverride
    || (fast ? (process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5-20251001') : (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'));

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

  const body = {
    model,
    max_tokens: maxTokens,
    system: systemBlock,
    messages: [{ role: 'user', content: prompt }],
  };
  // Extended thinking only on the reasoning path; the fast command path omits it
  // entirely (biggest single latency saving for short acknowledgments).
  if (!fast) body.thinking = { type: 'adaptive' };

  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    body,
    {
      timeout: timeoutMs,
      httpsAgent: keepAliveAgent,
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
