// Briefing AI: summarizes newsletters, flags urgent email, and writes the
// quote/Notion reflections for the daily briefing.
//
// Provider-agnostic — goes through the shared `llm` layer, so whichever model
// you choose (Claude / Gemini / local Ollama) writes your briefing. Previously
// this was hard-wired to Gemini regardless of LLM_PROVIDER.
const llm = require('../llm');

const SYSTEM =
  'You prepare a concise personal morning briefing. Analyze the provided emails, ' +
  'quote, and Notion wisdom. Return ONLY a single valid JSON object — no markdown, ' +
  'no code fences, no commentary.';

function buildPrompt(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents, wellbeingContext = '') {
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

  return `Today is ${currentDay}.

Today's workout: ${workoutPlan.type}${workoutPlan.duration ? ` (${workoutPlan.duration})` : ''}

Today's calendar:
${calendarSection}

Recent wellbeing (last 7 days): ${wellbeingContext || 'no recent check-in data'}

Today's quote/principle:
"${quote}"

Today's Notion wisdom:
${notionText}

Unread emails (${emailData.length} threads):
${emailSection}

---

Return ONLY valid JSON with EXACTLY these fields:

{
  "newsletters": [
    { "name": "Sender", "title": "Edition title", "summary": "150-200 word dense summary — every data point, dollar figure, percentage, company, and key argument; crisp prose, no bullets, no filler." }
  ],
  "urgentEmails": [
    { "from": "sender", "subject": "subject", "action": "1-2 sentences on what action is needed and why it's urgent" }
  ],
  "financeSummary": ["1-3 bullets of finance/market/economic news from the emails"],
  "quoteInsight": "2 sentences drawing out the deeper idea or principle in the quote",
  "notionInsight": "2 sentences drawing out the key idea in the Notion content"
}

Rules:
- newsletters: include digests/publications; exclude personal email, receipts, notifications. Go deep — extract every named company, person, statistic, and dollar amount.
- urgentEmails: only emails needing a response/action today.
- financeSummary: 1-3 items; never empty.
- quoteInsight / notionInsight: draw out the idea as practical wisdom for living well. You MAY gently tailor it to the user's recent inner state shown in "Recent wellbeing" — e.g. if focus or mood is low, or they're slipping on a habit like gratitude, lean the reflection toward that theme. But do this WITHOUT naming the data ("your focus is low"); just let the chosen angle resonate. Do NOT reference their calendar, specific tasks, schedule, "today", their job/profession, or their finances. Never write "as a [profession]" or tie it to a meeting/event. Speak to the human, not the day.`;
}

/** Robustly pull a JSON object out of an LLM response (handles fences/prose). */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(s);
  } catch {
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try { return JSON.parse(s.slice(i, j + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

const EMPTY = {
  newsletters: [], urgentEmails: [], financeSummary: [], quoteInsight: '', notionInsight: '',
};

async function generateBriefing(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents, wellbeingContext = '') {
  const prompt = buildPrompt(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents, wellbeingContext);

  let text = '';
  try {
    text = await llm.generateText({ system: SYSTEM, prompt, temperature: 0.4, maxTokens: 8192 });
  } catch (err) {
    console.error('[briefing-ai] generation failed:', err.message);
    return { ...EMPTY };
  }

  const parsed = extractJson(text);
  if (!parsed) {
    console.error('[briefing-ai] response was not valid JSON; returning empty briefing.');
    return { ...EMPTY };
  }

  return {
    newsletters: Array.isArray(parsed.newsletters) ? parsed.newsletters : [],
    urgentEmails: Array.isArray(parsed.urgentEmails) ? parsed.urgentEmails : [],
    financeSummary: Array.isArray(parsed.financeSummary) ? parsed.financeSummary : [],
    quoteInsight: typeof parsed.quoteInsight === 'string' ? parsed.quoteInsight : '',
    notionInsight: typeof parsed.notionInsight === 'string' ? parsed.notionInsight : '',
  };
}

module.exports = { generateBriefing, buildPrompt, extractJson };
