// Anthropic (Claude) provider — chat/reasoning quality for coaching & analysis.
// Claude has no embeddings API, so embeddings come from the embed provider.
const axios = require('axios');

async function generateText({ system, prompt, maxTokens = 4096, timeoutMs = 110000 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      system,
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

  // Thinking blocks have type 'thinking' — only join text blocks.
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
}

module.exports = { generateText };
