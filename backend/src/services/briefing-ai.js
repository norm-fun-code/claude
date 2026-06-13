// Briefing AI: summarizes newsletters, flags urgent email, and writes the
// quote/Notion reflections for the daily briefing.
//
// Provider-agnostic — goes through the shared `llm` layer, so whichever model
// you choose (Claude / Gemini / local Ollama) writes your briefing. Previously
// this was hard-wired to Gemini regardless of LLM_PROVIDER.
const llm = require('../llm');

const SYSTEM =
  'You are NormOS — the user\'s chief of staff and data scientist. You have access to their body ' +
  '(HRV, sleep, recovery), money (net worth, cashflow, spend), calendar, inbox, goals, and a ' +
  'confirmed model of what moves THEIR metrics. Each morning you write the brief as a person who ' +
  'knows them, not a report: you open with the single most important thing about today, then give ' +
  'them the highest-leverage action, the one risk trending wrong, and the one number that changed. ' +
  'Cross-domain synthesis is the point — connect body↔money↔focus when the data supports it, never ' +
  'when it doesn\'t. You name actual numbers and trajectories, and tie advice to confirmed ' +
  'experiments when relevant. Your voice is sharp, caring, blunt, and numerate — no flattery, no ' +
  'filler, respects their time. You never invent a number or a connection. ' +
  'Return ONLY a single valid JSON object — no markdown, no code fences, no commentary.';

function buildPrompt(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents, wellbeingContext = '', annotationsContext = '', recoveryContext = '', experimentsContext = '', selfModel = '', leverageContext = '') {
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

  return `${selfModel ? selfModel + '\n\n---\n\n' : ''}Today is ${currentDay}.

Today's workout: ${workoutPlan.type}${workoutPlan.duration ? ` (${workoutPlan.duration})` : ''}
${recoveryContext ? `Recovery status: ${recoveryContext}` : ''}

Today's calendar:
${calendarSection}

Recent wellbeing (last 7 days): ${wellbeingContext || 'no recent check-in data'}

Active life context: ${annotationsContext || 'none'}

${experimentsContext ? `EXPERIMENT RESULTS (NormOS data science):\n${experimentsContext}\n\n` : ''}${leverageContext ? `${leverageContext}\n\n` : ''}Today's quote/principle:
"${quote}"

Today's Notion wisdom:
${notionText}

Unread emails (${emailData.length} threads):
${emailSection}

---

Return ONLY valid JSON with EXACTLY these fields:

{
  "chiefBrief": {
    "synthesis": "ONE sentence (20-35 words): the single most important thing about today, synthesized ACROSS domains (body, money, focus, calendar). This is the headline a chief of staff opens with. Name a real number. Connect domains only when the data supports it — never invent a tie-in.",
    "action": "THE ACTION (1-2 sentences). The highest-leverage thing to do NOW — draw from the HIGHEST-LEVERAGE ACTIONS block (leverage engine) above when present. Concrete and doable today. Tie to a confirmed experiment when relevant ('Zone 2 yesterday → your HRV is up, as we proved').",
    "risk": "THE RISK (1-2 sentences). The ONE thing trending wrong — draw from the TRENDING WRONG block (at-risk forecasts) or a slipping habit / declining metric in the self-model. Name the trajectory. If genuinely nothing is at risk, say what to protect to keep it that way.",
    "move": "THE MOVE (1-2 sentences). One number that CHANGED and why it matters — an HRV/sleep/spend/cashflow shift, a habit rate move, or an experiment verdict. Name the before→after and the implication."
  },
  "morningFocus": "1-2 sentences (35-60 words). Chief-of-staff situation report. Use the SELF-MODEL (7-day averages, habit trends, active experiments, confirmed patterns) as your primary source — it always has context even before today's check-in or watch sync. Supplement with any real-time recovery/wellbeing data if present. Name the actual numbers from the self-model (HRV ms, sleep hours, habit rates). Tell them what it means and the one thing that matters most today. Always generate this — never return empty string.",
  "experimentCallout": "If there is a confirmed OR refuted experiment result, write 1-2 sentences calling it out directly: 'NormOS confirmed...' or 'NormOS refuted...'. Name the percent change and what it means for their behavior. If multiple, pick the most impactful one. Empty string if no completed experiments.",
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
- chiefBrief: this is the centerpiece — write it as a person who KNOWS them, not a report. Sharp, caring, blunt, numerate. Draw the ACTION from the leverage engine, the RISK from at-risk forecasts/slipping habits, the MOVE from a real number that changed. Cross-domain synthesis (body↔money↔focus) is the point of the opening synthesis line — but only when the data genuinely supports it. Name actual numbers and trajectories everywhere. Never invent a tie-in or a number. Always generate all four fields.
- experimentCallout: scan the EXPERIMENT RESULTS block. If there's a confirmed or refuted result, call it out directly and specifically — "NormOS confirmed that [hypothesis] — [metric] improved/declined by X%." If refuted, say so clearly. This is a big deal: it's real data science on their own life. Make it feel like a discovery. Empty string if no completed results.
- morningFocus: draw primarily from the SELF-MODEL (7-day HRV avg, sleep avg, habit adherence rates, active experiments, confirmed correlations). Real-time recovery/wellbeing data from today's check-in supplements when available but is not required. Name real numbers from the self-model. If a habit rate is slipping, name it. If HRV trend is down, say so. This should feel like the one sentence a trusted advisor who knows your week would say before you start your day. Never mention finances, calendar events, or emails here. Always generate something — the self-model always has enough context.
- newsletters: include digests/publications; exclude personal email, receipts, notifications. Go deep — extract every named company, person, statistic, and dollar amount.
- urgentEmails: only emails needing a response/action today.
- financeSummary: 1-3 items; never empty.
- notionQuote: pick a self-contained, meaningful line — never a title, never an intro that trails off (e.g. "Rather than trying to find someone who will:"). If the best idea spans a sentence, quote the whole sentence.
- quoteInsight / notionInsight: first sentence draws out the core idea as lived wisdom. Second sentence makes it land for where this person is RIGHT NOW — if their energy has been low, connect to restoration and sustainable effort; if a habit is slipping, speak to consistency and small wins; if recovery is yellow/red, speak to patience and trusting the process. Do this WITHOUT naming their data ("your HRV is 38") — just let the angle feel personally chosen. Do NOT reference their calendar, specific tasks, schedule, "today", their job/profession, or their finances. Speak to the human, not the day.`;
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
  morningFocus: '', chiefBrief: null, experimentCallout: '', newsletters: [], urgentEmails: [], financeSummary: [], quoteInsight: '', notionQuote: '', notionInsight: '',
};

async function generateBriefing(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents, wellbeingContext = '', annotationsContext = '', recoveryContext = '', experimentsContext = '', selfModel = '', leverageContext = '') {
  const prompt = buildPrompt(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents, wellbeingContext, annotationsContext, recoveryContext, experimentsContext, selfModel, leverageContext);

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

  // Structured chief-of-staff brief: only keep it if all four blocks are present
  // strings, so the card can trust the shape (else null → card hides).
  const cb = parsed.chiefBrief;
  const chiefBrief =
    cb && typeof cb === 'object' &&
    ['synthesis', 'action', 'risk', 'move'].every((k) => typeof cb[k] === 'string' && cb[k].trim())
      ? { synthesis: cb.synthesis, action: cb.action, risk: cb.risk, move: cb.move }
      : null;

  return {
    morningFocus: typeof parsed.morningFocus === 'string' ? parsed.morningFocus : '',
    chiefBrief,
    experimentCallout: typeof parsed.experimentCallout === 'string' ? parsed.experimentCallout : '',
    newsletters: Array.isArray(parsed.newsletters) ? parsed.newsletters : [],
    urgentEmails: Array.isArray(parsed.urgentEmails) ? parsed.urgentEmails : [],
    financeSummary: Array.isArray(parsed.financeSummary) ? parsed.financeSummary : [],
    quoteInsight: typeof parsed.quoteInsight === 'string' ? parsed.quoteInsight : '',
    notionQuote: typeof parsed.notionQuote === 'string' ? parsed.notionQuote : '',
    notionInsight: typeof parsed.notionInsight === 'string' ? parsed.notionInsight : '',
  };
}

const EMAIL_SYSTEM =
  'You summarize unread email for a personal briefing. Analyze the provided emails. ' +
  'Return ONLY a single valid JSON object — no markdown, no code fences, no commentary.';

/**
 * Focused mid-day refresh: ONLY the email-derived sections (newsletters,
 * urgent emails, finance bullets) — no quote/Notion reflections, which are
 * day-locked anyway. Much smaller output than the full briefing, so it returns
 * in a fraction of the time. Powers GET /api/briefing/live.
 */
async function generateEmailBriefs(emailData) {
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

  const prompt = `Unread emails (${emailData.length} threads):
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
  "financeSummary": ["1-3 bullets of finance/market/economic news from the emails"]
}

Rules:
- newsletters: include digests/publications; exclude personal email, receipts, notifications. Go deep — extract every named company, person, statistic, and dollar amount.
- urgentEmails: only emails needing a response/action today.
- financeSummary: 1-3 items; never empty.`;

  let text = '';
  try {
    text = await llm.generateText({ system: EMAIL_SYSTEM, prompt, temperature: 0.2, maxTokens: 8192 });
  } catch (err) {
    console.error('[briefing-ai] email-brief generation failed:', err.message);
    return null;
  }

  const parsed = extractJson(text);
  if (!parsed) {
    console.error('[briefing-ai] email-brief response was not valid JSON.');
    return null;
  }

  return {
    newsletters: Array.isArray(parsed.newsletters) ? parsed.newsletters : [],
    urgentEmails: Array.isArray(parsed.urgentEmails) ? parsed.urgentEmails : [],
    financeSummary: Array.isArray(parsed.financeSummary) ? parsed.financeSummary : [],
  };
}

module.exports = { generateBriefing, generateEmailBriefs, buildPrompt, extractJson };
