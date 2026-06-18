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
  'patterns in their own data when relevant. Your voice is sharp, caring, blunt, and numerate — no flattery, no ' +
  'filler, respects their time. You never invent a number or a connection. ' +
  'Return ONLY a single valid JSON object — no markdown, no code fences, no commentary.';

function buildPrompt(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents, wellbeingContext = '', annotationsContext = '', recoveryContext = '', experimentsContext = '', selfModel = '', leverageContext = '', workBusyBlocks = []) {
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

  // NOTE: this is a personal Google Calendar only — work calendar is not connected
  // and typically has a full schedule. Personal calendar is usually light.
  const calendarSection =
    calendarEvents.length > 0
      ? calendarEvents
          .map((e) => `- ${e.allDay ? '[All Day]' : `${e.startTime}–${e.endTime}`}: ${e.title}`)
          .join('\n')
      : 'No personal calendar events today. (Work calendar not connected — assume a normal workday.)';

  // Compute open focus windows from the gaps between busy blocks (9am–6pm workday).
  const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
  const toTime = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const busySorted = [...workBusyBlocks].sort((a, b) => toMin(a.start) - toMin(b.start));
  const openWindows = [];
  let cursor = toMin('09:00');
  for (const b of busySorted) {
    if (toMin(b.start) > cursor + 29) openWindows.push(`${toTime(cursor)}–${b.start}`);
    cursor = Math.max(cursor, toMin(b.end));
  }
  if (cursor < toMin('18:00') - 29) openWindows.push(`${toTime(cursor)}–18:00`);

  const workBusySection =
    workBusyBlocks.length > 0
      ? `MEETINGS (busy — no titles): ${workBusyBlocks.map((b) => `${b.start}–${b.end}`).join(', ')}\nOPEN windows for focus work: ${openWindows.length ? openWindows.join(', ') : 'none'}`
      : 'No busy blocks visible (calendar may be clear or data unavailable).';

  return `${selfModel ? selfModel + '\n\n---\n\n' : ''}Today is ${currentDay}.

Today's workout: ${workoutPlan.type}${workoutPlan.duration ? ` (${workoutPlan.duration})` : ''}
${recoveryContext ? `Recovery status: ${recoveryContext}` : ''}

Today's calendar (personal — usually light):
${calendarSection}

Work calendar (meeting times and open focus windows):
${workBusySection}

Recent wellbeing (last 7 days): ${wellbeingContext || 'no recent check-in data'}

Active life context: ${annotationsContext || 'none'}

${leverageContext ? `${leverageContext}\n\n` : ''}Today's quote/principle:
"${quote}"

Today's Notion wisdom:
${notionText}

Unread emails (${emailData.length} threads):
${emailSection}

---

Return ONLY valid JSON with EXACTLY these fields:

{
  "chiefBrief": {
    "synthesis": "ONE sentence (20-35 words): the single most important thing about today, synthesized ACROSS domains (body, money, focus, inbox, schedule). Lead with the domain with the highest urgency or consequence TODAY. Use the work calendar free/busy blocks to gauge meeting load — if the day is blocked-up, factor that into the energy/recovery framing. Do NOT anchor on an empty personal calendar; assume a real workday. When referencing health, use the recovery BAND (green/yellow/red) or score, not raw HRV. Name a real number.",
    "action": "THE ACTION (1-2 sentences). The highest-leverage thing to do NOW — draw from the HIGHEST-LEVERAGE ACTIONS block (leverage engine) above when present. Concrete and doable today. Tie to a confirmed pattern in their own data when relevant ('Zone 2 days → your recovery score runs higher the next morning, your own data shows').",
    "risk": "THE RISK (1-2 sentences). The ONE thing trending wrong — draw from the TRENDING WRONG block (at-risk forecasts) or a slipping habit / declining metric in the self-model. Name the trajectory. If genuinely nothing is at risk, say what to protect to keep it that way.",
    "move": "THE MOVE (1-2 sentences). One number that CHANGED and why it matters. Prefer spend/cashflow, a habit rate, or the recovery score over raw HRV — HRV is a component of the score, not a standalone signal. Name the before→after and the implication."
  },
  "morningFocus": "1-2 sentences (35-60 words). Chief-of-staff situation report. Use the SELF-MODEL (7-day averages, habit trends, confirmed patterns) as your primary source — it always has context even before today's check-in or watch sync. Supplement with any real-time recovery/wellbeing data if present. Name the actual numbers from the self-model (HRV ms, sleep hours, habit rates). Tell them what it means and the one thing that matters most today. Always generate this — never return empty string.",
  "urgentEmails": [
    { "from": "sender", "subject": "subject", "action": "1-2 sentences on what action is needed and why it's urgent" }
  ],
  "quoteInsight": "2 sentences drawing out the deeper idea or principle in the quote",
  "notionQuote": "the single most resonant COMPLETE sentence or passage from the Notion wisdom above — verbatim, not cut off mid-thought, not a heading or intro fragment ending in a colon",
  "notionInsight": "2 sentences drawing out the key idea in the SPECIFIC notionQuote you selected (the commentary must match that exact passage)"
}

Rules:
- chiefBrief: this is the centerpiece — write it as a person who KNOWS them, not a report. Sharp, caring, blunt, numerate. The synthesis MUST span domains. Calendar rule: the MEETINGS lines are BUSY time (actual meetings — not focus blocks). The OPEN windows are the real uninterrupted focus stretches. Use meeting density to gauge the day's cognitive load. Never call a meeting time a "focus block" or "uninterrupted stretch." Draw the ACTION from the leverage engine when present, otherwise from the most consequential thing in their finances/habits/inbox/schedule. RISK from at-risk forecasts/slipping habits. MOVE from a real number that changed — prefer spend/cashflow, a habit rate, or the composite recovery score over raw HRV. Name actual numbers everywhere. Never invent a tie-in or number. Always generate all four fields.
- morningFocus: draw primarily from the SELF-MODEL (7-day sleep avg, habit adherence rates, recovery trend, confirmed correlations). Use the recovery SCORE (0–100) and BAND (green/yellow/red) as the health anchor — it already synthesizes HRV, RHR, and sleep into one number, so lead with that instead of raw HRV ms. Name habit rates and sleep hours from the self-model. If the recovery trend is slipping, name the score trajectory. This should feel like the one sentence a trusted advisor who knows your week would say before you start your day. Never mention finances, calendar events, or emails here. Always generate something — the self-model always has enough context.
- urgentEmails: only emails needing a response/action today. Exclude newsletters, digests, marketing — only real emails requiring a response or action.
- notionQuote: pick a self-contained, meaningful line — never a title, never an intro that trails off (e.g. "Rather than trying to find someone who will:"). If the best idea spans a sentence, quote the whole sentence.
- quoteInsight / notionInsight: first sentence draws out the core idea as lived wisdom. Second sentence makes the connection to their actual data explicit — name the specific metric or pattern that makes this quote land right now (e.g. "energy averaging 2.6/5 this week makes this idea about sustainable effort particularly timely" or "with recovery in the yellow band and cold shower adherence slipping this week, this hits differently"). If wellbeing data shows "no recent check-in data", return empty string for BOTH quoteInsight and notionInsight — a quote with no data connection is not shown. Do NOT reference their calendar, specific tasks, schedule, "today", their job/profession, or their finances.`;
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
  morningFocus: '', chiefBrief: null, urgentEmails: [], quoteInsight: '', notionQuote: '', notionInsight: '',
};

async function generateBriefing(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents, wellbeingContext = '', annotationsContext = '', recoveryContext = '', experimentsContext = '', selfModel = '', leverageContext = '', workBusyBlocks = []) {
  // Apply the same hard filter as generateEmailBriefs so automated senders
  // never reach the main briefing LLM call either.
  const filteredEmails = filterActionableEmails(emailData);
  const prompt = buildPrompt(filteredEmails, notionText, quote, currentDay, workoutPlan, calendarEvents, wellbeingContext, annotationsContext, recoveryContext, experimentsContext, selfModel, leverageContext, workBusyBlocks);

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
    urgentEmails: Array.isArray(parsed.urgentEmails) ? parsed.urgentEmails : [],
    quoteInsight: typeof parsed.quoteInsight === 'string' ? parsed.quoteInsight : '',
    notionQuote: typeof parsed.notionQuote === 'string' ? parsed.notionQuote : '',
    notionInsight: typeof parsed.notionInsight === 'string' ? parsed.notionInsight : '',
  };
}

const EMAIL_SYSTEM =
  'You summarize unread email for a personal briefing. Analyze the provided emails. ' +
  'Return ONLY a single valid JSON object — no markdown, no code fences, no commentary.';

// Sender patterns that are never urgent — automated systems that by definition
// can't receive replies and whose emails are FYI/notifications, not action items.
const AUTO_SENDER_RE = /no.?reply|noreply|do.not.reply|donotreply|notifications?@|alerts?@|automated@|mailer-daemon|postmaster|bounce@|support-noreply/i;

// Subject patterns that are always informational, never action items.
const AUTO_SUBJECT_RE = /your (payment|order|shipment|subscription|receipt|invoice|statement|account|deposit|transfer) (is |has been |was |will be )?(scheduled|confirmed|processed|shipped|updated|received|complete|sent|on its way)|payment scheduled|auto.?pay|automatic payment|order confirmation|shipping confirmation|your receipt|transaction alert|statement (is )?ready|you have a new statement/i;

/**
 * Hard pre-filter: remove automated/no-reply emails before the LLM sees them.
 * Automated senders can't act on replies, and their emails are FYI — never
 * action items. Filtering here is more reliable than prompting the LLM to skip
 * them (the model is sometimes too liberal about what counts as "urgent").
 */
function filterActionableEmails(emails) {
  return emails.filter((e) => {
    const from = String(e.from || '');
    const subject = String(e.subject || '');
    if (AUTO_SENDER_RE.test(from)) return false;
    if (AUTO_SUBJECT_RE.test(subject)) return false;
    return true;
  });
}

/**
 * Mid-day urgent-email scan: quickly identifies emails needing action today.
 * Much smaller output than the full briefing. Powers GET /api/briefing/live.
 */
async function generateEmailBriefs(emailData) {
  // Hard-filter automated senders before the LLM sees them.
  const actionable = filterActionableEmails(emailData);
  if (!actionable.length) return { urgentEmails: [] };

  const PER_EMAIL = Number(process.env.EMAIL_PROMPT_CHARS || 15000);
  const TOTAL_BUDGET = Number(process.env.EMAIL_PROMPT_TOTAL || 200000);
  let used = 0;
  const emailSection = actionable
    .map((e, i) => {
      if (used >= TOTAL_BUDGET) return null;
      const body = String(e.body || '').slice(0, PER_EMAIL);
      used += body.length;
      return `--- Email ${i + 1} ---\nFrom: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}\nBody:\n${body}`;
    })
    .filter(Boolean)
    .join('\n\n');

  const prompt = `Unread emails (${actionable.length} threads — automated/no-reply already removed):
${emailSection}

---

Return ONLY valid JSON with EXACTLY these fields:

{
  "urgentEmails": [
    { "from": "sender", "subject": "subject", "action": "1-2 sentences on what action is needed and why it's urgent" }
  ]
}

Rules:
- urgentEmails: only emails where YOU personally need to respond or take action today. A real human sent it and expects something back, or there is a deadline/decision requiring your input.
- Exclude: FYI updates, read receipts, digests, newsletters, marketing, any email you could ignore without consequence.
- When in doubt, leave it out. An empty array is correct if nothing truly requires action.`;

  let text = '';
  try {
    text = await llm.generateText({ system: EMAIL_SYSTEM, prompt, temperature: 0.2, maxTokens: 2048 });
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
    urgentEmails: Array.isArray(parsed.urgentEmails) ? parsed.urgentEmails : [],
  };
}

module.exports = { generateBriefing, generateEmailBriefs, buildPrompt, extractJson };
