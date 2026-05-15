require('dotenv').config();
const axios = require('axios');

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

async function test() {
  const apiKey = process.env.GEMINI_API_KEY;
  console.log('API key present:', !!apiKey);

  const res = await axios.post(
    `${GEMINI_ENDPOINT}?key=${apiKey}`,
    {
      contents: [{ parts: [{ text: 'Return a JSON object with a single field: {"hello": "world"}' }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 256,
        responseMimeType: 'application/json',
      },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );

  console.log('HTTP status:', res.status);
  console.log('Finish reason:', res.data.candidates?.[0]?.finishReason);
  console.log('Raw text:', res.data.candidates?.[0]?.content?.parts?.[0]?.text);
  console.log('Full response:', JSON.stringify(res.data, null, 2));
}

test().catch(console.error);
