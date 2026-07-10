// Briefing AI: writes the chief-of-staff brief and the quote/Notion
// reflections for the daily briefing.
//
// Provider-agnostic — goes through the shared `llm` layer, so whichever model
// you choose (Claude or Gemini) writes your briefing. Previously this was
// hard-wired to Gemini regardless of LLM_PROVIDER.
//
// SPLIT INTO TWO INDEPENDENT LLM CALLS (chief-brief vs wisdom) instead of one
// combined call. Two reasons:
//  1. Latency: run in parallel (Promise.all) instead of one big serial call —
//     wall-clock drops to whichever is slower, not the sum of both.
//  2. Waste: on a same-day rebuild, server.js's day-lock ALWAYS discards the
//     freshly-generated quoteInsight/notionQuote/notionInsight in favor of the
//     first build's — see `keep()`/`lockedQuotePair`/`lockedNotion` in
//     GET /api/briefing. Every "Rebuild" tap after the first build of the day
//     was paying for a wisdom-section LLM call whose output was thrown away.
//     Splitting lets the caller skip generateWisdomInsights() entirely once
//     today's quote/Notion pair is already locked.
const llm = require('../llm');
const { extractJson, parseAndValidate } = require('../llm/parseJson');

// Static voice + output-schema + rules for the chief-brief call. This text is
// BYTE-IDENTICAL on every build (no per-call dynamic content mixed in), so the
// Anthropic provider's cache_control on the system block gets a real cache hit
// on every call after the first — previously this schema/rules text lived in
// the per-call user prompt, ineligible for caching since it sat behind dynamic
// data that changes every request.
const CHIEF_SYSTEM =
  'You are NormOS — the user\'s chief of staff and data scientist. You have access to their body ' +
  '(HRV, sleep, recovery), money (net worth, cashflow, spend), calendar, inbox, goals, and a ' +
  'confirmed model of what moves THEIR metrics. Each morning you write the brief as a person who ' +
  'knows them, not a report: you open with the single most important thing about today, then give ' +
  'them the highest-leverage action, the one risk trending wrong, and the one number that changed. ' +
  'Cross-domain synthesis is the point — connect body↔money↔focus when the data supports it, never ' +
  'when it doesn\'t. You name actual numbers and trajectories, and tie advice to confirmed ' +
  'patterns in their own data when relevant. Your voice is sharp, caring, blunt, and numerate — no flattery, no ' +
  'filler, respects their time. You never invent a number or a connection. ' +
  'CRITICAL — numbers: never compute, derive, estimate, or relabel a figure. Cite a ' +
  'number ONLY if it appears verbatim in the data provided, and only with the meaning ' +
  'it has there (a "30-day change" is not an "ahead-of-plan" figure). If you are not ' +
  'certain a number is given, describe the direction qualitatively ("spending is ' +
  'trending down") with no figure rather than guess. ' +
  'WRITING: complete, well-punctuated sentences. Never run two independent clauses ' +
  'together without a period, semicolon, or conjunction (no "a strong base for the week your ' +
  'stated focus is…" — close the first thought, then start the next). ' +
  'TIMES: always use a 12-hour clock with am/pm exactly as given in the data (e.g. "2:00 PM", ' +
  '"9:00 AM–6:00 PM"). Never write 24-hour times like "09:00" or "18:00". ' +
  'Return ONLY a single valid JSON object — no markdown, no code fences, no commentary.\n\n' +
  'Return ONLY valid JSON with EXACTLY these fields:\n\n' +
  '{\n' +
  '  "chiefBrief": {\n' +
  '    "synthesis": "ONE sentence (20-35 words): the single most important thing about today, synthesized ACROSS domains (body, money, focus, inbox, schedule). Lead with the domain with the highest urgency or consequence TODAY. Use the WORK calendar free/busy blocks (only) to gauge meeting load — if the day is blocked-up, factor that into the energy/recovery framing. Do NOT anchor on an empty personal calendar; assume a real workday. NEVER count a personal-calendar event (family time, an observance/religious block like a Sabbath window, a personal appointment) toward \\"heavy,\\" \\"blocked,\\" or \\"packed\\" — blocking personal time off is protecting it, the opposite of a demanding calendar; describe it as protected time if you mention it at all, never sum its hours into a workload figure. When referencing health, use the recovery BAND (green/yellow/red) or score, not raw HRV. Name a real number. If PERSISTENT ISSUES shows today\'s lead topic has been open 3+ days, do NOT re-derive and re-explain it as if fresh — name the streak length plainly (e.g. \'steps — day 4 of the same flag\') and shift to why it hasn\'t moved or what\'s actually different today, rather than restating the original setup.",\n' +
  '    "action": "THE ACTION (1-2 sentences). The highest-leverage thing to do NOW — draw from the HIGHEST-LEVERAGE ACTIONS block (leverage engine) above when present. Concrete and doable today. Tie to a confirmed pattern in their own data when relevant (\'Zone 2 days → your recovery score runs higher the next morning, your own data shows\'). CHECK LAST ACTION SUGGESTED FIRST — this is a real chief of staff who follows up, not one who forgets what they said yesterday: if it shows \'did not help\' / \'no effect\', do NOT suggest the identical thing again — propose a genuinely different mechanism; if it shows it worked, briefly acknowledge that win before moving to today\'s action (reinforcement, not silence). If it shows the outcome is STILL BEING MEASURED, that is normal and automatic — outcomes are judged from their own data (recommendations after ~a week; experiments run to their end date), the user has no feedback to give and nowhere they\'re supposed to give it. NEVER say they \'haven\'t given feedback\', never count days waiting, never make the follow-up itself the action — at most a half-sentence of quiet continuity using ONLY the ACTUAL item named in LAST ACTION SUGGESTED above, then give a REAL action for today. Do NOT invent, name, or reference any experiment, recommendation, or \\"still logging in the background\\" continuity that isn\'t literally given to you in the data above — if LAST ACTION SUGGESTED is empty or absent, skip the continuity clause entirely and go straight to today\'s action. A fabricated callback (naming an experiment that was never in the context) is worse than no callback at all. Only when LAST ACTION SUGGESTED is absent, stale (not shown), or clearly resolved should you pick a fresh action with no callback. If WEEK-AHEAD PERIODIZATION is present and nothing higher-priority is competing for this slot, it can BE today\'s action (e.g. \'ease off intensity today so tomorrow\'s session doesn\'t stack on top of an already-elevated load\'). TRAINING-AWARE: any movement/training advice MUST acknowledge \\"Today\'s workout\\" from the data above — never prescribe walks or extra cardio as if the day were empty when a session is already planned. Frame it relative to the plan: additive (\'walks on top of today\'s intervals — the session alone won\'t fix a steps deficit\'), sequenced (\'after today\'s Push session\'), or a swap only when recovery genuinely argues for it. An action that ignores the planned session reads as a bot, not a chief of staff.",\n' +
  '    "risk": "THE RISK (1-2 sentences). The ONE thing trending wrong — draw from the TRENDING WRONG block (at-risk forecasts) or a genuinely slipping habit / declining metric. CRITICAL: gate on ABSOLUTE level, not just direction. A metric still in a healthy range (mood/energy/focus ≥4/5, sleep ≥7h, recovery green) is NOT a risk even if it ticked down vs last week — that\'s \'holding strong\', and you should say so rather than inventing a downtrend. Reserve RISK for something actually below its healthy range, a sustained multi-week decline, or an at-risk forecast. Never manufacture alarm from normal day-to-day variation on a coarse 1–5 scale. If genuinely nothing is at risk, say what to protect to keep it that way.",\n' +
  '    "move": "THE MOVE (1-2 sentences). The single most consequential thing that CHANGED (or, if UPCOMING BILLS WARNING is present, that\'s ABOUT TO hit) and why it matters. HARD RULE: never mention net worth or any net-worth figure or percentage, and never tie a balance to their work — it\'s noise in a daily brief. Wealth belongs here ONLY as a spending/cashflow insight, and ONLY when genuinely notable: a spend spike, an unusual category, savings rate/budget pace moved meaningfully, OR an UPCOMING BILLS WARNING (this one is forward-looking — frame it as a heads-up before it lands, e.g. \'rent hits Friday and will eat most of your buffer\', never as something that already happened). UPCOMING BILLS WARNING takes priority over a routine spend observation when present. If neither applies, do NOT force a finance line — draw THE MOVE from a real changed number in habits, recovery, or sleep instead. Name the before→after (or now→upcoming) and the implication.",\n' +
  '    "openQuestion": "AT MOST ONE short question (≤ ~15 words) — the SINGLE thing you\'re genuinely uncertain about today whose answer would most improve tomorrow\'s read, phrased like a sharp friend checking in (\'HRV dipped — the Goose show, or something else?\'; \'Called today a rest day — still right?\'). STRICT: only when you have a REAL, SPECIFIC uncertainty tied to today\'s data — a number you can\'t explain, an assumption you made (a rest day, an OOO, a cause), a flag you\'re not sure is real. Return EMPTY STRING on any day you don\'t have a genuinely valuable question — most days. NEVER a generic \'anything to flag?\', never a question you could ask any day, never one whose answer you already have. Restraint is the point: a rare, well-aimed question reads as intelligence; a daily prompt reads as a chore."\n' +
  '  },\n' +
  '  "morningFocus": "1-2 sentences (35-60 words). Chief-of-staff situation report. Use the SELF-MODEL (7-day averages, habit trends, confirmed patterns) as your primary source — it always has context even before today\'s check-in or watch sync. Supplement with any real-time recovery/wellbeing data if present. For HRV: use today\'s reading from Recovery status (e.g. \'HRV 47ms\') — it is the accurate overnight number. The self-model HRV is a 7-day average and will differ. For sleep hours and habit rates, use self-model. Tell them what it means and the one thing that matters most today. Always generate this — never return empty string.",\n' +
  '  "urgentEmails": [\n' +
  '    { "from": "sender", "subject": "subject", "action": "1-2 sentences on what action is needed and why it\'s urgent" }\n' +
  '  ]\n' +
  '}\n\n' +
  'Rules:\n' +
  '- openQuestion: this is a RARE, high-value check-in, not a daily habit. Emit it ONLY when you have a genuine, specific uncertainty about TODAY that the user could resolve in a sentence and that would measurably sharpen tomorrow\'s brief (an unexplained number, an assumption you made about a cause / a rest day / an OOO, a flag you\'re not sure is real). On the majority of days you have no such question — return "" then. Never a generic "anything to flag?", never something you could ask any morning, never a question whose answer is already in the data. One well-aimed question a week beats a prompt every day.\n' +
  '- DAY CONTEXT (when present): if today is a weekend or a holiday / day off, the whole brief shifts register — this is NOT a workday. Do NOT frame meeting load, a busy or all-day-blocked calendar, or "open focus windows" as a risk or a lever; an all-day calendar block on a day off is time away from the desk, not a packed schedule. Lead with recovery, rest, family/presence, and enjoying the day; the ACTION should be about protecting the day off (or a genuinely wanted light workout), not shipping work. On the day BEFORE a holiday, you may note the long weekend starting as a light framing, not a warning.\n' +
  '- chiefBrief: this is the centerpiece — write it as a person who KNOWS them, not a report. Sharp, caring, blunt, numerate. The synthesis MUST span domains. Calendar rule: the MEETINGS lines are BUSY time (actual meetings — not focus blocks). The OPEN windows are the real uninterrupted focus stretches. Use meeting density (WORK calendar only) to gauge the day\'s cognitive load. Never call a meeting time a "focus block" or "uninterrupted stretch." The PERSONAL calendar is a different category entirely: a block there (family time, an observance/religious window, a personal appointment) is the user protecting time, never a source of load — do not add its hours to the work calendar\'s busy time, do not call the day "heavy" or "blocked" because of it, and do not let its mere presence override an otherwise light day\'s framing. Draw the ACTION from the leverage engine when present, otherwise from the most consequential thing in their finances/habits/inbox/schedule. RISK from at-risk forecasts or a metric genuinely below its healthy range — NOT a metric that merely dipped while still running high (a mood that\'s still high but ticked down slightly is "holding strong", not a risk; when citing mood/energy/focus, always in plain words — low/ok/high — never a raw number like "4.3/5"). MOVE: the most consequential real change — NEVER net worth or a net-worth figure/percentage, and never tie a balance to their work. Surface wealth ONLY as a spending/cashflow insight and ONLY when genuinely notable; otherwise use a habit rate or the composite recovery score. Name actual numbers everywhere. Never invent a tie-in or number. Always generate all four fields. Anti-repetition: check YOUR LAST MORNING BRIEFS before writing — if you\'re about to open with the same topic in roughly the same words, that\'s a sign you\'re on autopilot. Either the data has genuinely moved (say what\'s different, e.g. a new number, a new cause, progress vs stuck) or it\'s a real streak (say so explicitly and change the register — escalate, question, or pivot the ask) — never just re-run the same sentence shape with updated numbers. If a genuinely different domain is more pressing today, lead with THAT instead of defaulting back to yesterday\'s topic out of habit. Calibration: if CALIBRATION CHECK is present and flags a miss, weave a brief, honest acknowledgment into whichever field touches recovery today (synthesis or risk, whichever fits) — a chief of staff who admits a wrong call is more credible than one who never mentions it, but don\'t force this in if recovery isn\'t otherwise part of today\'s brief.\n' +
  '- LIFE CHAPTERS (when present): these are the long arcs the daily numbers live inside — a pregnancy advancing week by week, a date approaching. They inform TONE and PLANNING quietly: never re-announce a chapter as if it\'s news, never manufacture urgency from it, and never use it as filler. Surface a chapter explicitly only when it genuinely intersects today (a milestone week, a date now close enough to act on) — and at most once or twice a week, when the relevant domain is already the topic, you may point at ONE concrete preparation step it implies (e.g. a baby due date → 529 / insurance / cash-buffer prep as a wealth action). A chief of staff who knows a baby is coming plans differently — but says so sparingly.\n' +
  '- THIS WEEK\'S STATED GOALS (when present): these are the user\'s OWN commitments — a real chief of staff tracks them without being asked. From Wednesday onward, if a consequential goal (especially a work deliverable) is still [OPEN], surface exactly ONE: into THE ACTION if it\'s genuinely today\'s highest-leverage move, otherwise woven into the synthesis. Escalate as the week runs out (\'two working days left and the valuation update is still open\'). Use the work calendar\'s open windows to make it concrete (\'the 2:30–6:00 stretch is enough to close it out\'). Mon/Tue: stay quiet unless a goal is explicitly time-critical. Never list all goals, never nag about personal/relational goals in work-pressure terms (a goal like \'be present with family\' gets a gentle nudge, not a deadline). If everything is checked off, one earned sentence at most.\n' +
  '- YOU VS PAST YOU (when present — Monday\'s zoom-out): weave the single strongest shift into synthesis or morningFocus as perspective the daily numbers hide ("resting HR averaged 57 three months ago — it\'s 54 now"). An improvement is earned and gets named plainly — this is the payoff of the daily work, not flattery. A regression gets named just as honestly, framed as this week\'s quiet project, not a crisis. Use at most ONE shift; never let it displace something genuinely urgent today; never manufacture a longitudinal claim when this block is absent.\n' +
  '- CONFIDENCE CALIBRATION: match your language\'s certainty to the underlying signal\'s strength, not just its size. A single-day or single-week percentage swing off a small base (e.g. a spending category "trending 400% above usual" off a $100 average, or a one-day metric blip) is genuinely noisy — hedge it ("worth a glance," "if it continues," "early to call") rather than stating it as established fact. A multi-week trend, a confirmed correlation, a sustained streak, or a YOU VS PAST YOU shift backed by real duration is durable — state it plainly, with no hedging. Don\'t flatten these into one flat-confident voice; the reader should be able to tell from your tone alone which claims are solid and which are still-forming.\n' +
  '- morningFocus: draw primarily from the SELF-MODEL (7-day sleep avg, habit adherence rates, recovery trend, confirmed correlations). Use the recovery SCORE (0–100) and BAND (green/yellow/red) as the health anchor. If you cite HRV ms, use the value from Recovery status (today\'s actual overnight reading) — NOT the 7-day average in the self-model (they will differ). Name habit rates and sleep hours from the self-model. If the recovery trend is slipping, name the score trajectory. This should feel like the one sentence a trusted advisor who knows your week would say before you start your day. Never mention finances, calendar events, or emails here. Always generate something — the self-model always has enough context.\n' +
  '- urgentEmails: only emails needing a response/action today. Exclude newsletters, digests, marketing — only real emails requiring a response or action.';

// Static voice + output-schema for the wisdom (quote/Notion reflection) call.
// Split from CHIEF_SYSTEM so it can be skipped independently — see file header.
const WISDOM_SYSTEM =
  'You are NormOS, writing the reflective "wisdom" section of the user\'s daily briefing: the ' +
  'connection between today\'s quote/principle, a Notion passage, and their own life data. Warm, ' +
  'sharp, concise. Return ONLY a single valid JSON object — no markdown, no code fences, no commentary.\n\n' +
  'Return ONLY valid JSON with EXACTLY these fields:\n\n' +
  '{\n' +
  '  "quoteInsight": "2 sentences drawing out the deeper idea or principle in the quote",\n' +
  '  "notionQuote": "the single most resonant COMPLETE sentence or passage from the Notion wisdom above — verbatim. Must be actual wisdom: a full thought with a subject and verb that stands alone as insight. NEVER pick: a [section: ...] label, a chapter or book title, text that starts with ★ ☆ or an emoji, a fragment ending in a colon, or any organizational marker. CRITICAL: if the Notion wisdom includes an \'ALREADY SHOWN\' list, do NOT select any passage on it — pick a genuinely different one; if nothing else on the page qualifies, return empty string rather than repeat. If no single sentence qualifies, return empty string.",\n' +
  '  "notionInsight": "2 sentences drawing out the key idea in the SPECIFIC notionQuote you selected (the commentary must match that exact passage)"\n' +
  '}\n\n' +
  'Rules:\n' +
  '- notionQuote: pick a self-contained, meaningful line — never a title, never an intro that trails off (e.g. "Rather than trying to find someone who will:"). If the best idea spans a sentence, quote the whole sentence.\n' +
  '- quoteInsight / notionInsight: first sentence draws out the core idea as lived wisdom. Second sentence makes the connection to their actual data explicit — name the specific state or pattern that makes this quote land right now (e.g. "energy running low this week makes this idea about sustainable effort particularly timely" or "with recovery in the yellow band and cold shower adherence slipping this week, this hits differently"). If wellbeing data shows "no recent check-in data", return empty string for BOTH quoteInsight and notionInsight — a quote with no data connection is not shown. Connect through their wellbeing/health state (mood/energy/focus, recovery band, habits) — speak in plain human terms (low/ok/high, settled/slipping), like a friend who noticed, NEVER a raw number or "X/5" — that reads clinical, not like someone who actually knows them. Do NOT reference their calendar, specific tasks, schedule, "today", or their job/profession. Do NOT cite any dollar amount, net-worth figure, or financial percentage here — even if the quote is about money, make the connection qualitative (e.g. "the optionality you\'re building"), never with a computed number.';

function buildChiefBriefPrompt(emailData, currentDay, workoutPlan, calendarEvents, wellbeingContext = '', annotationsContext = '', recoveryContext = '', experimentsContext = '', selfModel = '', leverageContext = '', workBusyBlocks = [], strengthContext = '', spendingContext = '', continuityContext = '', cashflowContext = '', progressContext = '', weeklyGoalsContext = '', chaptersContext = '', dayOffContext = '') {
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
  // Calendar/free-busy times arrive as 12-hour strings ("2:00 PM"); parse the
  // meridiem so afternoon meetings aren't mistaken for the morning, and re-emit
  // everything in 12-hour form so the brief never mixes clocks.
  // NOTE: deliberately NOT src/util/date.js's toMinutesSinceMidnight — that one
  // returns null on no-match; every use below does unguarded arithmetic on the
  // result (sort comparators, cursor math), so swapping in null would need a
  // guard at each call site. Don't copy this version elsewhere — reuse the
  // shared util instead, which every OTHER caller in the repo already does.
  const toMin = (t) => {
    const m = String(t).match(/(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
    if (!m) return 0;
    let h = Number(m[1]);
    const mer = m[3] ? m[3].toUpperCase() : null;
    if (mer === 'PM' && h !== 12) h += 12;
    if (mer === 'AM' && h === 12) h = 0;
    return h * 60 + Number(m[2]);
  };
  const toTime = (min) => {
    const h24 = Math.floor(min / 60), mm = min % 60;
    const mer = h24 >= 12 ? 'PM' : 'AM';
    const h = h24 % 12 || 12;
    return `${h}:${String(mm).padStart(2, '0')} ${mer}`;
  };
  const busySorted = [...workBusyBlocks].sort((a, b) => toMin(a.start) - toMin(b.start));
  const openWindows = [];
  let cursor = toMin('09:00');
  for (const b of busySorted) {
    if (toMin(b.start) > cursor + 29) openWindows.push(`${toTime(cursor)}–${b.start}`);
    cursor = Math.max(cursor, toMin(b.end));
  }
  if (cursor < toMin('18:00') - 29) openWindows.push(`${toTime(cursor)}–${toTime(toMin('18:00'))}`);

  // An all-day / full-workday busy block from the free/busy feed is almost
  // always an OUT-OF-OFFICE or all-day event (PTO, a holiday, a travel day) —
  // NOT a schedule packed with back-to-back meetings. Detect it so the brief
  // doesn't read a day off as "fully blocked with meetings, zero open windows."
  const allDayBlock = busySorted.some((b) => toMin(b.start) <= toMin('08:00') && toMin(b.end) >= toMin('18:00'));

  const workBusySection = allDayBlock
    ? 'WORK CALENDAR: an ALL-DAY block covers today (out-of-office / PTO / holiday / travel — the free/busy feed has no titles). This is NOT a day packed with meetings; treat it as a day away from the desk. Do NOT say "zero open focus windows" or frame meeting load as a problem.'
    : workBusyBlocks.length > 0
      ? `MEETINGS (busy — no titles): ${workBusyBlocks.map((b) => `${b.start}–${b.end}`).join(', ')}\nOPEN windows for focus work: ${openWindows.length ? openWindows.join(', ') : 'none'}`
      : 'No busy blocks visible (calendar may be clear or data unavailable).';

  return `${selfModel ? selfModel + '\n\n---\n\n' : ''}Today is ${currentDay}.
${dayOffContext ? `\nDAY CONTEXT: ${dayOffContext}\n` : ''}
Today's workout: ${workoutPlan.type}${workoutPlan.duration ? ` (${workoutPlan.duration})` : ''}
${recoveryContext ? `Recovery status: ${recoveryContext}` : ''}
${experimentsContext ? `\nONGOING SELF-EXPERIMENTS (mention only when genuinely relevant to today's topic — never force it in, never claim more than what's stated, and never describe a flagged-stalled one as actively tracking):\n${experimentsContext}\n` : ''}

Today's calendar (personal — usually light):
${calendarSection}

Work calendar (meeting times and open focus windows):
${workBusySection}

Recent wellbeing (last 7 days): ${wellbeingContext || 'no recent check-in data'}

Active life context: ${annotationsContext || 'none'}

${chaptersContext ? `LIFE CHAPTERS (standing long-arc facts about the user's life right now — auto-updated, always true, the user never needs to repeat them):\n${chaptersContext}\n\n` : ''}${continuityContext ? `${continuityContext}\n\n` : ''}${weeklyGoalsContext ? `THIS WEEK'S STATED GOALS (the user wrote these themselves at the Sunday check-in — [OPEN] = not yet checked off): ${weeklyGoalsContext}\n\n` : ''}${progressContext ? `YOU VS PAST YOU (longitudinal zoom-out — trailing 4-week averages vs the same measures ~3 months ago; only shifts big enough to be real are listed): ${progressContext}\n\n` : ''}${cashflowContext ? `UPCOMING BILLS WARNING (forward-looking — this hasn't happened yet, don't describe it in the past tense): ${cashflowContext}\n\n` : ''}${spendingContext ? `Spending signal: ${spendingContext}\n\n` : ''}${strengthContext ? `Strength progression (logged lifts): ${strengthContext}\n\n` : ''}${leverageContext ? `${leverageContext}\n\n` : ''}Unread emails (${emailData.length} threads):
${emailSection}`;
}

function buildWisdomPrompt(notionText, quote, wellbeingContext = '') {
  return `Today's quote/principle:
"${quote}"

Today's Notion wisdom:
${notionText}

Recent wellbeing (last 7 days): ${wellbeingContext || 'no recent check-in data'}`;
}

const EMPTY_CHIEF = { morningFocus: '', chiefBrief: null, urgentEmails: [] };
const EMPTY_WISDOM = { quoteInsight: '', notionQuote: '', notionInsight: '' };

const CHIEF_REQUIRED_FIELDS = ['synthesis', 'action', 'risk', 'move'];

// Passed as jsonMode+jsonSchema so providers that support it (Gemini via
// responseMimeType, Anthropic via a forced tool call) constrain generation
// to this shape server-side instead of relying purely on CHIEF_SYSTEM's
// prose instruction — see the engineering review's #4 and each provider's
// generateText for how this is enforced.
const CHIEF_JSON_SCHEMA = {
  type: 'object',
  properties: {
    chiefBrief: {
      type: 'object',
      properties: {
        synthesis: { type: 'string' },
        action: { type: 'string' },
        risk: { type: 'string' },
        move: { type: 'string' },
        openQuestion: { type: 'string' },
      },
      required: ['synthesis', 'action', 'risk', 'move', 'openQuestion'],
    },
    morningFocus: { type: 'string' },
    urgentEmails: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          subject: { type: 'string' },
          action: { type: 'string' },
        },
        required: ['from', 'subject', 'action'],
      },
    },
  },
  required: ['chiefBrief', 'morningFocus', 'urgentEmails'],
};

/** One LLM call + parse + shape-validate. Returns the result shape or null (retryable). */
async function chiefBriefAttempt(prompt, attemptLabel) {
  let text = '';
  try {
    // Chief-brief is the load-bearing call — several dense sections + urgent
    // emails + finance/goal bullets. Give it room: low temp for focus, and the
    // caller (server.js) allows up to BRIEFING_LLM_TIMEOUT_MS overall. Raised
    // from 4096: the schema is verbose (4 chiefBrief fields + morningFocus +
    // a variable-length urgentEmails array) and a genuinely busy inbox day
    // could plausibly push the real output past 4096 tokens, truncating the
    // JSON mid-object — which fails validation with no sign it was a length
    // problem rather than a formatting one. Cheap insurance either way.
    text = await llm.generateText({
      system: CHIEF_SYSTEM, prompt, temperature: 0.2, maxTokens: 8192,
      jsonMode: true, jsonSchema: CHIEF_JSON_SCHEMA,
    });
  } catch (err) {
    console.error(`[briefing-ai] chief-brief generation failed (${attemptLabel}):`, err.message);
    return null;
  }

  return parseAndValidate(text, {
    label: `chief-brief (${attemptLabel})`,
    validate: (parsed) => {
      // Structured chief-of-staff brief: only keep it if all four blocks are
      // present strings, so the card can trust the shape (else null → card
      // hides, and the caller falls back to the PRIOR build's chiefBrief —
      // see briefing.js). Log exactly which field(s) are missing on top of
      // parseAndValidate's own generic log: this specific site has a history
      // of silently recurring failures, and "move missing/empty" is a lot
      // faster to act on than re-deriving it from a raw JSON dump each time.
      const cb = parsed.chiefBrief;
      const shapeOk = cb && typeof cb === 'object' && CHIEF_REQUIRED_FIELDS.every((k) => typeof cb[k] === 'string' && cb[k].trim());
      if (!shapeOk) {
        const missing = !cb || typeof cb !== 'object'
          ? 'chiefBrief missing or not an object'
          : CHIEF_REQUIRED_FIELDS.filter((k) => !(typeof cb[k] === 'string' && cb[k].trim())).join(', ') + ' missing/empty';
        console.error(`[briefing-ai] chief-brief shape invalid (${attemptLabel}): ${missing}.`);
        return null;
      }
      return {
        morningFocus: typeof parsed.morningFocus === 'string' ? parsed.morningFocus : '',
        chiefBrief: {
          synthesis: cb.synthesis, action: cb.action, risk: cb.risk, move: cb.move,
          // The one thing the brief is genuinely unsure about today — often empty
          // (restraint), a real inline question when present. Trim + drop generic ones.
          openQuestion: typeof cb.openQuestion === 'string' && cb.openQuestion.trim().length > 3 ? cb.openQuestion.trim() : '',
        },
        urgentEmails: Array.isArray(parsed.urgentEmails) ? parsed.urgentEmails : [],
      };
    },
  });
}

/** Generate the chief-brief + morningFocus + urgentEmails section only. */
async function generateChiefBrief(emailData, currentDay, workoutPlan, calendarEvents, wellbeingContext = '', annotationsContext = '', recoveryContext = '', experimentsContext = '', selfModel = '', leverageContext = '', workBusyBlocks = [], strengthContext = '', spendingContext = '', continuityContext = '', cashflowContext = '', progressContext = '', weeklyGoalsContext = '', chaptersContext = '', dayOffContext = '') {
  // Apply the same hard filter as generateEmailBriefs so automated senders
  // never reach the main briefing LLM call either.
  const filteredEmails = filterActionableEmails(emailData);
  const prompt = buildChiefBriefPrompt(filteredEmails, currentDay, workoutPlan, calendarEvents, wellbeingContext, annotationsContext, recoveryContext, experimentsContext, selfModel, leverageContext, workBusyBlocks, strengthContext, spendingContext, continuityContext, cashflowContext, progressContext, weeklyGoalsContext, chaptersContext, dayOffContext);

  // One retry on a shape/parse failure — the model call is non-deterministic
  // (temperature 0.2, not 0), and this exact class of failure (silently
  // falling back to yesterday's brief, repeatedly) is what a live user hit.
  // A second attempt with the identical prompt has a real chance of coming
  // back valid; only give up and let the caller fall back after both fail.
  const first = await chiefBriefAttempt(prompt, 'attempt 1/2');
  if (first) return first;
  const second = await chiefBriefAttempt(prompt, 'attempt 2/2 (retry)');
  if (second) return second;
  return { ...EMPTY_CHIEF };
}

/**
 * Generate the quote/Notion "wisdom" reflection section only. Skippable by the
 * caller once today's quote/Notion pair is already day-locked (see file header) —
 * the biggest single latency/cost win here is not calling this at all.
 */
async function generateWisdomInsights(notionText, quote, wellbeingContext = '') {
  const prompt = buildWisdomPrompt(notionText, quote, wellbeingContext);

  let text = '';
  try {
    text = await llm.generateText({ system: WISDOM_SYSTEM, prompt, temperature: 0.3, maxTokens: 1024 });
  } catch (err) {
    console.error('[briefing-ai] wisdom generation failed:', err.message);
    return { ...EMPTY_WISDOM };
  }

  const result = parseAndValidate(text, {
    label: 'wisdom',
    validate: (parsed) => {
      // Reject notionQuote if it looks like a heading or organizational marker —
      // a guardrail against the LLM picking [section: ...] labels, ★-prefixed
      // chapter titles, or short fragments that aren't real sentences. There's
      // no reject-the-whole-response case here (unlike chief-brief) — every
      // field independently falls back to '' if missing/wrong type, so this
      // always returns a usable object once JSON parsing itself succeeds.
      const rawNotionQuote = typeof parsed.notionQuote === 'string' ? parsed.notionQuote.trim() : '';
      const looksLikeHeading = (s) =>
        !s ||
        /^\[section:/i.test(s) ||
        /^[★☆#]/.test(s) ||
        s.endsWith(':') ||
        (s.length < 25 && !/[.!?,;]/.test(s));
      const notionQuote = looksLikeHeading(rawNotionQuote) ? '' : rawNotionQuote;
      return {
        quoteInsight: typeof parsed.quoteInsight === 'string' ? parsed.quoteInsight : '',
        notionQuote,
        notionInsight: notionQuote ? (typeof parsed.notionInsight === 'string' ? parsed.notionInsight : '') : '',
      };
    },
  });
  return result ?? { ...EMPTY_WISDOM };
}

/**
 * Backward-compatible combined call: runs both LLM calls in PARALLEL (not the
 * old single serial call) and merges the results. Used by the diagnostic
 * endpoint (/api/diag/briefing-llm); the real build path in server.js calls
 * generateChiefBrief/generateWisdomInsights directly so it can skip the wisdom
 * call entirely on a same-day rebuild.
 */
async function generateBriefing(emailData, notionText, quote, currentDay, workoutPlan, calendarEvents, wellbeingContext = '', annotationsContext = '', recoveryContext = '', experimentsContext = '', selfModel = '', leverageContext = '', workBusyBlocks = [], strengthContext = '', spendingContext = '', continuityContext = '', cashflowContext = '', progressContext = '', weeklyGoalsContext = '', chaptersContext = '', dayOffContext = '') {
  const [chief, wisdom] = await Promise.all([
    generateChiefBrief(emailData, currentDay, workoutPlan, calendarEvents, wellbeingContext, annotationsContext, recoveryContext, experimentsContext, selfModel, leverageContext, workBusyBlocks, strengthContext, spendingContext, continuityContext, cashflowContext, progressContext, weeklyGoalsContext, chaptersContext, dayOffContext),
    generateWisdomInsights(notionText, quote, wellbeingContext),
  ]);
  return { ...chief, ...wisdom };
}

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

module.exports = {
  generateBriefing, generateChiefBrief, generateWisdomInsights,
  buildChiefBriefPrompt, buildWisdomPrompt, extractJson,
};
