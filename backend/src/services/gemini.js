const axios = require('axios');

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

function buildPrompt(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents) {
  const emailSection = emailData
    .map(
      (e, i) =>
        `--- Email ${i + 1} ---\nFrom: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}\nBody:\n${e.body}`
    )
    .join('\n\n');

  const calendarSection =
    calendarEvents.length > 0
      ? calendarEvents
          .map((e) => `- ${e.allDay ? '[All Day]' : `${e.startTime}–${e.endTime}`}: ${e.title}`)
          .join('\n')
      : 'No events today.';

  return `You are an AI assistant helping prepare a personal morning briefing. Today is ${currentDay}.

Today's workout: ${workoutPlan.type}${workoutPlan.duration ? ` (${workoutPlan.duration})` : ''}

Today's calendar:
${calendarSection}

Today's quote/principle:
"${quote}"

Today's Notion wisdom:
${notionText}

Unread emails (${emailData.length} threads):
${emailSection}

---

Analyze the above and return a JSON object with EXACTLY these fields. Return ONLY valid JSON — no markdown, no code fences, no explanation:

{
  "newsletters": [
    {
      "name": "Newsletter sender name",
      "title": "Article or edition title",
      "summary": "150-200 word summary — detailed enough to replace reading the original. Extract every specific data point, dollar figure, percentage, company name, and key argument. Cover the main story, supporting evidence, and any implications or conclusions the author draws. Write in crisp, dense prose — no bullet points, no fluff, no filler sentences."
    }
  ],
  "urgentEmails": [
    {
      "from": "sender name",
      "subject": "email subject",
      "action": "1-2 sentence description of what action is needed and why it's urgent"
    }
  ],
  "financeSummary": [
    "Bullet point 1 about any financial/economic/market news",
    "Bullet point 2",
    "Bullet point 3"
  ],
  "quoteInsight": "2 sentences connecting the quote to today's context, workout, or calendar",
  "notionInsight": "2 sentences reflecting on the Notion content and how it applies to today"
}

Rules:
- newsletters: Include emails that appear to be newsletters, digests, or content publications. Exclude personal emails, receipts, and notifications. For each newsletter, go deep — extract every named company, person, statistic, dollar amount, and key argument from the email body.
- urgentEmails: Include emails that require a response or action today. Exclude newsletters and FYI emails.
- financeSummary: Extract any finance, market, economic, or business news from emails. If none, return 1-3 general observations about the day's financial context based on what's available. Never return an empty array — always have 1-3 items.
- quoteInsight: Be specific, not generic. Reference the actual quote content.
- notionInsight: Be specific, not generic. Reference the actual Notion content.`;
}

async function generateBriefing(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const prompt = buildPrompt(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents);

  const res = await axios.post(
    `${GEMINI_ENDPOINT}?key=${apiKey}`,
    {
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 16384,
        responseMimeType: 'application/json',
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
    }
  );

  const rawText = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  console.log('[gemini] raw response length:', rawText.length);
  console.log('[gemini] first 300 chars:', rawText.slice(0, 300));
  console.log('[gemini] finish reason:', res.data.candidates?.[0]?.finishReason);

  // Strip any accidental markdown fences
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error('Gemini returned non-JSON:', cleaned.slice(0, 500));
    throw new Error('Gemini did not return valid JSON');
  }

  // Validate and provide defaults for each field
  return {
    newsletters: Array.isArray(parsed.newsletters) ? parsed.newsletters : [],
    urgentEmails: Array.isArray(parsed.urgentEmails) ? parsed.urgentEmails : [],
    financeSummary: Array.isArray(parsed.financeSummary) ? parsed.financeSummary : [],
    quoteInsight: typeof parsed.quoteInsight === 'string' ? parsed.quoteInsight : '',
    notionInsight: typeof parsed.notionInsight === 'string' ? parsed.notionInsight : '',
  };
}

module.exports = { generateBriefing };
