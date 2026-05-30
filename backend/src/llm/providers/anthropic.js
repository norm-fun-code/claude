// Anthropic (Claude) provider — chat/reasoning quality for coaching & analysis.
// Claude has no embeddings API, so embeddings come from the embed provider.
const axios = require('axios');

async function generateText({ system, prompt, temperature = 0.4, maxTokens = 1024 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );

  return (data.content || []).map((b) => b.text || '').join('');
}

module.exports = { generateText };
