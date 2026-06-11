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

function buildPrompt(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents, wellbeingContext = '', annotationsContext = '') {
  // Input size wasn't the timeout cause (the proven Apps Script sends 15K/email
  // and is fine) — OUTPUT length was. So allow a generous 15K/email like that
  // setup, with a total budget as a safety net against a huge unread pile.
  const PER_EMAIL = Number(process.env.EMAIL_PROMPT_CHARS || 15000);
  const TOTAL_BUDGET = Number(process.env.EMAIL_PROMPT_TOTAL || 200000);
  let used = 0;
  const emailSection = emailData
    .map((e, i) => {
      if (used >= TOTAL_BUDGET) return null;
      const body = String(e.body || '').slice(0, PER_EMAIL);
      used += body.length;
      return `--- Email ${i + 1} ---\nFrom: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}\nBody:\n${body}`;
    })
    .filter(Boolean)
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

Active life context: ${annotationsContext || 'none'}

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
    { "name": "Sender", "title": "Edition title", "summary": "A dense 5-10 sentence paragraph summarizing the substance of THIS specific email. Extract hard numbers, percentages, dollar amounts, named companies, and specific arguments. Emulate the deep, factual style of premium financial newsletters like The Daily Upside. Crisp prose, no bullets, no filler." }
  ],
  "urgentEmails": [
    { "from": "sender", "subject": "subject", "action": "1-2 sentences on what action is needed and why it's urgent" }
  ],
  "financeSummary": ["1-3 bullets of finance/market/economic news from the emails"],
  "quoteInsight": "2 sentences drawing out the deeper idea or principle in the quote",
  "notionQuote": "the single most resonant COMPLETE sentence or passage from the Notion wisdom above — verbatim, not cut off mid-thought, not a heading or intro fragment ending in a colon",
  "notionInsight": "2 sentences drawing out the key idea in the SPECIFIC notionQuote you selected (the commentary must match that exact passage)"
}

Rules:
- newsletters: include digests/publications; exclude personal email, receipts, notifications. Go deep — extract every named company, person, statistic, and dollar amount.
- urgentEmails: only emails needing a response/action today.
- financeSummary: 1-3 items; never empty.
- notionQuote: pick a self-contained, meaningful line — never a title, never an intro that trails off (e.g. "Rather than trying to find someone who will:"). If the best idea spans a sentence, quote the whole sentence.
- quoteInsight / notionInsight: draw out the idea as practical wisdom for living well. notionInsight MUST be about the notionQuote you chose, not the page in general. You MAY gently tailor it to the user's recent inner state shown in "Recent wellbeing" — e.g. if focus or mood is low, or they're slipping on a habit like gratitude, lean the reflection toward that theme. But do this WITHOUT naming the data ("your focus is low"); just let the chosen angle resonate. Do NOT reference their calendar, specific tasks, schedule, "today", their job/profession, or their finances. Never write "as a [profession]" or tie it to a meeting/event. Speak to the human, not the day.`;
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
  newsletters: [], urgentEmails: [], financeSummary: [], quoteInsight: '', notionQuote: '', notionInsight: '',
};

async function generateBriefing(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents, wellbeingContext = '', annotationsContext = '') {
  const prompt = buildPrompt(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents, wellbeingContext, annotationsContext);

  let text = '';
  try {
    // The full briefing is output-heavy (several dense newsletter summaries +
    // urgent emails + finance bullets + insights) and legitimately takes ~60s.
    // Give it room: low temp for focus, 8K output cap, and the caller allows 90s.
    text = await llm.generateText({ system: SYSTEM, prompt, temperature: 0.2, maxTokens: 8192 });
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
    notionQuote: typeof parsed.notionQuote === 'string' ? parsed.notionQuote : '',
    notionInsight: typeof parsed.notionInsight === 'string' ? parsed.notionInsight : '',
  };
}

module.exports = { generateBriefing, buildPrompt, extractJson };
