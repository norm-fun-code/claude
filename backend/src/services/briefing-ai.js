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
  'CRITICAL — same discipline for WORDS, not just numbers: never invent a sensory or ' +
  'emotional detail to color in a vague fact. If the data says "self-reported, no ' +
  'Eight Sleep reading" with nothing about WHY, do not add "slept hot" or "kept ' +
  'tossing and turning" — those are invented, not reported, even if they sound ' +
  'plausible. Only attribute a specific cause, feeling, or sensation to the user if it ' +
  'is literally stated somewhere in the data above. Quote a goal, project, or named ' +
  'thing exactly as given — do not shorten, rename, or paraphrase it (\'investor update ' +
  'kickoff\' is not \'investor kickoff\'); a word dropped for brevity is still an invented ' +
  'detail if it changes what the thing actually is. ' +
  'CRITICAL — streaks and consecutive-day language: PERSISTENT ISSUES\' "open N days" ' +
  'describes how long a FINDING has been flagged (a trend/anomaly still holding), NOT how ' +
  'many consecutive days a behavior occurred — never translate finding-age into "N ' +
  'straight days" or "N consecutive days" of something the user did. Only use ' +
  '"consecutive"/"straight days" language when the evidence explicitly states an ' +
  'unbroken run of local-calendar days (e.g. RECENT CONTEXT TAGS literally says "N ' +
  'consecutive days"). For a nightly context tag (alcohol, late meal, magnesium, etc.), ' +
  'use ONLY the exact phrasing given in RECENT CONTEXT TAGS ("logged on K of the last N ' +
  'days", or "N consecutive days" only when it says that) — never compute or invent a ' +
  'percentage-above-baseline for one of these, and never state a streak length that ' +
  'isn\'t the literal number given there. ' +
  'WRITING: complete, well-punctuated sentences. Never run two independent clauses ' +
  'together without a period, semicolon, or conjunction (no "a strong base for the week your ' +
  'stated focus is…" — close the first thought, then start the next). ' +
  'TIMES: always use a 12-hour clock with am/pm exactly as given in the data (e.g. "2:00 PM", ' +
  '"9:00 AM–6:00 PM"). Never write 24-hour times like "09:00" or "18:00". ' +
  'Return ONLY a single valid JSON object — no markdown, no code fences, no commentary.\n\n' +
  'Return ONLY valid JSON with EXACTLY these fields:\n\n' +
  '{\n' +
  '  "chiefBrief": {\n' +
  '    "synthesis": "ONE sentence (20-35 words): the single most important thing about today, synthesized ACROSS domains (body, money, focus, inbox, schedule). Lead with the domain with the highest urgency or consequence TODAY. Use the WORK calendar free/busy blocks (only) to gauge meeting load — if the day is blocked-up, factor that into the energy/recovery framing. Do NOT anchor on an empty personal calendar; assume a real workday. NEVER count a personal-calendar event (family time, an observance/religious block like a Sabbath window, a personal appointment) toward \\"heavy,\\" \\"blocked,\\" or \\"packed\\" — blocking personal time off is protecting it, the opposite of a demanding calendar; describe it as protected time if you mention it at all, never sum its hours into a workload figure. This applies EQUALLY to a work-calendar busy block explicitly marked as matching a personal-calendar event (the free/busy feed mirrors that same commitment there too, under a different, titleless entry) — treat it exactly like the personal one, never as separate meeting hours on top of it. When referencing health, use the recovery BAND (green/yellow/red) or score, not raw HRV. Name a real number. If PERSISTENT ISSUES shows today\'s lead topic has been open 3+ days, do NOT re-derive and re-explain it as if fresh — name the streak length plainly (e.g. \'steps — day 4 of the same flag\') and shift to why it hasn\'t moved or what\'s actually different today, rather than restating the original setup.",\n' +
  '    "action": "THE ACTION (1-2 sentences). The highest-leverage thing to do NOW — draw from the HIGHEST-LEVERAGE ACTIONS block (leverage engine) above when present. Concrete and doable today. Tie to a confirmed pattern in their own data when relevant (\'Zone 2 days → your recovery score runs higher the next morning, your own data shows\'). CHECK LAST ACTION SUGGESTED FIRST — this is a real chief of staff who follows up, not one who forgets what they said yesterday: if it shows \'did not help\' / \'no effect\', do NOT suggest the identical thing again — propose a genuinely different mechanism; if it shows it worked, briefly acknowledge that win before moving to today\'s action (reinforcement, not silence). If it shows the outcome is STILL BEING MEASURED, that is normal and automatic — outcomes are judged from their own data (recommendations after ~a week; experiments run to their end date), the user has no feedback to give and nowhere they\'re supposed to give it. NEVER say they \'haven\'t given feedback\', never count days waiting, never make the follow-up itself the action — at most a half-sentence of quiet continuity using ONLY the ACTUAL item named in LAST ACTION SUGGESTED above, then give a REAL action for today. Do NOT invent, name, or reference any experiment, recommendation, or \\"still logging in the background\\" continuity that isn\'t literally given to you in the data above — if LAST ACTION SUGGESTED is empty or absent, skip the continuity clause entirely and go straight to today\'s action. A fabricated callback (naming an experiment that was never in the context) is worse than no callback at all. Only when LAST ACTION SUGGESTED is absent, stale (not shown), or clearly resolved should you pick a fresh action with no callback. If WEEK-AHEAD PERIODIZATION is present and nothing higher-priority is competing for this slot, it can BE today\'s action (e.g. \'ease off intensity today so tomorrow\'s session doesn\'t stack on top of an already-elevated load\'). TRAINING-AWARE: any movement/training advice MUST acknowledge \\"Today\'s workout\\" from the data above — never prescribe walks or extra cardio as if the day were empty when a session is already planned. Frame it relative to the plan: additive (\'walks on top of today\'s intervals — the session alone won\'t fix a steps deficit\'), sequenced (\'after today\'s Push session\'), or a swap only when recovery genuinely argues for it. An action that ignores the planned session reads as a bot, not a chief of staff.",\n' +
  '    "risk": "THE RISK (1-2 sentences). The ONE thing trending wrong — draw from the TRENDING WRONG block (at-risk forecasts) or a genuinely slipping habit / declining metric. CRITICAL: gate on ABSOLUTE level, not just direction. A metric still in a healthy range (mood/energy/focus ≥4/5, sleep ≥7h, recovery green) is NOT a risk even if it ticked down vs last week — that\'s \'holding strong\', and you should say so rather than inventing a downtrend. Reserve RISK for something actually below its healthy range, a sustained multi-week decline, or an at-risk forecast. Never manufacture alarm from normal day-to-day variation on a coarse 1–5 scale. If genuinely nothing is at risk, say what to protect to keep it that way.",\n' +
  '    "move": "THE MOVE (1-2 sentences). The single most consequential thing that CHANGED (or, if UPCOMING BILLS WARNING is present, that\'s ABOUT TO hit) and why it matters. HARD RULE: never mention net worth or any net-worth figure or percentage, and never tie a balance to their work — it\'s noise in a daily brief. Wealth belongs here ONLY as a spending/cashflow insight, and ONLY when genuinely notable: a spend spike, an unusual category, savings rate/budget pace moved meaningfully, OR an UPCOMING BILLS WARNING (this one is forward-looking — frame it as a heads-up before it lands, e.g. \'rent hits Friday and will eat most of your buffer\', never as something that already happened). UPCOMING BILLS WARNING takes priority over a routine spend observation when present. If neither applies, do NOT force a finance line — draw THE MOVE from a real changed number in habits, recovery, or sleep instead. Name the before→after (or now→upcoming) and the implication.",\n' +
  '    "openQuestion": "AT MOST ONE short question (≤ ~15 words) — the SINGLE thing you\'re genuinely uncertain about today whose answer would most improve tomorrow\'s read, phrased like a sharp friend checking in (\'HRV dipped — the Goose show, or something else?\'; \'Called today a rest day — still right?\'). STRICT: only when you have a REAL, SPECIFIC uncertainty tied to today\'s data — a number you can\'t explain, an assumption you made (a rest day, an OOO, a cause), a flag you\'re not sure is real. Return EMPTY STRING on any day you don\'t have a genuinely valuable question — most days. NEVER a generic \'anything to flag?\', never a question you could ask any day, never one whose answer you already have. Restraint is the point: a rare, well-aimed question reads as intelligence; a daily prompt reads as a chore.",\n' +
  '    "affirmation": "ONE first-person, warm sentence (10-25 words) affirming something REAL and specific from their OWN data — a streak, a consistency win, an improvement, evidence of showing up. MUST name the actual number/streak/trend it\'s grounded in (e.g. \'I\'ve shown up for cold showers 12 days straight\' or \'My recovery held green through a genuinely heavy week — that\'s real resilience, not luck\'), drawn from the SELF-MODEL, recovery, habits, wealth, or YOU VS PAST YOU data above. NEVER a generic self-help line with no data behind it (\'I show up with joy and courage\', \'everything always works out\') — if you can\'t point to a specific real thing, pick the most genuinely earned option available rather than inventing one. CRITICAL — do not embellish a real fact with an invented feeling, motive, or backstory: naming a completed goal is grounded, but adding \'...which I was worried about\' or \'...even though I doubted myself\' fabricates an emotional state that is not literally stated anywhere in the data above. State the bare, real fact plainly; do not narrate feelings about it unless a feeling is explicitly given (e.g. in wellbeing check-ins or the user\'s own goal text). Always generate one — the self-model always has enough context (a habit rate, a streak, a completed goal, a recovery trend) to find something real and earned to affirm."\n' +
  '  },\n' +
  '  "morningFocus": "1-2 sentences (35-60 words). Chief-of-staff situation report. Use the SELF-MODEL (7-day averages, habit trends, confirmed patterns) as your primary source — it always has context even before today\'s check-in or watch sync. Supplement with any real-time recovery/wellbeing data if present. For HRV: use today\'s reading from Recovery status (e.g. \'HRV 47ms\') — it is the accurate overnight number. The self-model HRV is a 7-day average and will differ. For sleep hours and habit rates, use self-model. Tell them what it means and the one thing that matters most today. Always generate this — never return empty string.",\n' +
  '  "urgentEmails": [\n' +
  '    { "from": "sender", "subject": "subject", "action": "1-2 sentences on what action is needed and why it\'s urgent" }\n' +
  '  ]\n' +
  '}\n\n' +
  'Rules:\n' +
  '- openQuestion: this is a RARE, high-value check-in, not a daily habit. Emit it ONLY when you have a genuine, specific uncertainty about TODAY that the user could resolve in a sentence and that would measurably sharpen tomorrow\'s brief (an unexplained number, an assumption you made about a cause / a rest day / an OOO, a flag you\'re not sure is real). On the majority of days you have no such question — return "" then. Never a generic "anything to flag?", never something you could ask any morning, never a question whose answer is already in the data. One well-aimed question a week beats a prompt every day.\n' +
  '- affirmation: unlike openQuestion, generate this EVERY day — but it must be earned, not generic. Pick the single most genuine, specific, data-backed thing to affirm from what\'s above (a habit streak, a recovery trend holding up, a savings-rate win, a goal closed out, a confirmed pattern they\'re honoring). Say it in first person like something they\'d actually think about themselves, not a poster. A quiet, real "I\'ve kept my sleep above 7 hours for 5 days" beats a loud, empty "I am unstoppable." If several options exist, prefer the one most relevant to today\'s other fields (reinforcing, not repeating, the synthesis) over the single biggest number. State the fact plainly — do not decorate it with an invented feeling or struggle ("...which I was worried about," "...despite my doubts") that is not actually present in the data; a real fact stated straight is more credible than a real fact wrapped in a made-up emotional arc.\n' +
  '- DAY CONTEXT (when present): if today is a weekend or a holiday / day off, the whole brief shifts register — this is NOT a workday. Do NOT frame meeting load, a busy or all-day-blocked calendar, or "open focus windows" as a risk or a lever; an all-day calendar block on a day off is time away from the desk, not a packed schedule. Lead with recovery, rest, family/presence, and enjoying the day; the ACTION should be about protecting the day off (or a genuinely wanted light workout), not shipping work. On the day BEFORE a holiday, you may note the long weekend starting as a light framing, not a warning.\n' +
  '- chiefBrief: this is the centerpiece — write it as a person who KNOWS them, not a report. Sharp, caring, blunt, numerate. The synthesis MUST span domains. Calendar rule: the MEETINGS lines are BUSY time (actual meetings — not focus blocks). The OPEN windows are the real uninterrupted focus stretches. Use meeting density (WORK calendar only) to gauge the day\'s cognitive load. Never call a meeting time a "focus block" or "uninterrupted stretch." The PERSONAL calendar is a different category entirely: a block there (family time, an observance/religious window, a personal appointment) is the user protecting time, never a source of load — do not add its hours to the work calendar\'s busy time, do not call the day "heavy" or "blocked" because of it, and do not let its mere presence override an otherwise light day\'s framing. A MEETINGS block explicitly annotated as matching a personal-calendar event is the SAME commitment showing up twice under different labels, not two separate things — subtract it from any hour count you cite, the same as you would the personal-calendar entry itself. Draw the ACTION from the leverage engine when present, otherwise from the most consequential thing in their finances/habits/inbox/schedule. RISK from at-risk forecasts or a metric genuinely below its healthy range — NOT a metric that merely dipped while still running high (a mood that\'s still high but ticked down slightly is "holding strong", not a risk; when citing mood/energy/focus, always in plain words — low/ok/high — never a raw number like "4.3/5"). MOVE: the most consequential real change — NEVER net worth or a net-worth figure/percentage, and never tie a balance to their work. Surface wealth ONLY as a spending/cashflow insight and ONLY when genuinely notable; otherwise use a habit rate or the composite recovery score. Name actual numbers everywhere. Never invent a tie-in or number. Always generate all four fields. Anti-repetition: check YOUR LAST MORNING BRIEFS before writing — if you\'re about to open with the same topic in roughly the same words, that\'s a sign you\'re on autopilot. Either the data has genuinely moved (say what\'s different, e.g. a new number, a new cause, progress vs stuck) or it\'s a real streak (say so explicitly and change the register — escalate, question, or pivot the ask) — never just re-run the same sentence shape with updated numbers. If a genuinely different domain is more pressing today, lead with THAT instead of defaulting back to yesterday\'s topic out of habit. Calibration: if CALIBRATION CHECK is present and flags a miss, weave a brief, honest acknowledgment into whichever field touches recovery today (synthesis or risk, whichever fits) — a chief of staff who admits a wrong call is more credible than one who never mentions it, but don\'t force this in if recovery isn\'t otherwise part of today\'s brief.\n' +
  '- LIFE CHAPTERS (when present): these are the long arcs the daily numbers live inside — a pregnancy advancing week by week, a date approaching. They inform TONE and PLANNING quietly: never re-announce a chapter as if it\'s news, never manufacture urgency from it, and never use it as filler. Surface a chapter explicitly only when it genuinely intersects today (a milestone week, a date now close enough to act on) — and at most once or twice a week, when the relevant domain is already the topic, you may point at ONE concrete preparation step it implies (e.g. a baby due date → 529 / insurance / cash-buffer prep as a wealth action). A chief of staff who knows a baby is coming plans differently — but says so sparingly. RELAY, DON\'T RESTATE: this same fact is also shown verbatim elsewhere in the app (goals, forecasts, Ask) — your job here is never to just repeat "she\'s pregnant" or "week 14," it\'s to advance the thread with something only TODAY\'s data makes true. Bad: "sending you strength as Nancy enters her second trimester." Good: "second trimester starts this week — that transition has historically dented sleep, worth protecting this week specifically." If you have nothing to add beyond the bare fact, don\'t mention the chapter at all this time.\n' +
  '- THIS WEEK\'S STATED GOALS (when present): these are the user\'s OWN commitments — a real chief of staff tracks them without being asked. From Wednesday onward, if a consequential goal (especially a work deliverable) is still [OPEN], surface exactly ONE: into THE ACTION if it\'s genuinely today\'s highest-leverage move, otherwise woven into the synthesis. Escalate as the week runs out (\'two working days left and the valuation update is still open\'). Use the work calendar\'s open windows to make it concrete (\'the 2:30–6:00 stretch is enough to close it out\'). Mon/Tue: stay quiet unless a goal is explicitly time-critical. Never list all goals, never nag about personal/relational goals in work-pressure terms (a goal like \'be present with family\' gets a gentle nudge, not a deadline). If everything is checked off, one earned sentence at most.\n' +
  '- CRITICAL — goal completion: AUTHORITATIVE LIVE GOAL STATE (when present) is the ONLY source of truth for whether a weekly goal is done. NEVER describe a goal marked OPEN there as done, completed, finished, closed, delivered, or wrapped up — not because a calendar event for it happened today, not because a prior brief implied it, not because similar wording appears elsewhere in this prompt, and not from your own assumption that it probably got done. A meeting or deadline PASSING is not the same as the user checking the goal off. If you are unsure whether a goal is done, treat it as OPEN and say so plainly (e.g. "still open") rather than guessing it\'s finished.\n' +
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

function buildChiefBriefPrompt(emailData, currentDay, workoutPlan, calendarEvents, wellbeingContext = '', annotationsContext = '', recoveryContext = '', experimentsContext = '', selfModel = '', leverageContext = '', workBusyBlocks = [], strengthContext = '', spendingContext = '', continuityContext = '', cashflowContext = '', progressContext = '', weeklyGoalsContext = '', chaptersContext = '', dayOffContext = '', attentionContext = '', openGoals = []) {
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

  // Cross-reference work-calendar busy blocks against NAMED personal-calendar
  // events. Live bug found via a product review: a Sabbath block on the
  // personal calendar ALSO shows up as an anonymous busy chunk on the work
  // calendar's free/busy feed (a common setup — mirroring personal time onto
  // the work calendar so colleagues can't double-book it). The free/busy feed
  // has no titles, so the model had no way to know that chunk was the SAME
  // commitment already named on the personal calendar, and summed it into
  // "8.5h of meetings" anyway — even after being told to treat NAMED personal
  // events as protected, not load, because this block never reached the model
  // labeled as personal at all. Annotate any work-busy block that time-overlaps
  // a named personal event so the two can't be double-counted as separate facts.
  const namedEvents = calendarEvents.filter((e) => !e.allDay && e.startTime && e.endTime);
  const overlapLabel = (block) => {
    const bStart = toMin(block.start), bEnd = toMin(block.end);
    const hit = namedEvents.find((e) => Math.min(bEnd, toMin(e.endTime)) - Math.max(bStart, toMin(e.startTime)) > 0);
    return hit ? ` (matches your personal calendar's "${hit.title}" — not a real meeting, do not count toward meeting load)` : '';
  };

  // AUTHORITATIVE LIVE GOAL STATE — structured, not just the prose
  // weeklyGoalsContext string, so completion state can be enforced
  // programmatically after generation (see findFalseGoalCompletions below).
  // weekly_intentions.goals[].achieved is the SOLE source of truth: a
  // calendar event having happened, a prior brief's wording, similar phrasing
  // elsewhere in this prompt, or the model's own assumption NEVER mark a goal
  // done — only the user's own achieved checkbox does.
  const openGoalsBlock = openGoals.length
    ? `AUTHORITATIVE LIVE GOAL STATE (this OVERRIDES any stale or ambiguous reference to these same goals in the self-model, prior briefs, calendar, or continuity context above — a calendar event having occurred, a prior day's brief, or similar wording elsewhere is NOT evidence of completion):\n` +
      openGoals.map((g) => `- ${g.achieved ? 'DONE' : 'OPEN'}: "${g.text}"`).join('\n') +
      `\nDo NOT describe an OPEN goal above as done, completed, finished, closed, delivered, or wrapped up under any circumstance — only the achieved flag shown here decides completion.\n\n`
    : '';

  const workBusySection = allDayBlock
    ? 'WORK CALENDAR: an ALL-DAY block covers today (out-of-office / PTO / holiday / travel — the free/busy feed has no titles). This is NOT a day packed with meetings; treat it as a day away from the desk. Do NOT say "zero open focus windows" or frame meeting load as a problem.'
    : workBusyBlocks.length > 0
      ? `MEETINGS (busy — no titles): ${workBusyBlocks.map((b) => `${b.start}–${b.end}${overlapLabel(b)}`).join(', ')}\nOPEN windows for focus work: ${openWindows.length ? openWindows.join(', ') : 'none'}`
      : 'No busy blocks visible (calendar may be clear or data unavailable).';

  return `${selfModel ? selfModel + '\n\n---\n\n' : ''}Today is ${currentDay}.
${dayOffContext ? `\nDAY CONTEXT: ${dayOffContext}\n` : ''}
Today's workout: ${workoutPlan.type}${workoutPlan.duration ? ` (${workoutPlan.duration})` : ''}
${workoutPlan.autoSwapNote ? `${workoutPlan.autoSwapNote}\n` : ''}${recoveryContext ? `Recovery status: ${recoveryContext}` : ''}
${experimentsContext ? `\nONGOING SELF-EXPERIMENTS (mention only when genuinely relevant to today's topic — never force it in, never claim more than what's stated, and never describe a flagged-stalled one as actively tracking):\n${experimentsContext}\n` : ''}

Today's calendar (personal — usually light):
${calendarSection}

Work calendar (meeting times and open focus windows):
${workBusySection}

Recent wellbeing (last 7 days): ${wellbeingContext || 'no recent check-in data'}

Active life context: ${annotationsContext || 'none'}

${attentionContext ? `FLAGGED EARLIER TODAY (the attention policy noticed these but judged them not worth a real-time interruption — fold whichever are genuinely relevant into the brief; skip the rest, and never invent detail beyond what's stated):\n${attentionContext}\n\n` : ''}${chaptersContext ? `LIFE CHAPTERS (standing long-arc facts about the user's life right now — auto-updated, always true, the user never needs to repeat them):\n${chaptersContext}\n\n` : ''}${continuityContext ? `${continuityContext}\n\n` : ''}${openGoalsBlock}${weeklyGoalsContext ? `THIS WEEK'S STATED GOALS (the user wrote these themselves at the Sunday check-in — [OPEN] = not yet checked off): ${weeklyGoalsContext}\n\n` : ''}${progressContext ?`YOU VS PAST YOU (longitudinal zoom-out — trailing 4-week averages vs the same measures ~3 months ago; only shifts big enough to be real are listed): ${progressContext}\n\n` : ''}${cashflowContext ? `UPCOMING BILLS WARNING (forward-looking — this hasn't happened yet, don't describe it in the past tense): ${cashflowContext}\n\n` : ''}${spendingContext ? `Spending signal: ${spendingContext}\n\n` : ''}${strengthContext ? `Strength progression (logged lifts): ${strengthContext}\n\n` : ''}${leverageContext ? `${leverageContext}\n\n` : ''}Unread emails (${emailData.length} threads):
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

// Model for the chief-brief call specifically — the one that has to actually
// REASON across body/money/focus/calendar/inbox, not just extract or classify.
// Deliberately NOT the shared ANTHROPIC_MODEL default (Sonnet 5, used for
// every lighter call — wisdom reflections, context adjustment, habit
// parsing): at this call volume (once or twice a day) the price difference
// between tiers is cents, so there's no reason not to spend it on the one
// call that most benefits from it. Independently env-overridable so this
// can be dialed without touching the shared default.
const CHIEF_MODEL = process.env.ANTHROPIC_CHIEF_MODEL || 'claude-opus-4-8';

/** One LLM call + parse + shape-validate. Returns the result shape or null (retryable). */
async function chiefBriefAttempt(prompt, attemptLabel) {
  let text = '';
  try {
    // Chief-brief is the load-bearing call — several dense sections + urgent
    // emails + finance/goal bullets, genuinely cross-domain reasoning, not
    // extraction. It used to force a tool call (jsonMode+jsonSchema) for
    // guaranteed shape — but Anthropic's API refuses to combine forced
    // tool-choice with extended thinking, so the ONE call that most needs to
    // actually reason ran with thinking silently off. Dropped in favor of
    // CHIEF_SYSTEM's own prose JSON instruction (it already says "Return ONLY
    // a single valid JSON object" with the exact schema spelled out) plus the
    // parseAndValidate/extractJson path already used successfully by the
    // wisdom call below — same shape-validation + 2-attempt retry safety net,
    // now with adaptive thinking actually engaged.
    // maxTokens raised well past the old 8192: thinking tokens now share the
    // same budget as the final JSON, and truncating mid-object fails
    // validation with no sign it was a length problem rather than a
    // formatting one. Generous headroom costs nothing — billing is by tokens
    // actually used, not this ceiling.
    text = await llm.generateText({
      system: CHIEF_SYSTEM, prompt, temperature: 0.2, maxTokens: 16384, model: CHIEF_MODEL,
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
          // A data-grounded affirmation (a real streak/win/trend), not the old
          // static "I show up with joy and courage" filler — see the field's
          // prompt instructions above for the grounding requirement.
          affirmation: typeof cb.affirmation === 'string' ? cb.affirmation.trim() : '',
        },
        urgentEmails: Array.isArray(parsed.urgentEmails) ? parsed.urgentEmails : [],
      };
    },
  });
}

// ── Goal-completion semantic guard ──────────────────────────────────────────
// Bug: a still-OPEN weekly goal ("Valuation presentation to Steffan") got
// described as "is done" in the chief brief even though its `achieved`
// checkbox was never checked — the model inferred completion from something
// else (a calendar event having happened, a prior brief's wording, similar
// phrasing elsewhere in the prompt). weekly_intentions.goals[].achieved is
// the SOLE authority for completion. Shape validation (chiefBriefAttempt)
// only checks that fields are non-empty strings — it has no notion of
// whether their CONTENT contradicts known state. This runs AFTER shape
// validation succeeds and catches any field describing an OPEN goal as
// done/completed/finished/closed/delivered, including a loose paraphrase
// (matched by word-overlap against the goal's own text, not just its exact
// title), so "the valuation presentation is finished" is caught even though
// it doesn't repeat the goal's exact wording.
const COMPLETION_VERB_RE =
  /\b(?:is|are|was|were|has been|have been)\s+(?:done|complete|completed|finished|closed(?:\s+out)?|delivered|wrapped(?:\s+up)?|shipped)\b|\bchecked (?:it |that |this )?off\b|\bcrossed (?:it |that |this )?off\b|\bclosed (?:it|that|this) out\b/i;

const GOAL_STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'is', 'are', 'was', 'were', 'with',
  'on', 'in', 'at', 'that', 'this', 'it', 'be', 'has', 'have', 'been', 'your', 'my',
]);

function normalizeGoalWords(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !GOAL_STOPWORDS.has(w));
}

// Fraction of the GOAL's own meaningful words that also appear in the
// sentence. The denominator is deliberately the goal (not the sentence, and
// not the smaller of the two) — a long sentence sharing a couple of
// incidental words with a long goal can't trip this; only a sentence that is
// substantially ABOUT the goal can, which is exactly what "unrelated use of
// a completion verb" (regression test) needs to stay silent on.
function goalOverlapRatio(sentence, goalText) {
  const goalWords = new Set(normalizeGoalWords(goalText));
  if (!goalWords.size) return 0;
  const sentenceWords = new Set(normalizeGoalWords(sentence));
  let common = 0;
  for (const w of goalWords) if (sentenceWords.has(w)) common++;
  return common / goalWords.size;
}

function splitIntoSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

const GOAL_OVERLAP_THRESHOLD = 0.6;

/**
 * Pure: scan every generated field for a sentence that both (a) uses
 * completion language and (b) is substantially about a goal that is still
 * OPEN. `openGoals` is the live, structured list ({ text, achieved }) — only
 * entries with achieved !== true are checked (an achieved:true goal can be
 * freely described as done). Returns an array of
 * { field, sentence, goalText } violations (empty when clean).
 */
function findFalseGoalCompletions({ chiefBrief, morningFocus } = {}, openGoals = []) {
  const open = (openGoals || []).filter((g) => g && g.text && !g.achieved);
  if (!open.length) return [];
  const fields = [
    ['synthesis', chiefBrief?.synthesis],
    ['action', chiefBrief?.action],
    ['risk', chiefBrief?.risk],
    ['move', chiefBrief?.move],
    ['affirmation', chiefBrief?.affirmation],
    ['morningFocus', morningFocus],
  ];
  const violations = [];
  for (const [field, text] of fields) {
    if (!text) continue;
    for (const sentence of splitIntoSentences(text)) {
      if (!COMPLETION_VERB_RE.test(sentence)) continue;
      for (const goal of open) {
        if (goalOverlapRatio(sentence, goal.text) >= GOAL_OVERLAP_THRESHOLD) {
          violations.push({ field, sentence, goalText: goal.text });
        }
      }
    }
  }
  return violations;
}

/**
 * Deterministic, safe correction: replace exactly the offending sentence(s)
 * with a plain, factual statement of the TRUE (open) state. Never leaves a
 * required field empty (which would fail shape validation and force a
 * fallback to a stale prior brief) and never touches any OTHER sentence in
 * the field.
 */
function rewriteFalseGoalCompletions(result, violations) {
  if (!violations.length) return result;
  const byField = new Map();
  for (const v of violations) {
    if (!byField.has(v.field)) byField.set(v.field, []);
    byField.get(v.field).push(v);
  }
  const rewriteText = (text, fieldViolations) => {
    let out = text;
    for (const v of fieldViolations) {
      out = out.split(v.sentence).join(`${v.goalText} is still open.`);
    }
    return out.replace(/\s+/g, ' ').trim();
  };
  const chiefBrief = { ...result.chiefBrief };
  for (const field of ['synthesis', 'action', 'risk', 'move', 'affirmation']) {
    if (byField.has(field)) chiefBrief[field] = rewriteText(chiefBrief[field], byField.get(field));
  }
  const morningFocus = byField.has('morningFocus')
    ? rewriteText(result.morningFocus, byField.get('morningFocus'))
    : result.morningFocus;
  return { ...result, chiefBrief, morningFocus };
}

/** Append a targeted correction describing the exact contradiction(s) found,
 *  for the one-shot semantic-retry call. */
function buildGoalCorrectionPrompt(prompt, violations) {
  const lines = violations.map(
    (v) => `- In "${v.field}" you wrote: "${v.sentence}" — but the goal "${v.goalText}" is STILL OPEN (not checked off). Do not describe it as done, completed, finished, closed, delivered, or wrapped up.`
  );
  return `${prompt}\n\nCORRECTION REQUIRED — your previous attempt contained a factual error about goal completion:\n${lines.join('\n')}\nRegenerate the FULL JSON response with this corrected. Every other fact must remain exactly as accurate as before; do not introduce any new error while fixing this one.`;
}

/** Generate the chief-brief + morningFocus + urgentEmails section only.
 *  `openGoals` is the live, structured weekly-goal state ({ text, achieved }[])
 *  — the sole authority the goal-completion guard checks generated text
 *  against (see findFalseGoalCompletions above). Both the full builder and
 *  the scoped chief-brief rebuild call this same function, so the guard
 *  applies identically to each — no separate, weaker path. */
async function generateChiefBrief(emailData, currentDay, workoutPlan, calendarEvents, wellbeingContext = '', annotationsContext = '', recoveryContext = '', experimentsContext = '', selfModel = '', leverageContext = '', workBusyBlocks = [], strengthContext = '', spendingContext = '', continuityContext = '', cashflowContext = '', progressContext = '', weeklyGoalsContext = '', chaptersContext = '', dayOffContext = '', attentionContext = '', openGoals = []) {
  // Apply the same hard filter as generateEmailBriefs so automated senders
  // never reach the main briefing LLM call either.
  const filteredEmails = filterActionableEmails(emailData);
  const prompt = buildChiefBriefPrompt(filteredEmails, currentDay, workoutPlan, calendarEvents, wellbeingContext, annotationsContext, recoveryContext, experimentsContext, selfModel, leverageContext, workBusyBlocks, strengthContext, spendingContext, continuityContext, cashflowContext, progressContext, weeklyGoalsContext, chaptersContext, dayOffContext, attentionContext, openGoals);

  // One retry on a shape/parse failure — the model call is non-deterministic
  // (temperature 0.2, not 0), and this exact class of failure (silently
  // falling back to yesterday's brief, repeatedly) is what a live user hit.
  // A second attempt with the identical prompt has a real chance of coming
  // back valid; only give up and let the caller fall back after both fail.
  const first = await chiefBriefAttempt(prompt, 'attempt 1/2');
  let result = first || await chiefBriefAttempt(prompt, 'attempt 2/2 (retry)');
  if (!result) return { ...EMPTY_CHIEF };

  // Semantic guard: weekly_intentions.goals[].achieved is the SOLE authority
  // for completion — a shape-valid response can still be factually wrong
  // about it. Runs on the result from whichever shape attempt succeeded.
  const violations = findFalseGoalCompletions(result, openGoals);
  if (!violations.length) return result;

  console.error(`[briefing-ai] chief-brief claimed an OPEN goal was done (${violations.length} instance(s)) — retrying with a targeted correction.`);
  const correctionPrompt = buildGoalCorrectionPrompt(prompt, violations);
  const retry = await chiefBriefAttempt(correctionPrompt, 'attempt 3/3 (goal-completion correction)');
  if (retry) {
    const retryViolations = findFalseGoalCompletions(retry, openGoals);
    if (!retryViolations.length) return retry;
    console.error('[briefing-ai] goal-completion correction retry still contradicted state — rewriting the offending sentence(s) deterministically.');
    return rewriteFalseGoalCompletions(retry, retryViolations);
  }
  // The correction retry failed shape validation entirely — fall back to
  // deterministically rewriting the FIRST valid result rather than losing it
  // (returning EMPTY_CHIEF here would make the caller reuse a POTENTIALLY
  // CONTAMINATED prior brief, which is exactly what this guard exists to avoid).
  console.error('[briefing-ai] goal-completion correction retry failed shape validation — rewriting the original result deterministically instead.');
  return rewriteFalseGoalCompletions(result, violations);
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
  findFalseGoalCompletions, rewriteFalseGoalCompletions,
};
