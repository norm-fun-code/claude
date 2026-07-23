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
const crypto = require('crypto');
const llm = require('../llm');
const { extractJson, parseAndValidate } = require('../llm/parseJson');
const { AnthropicRefusalError, AnthropicMaxTokensError } = llm;
const { validateChiefBriefClaims } = require('../brain/claimValidator');
const { computeCalendarLoad } = require('../intelligence/calendar-load');

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
  'straight days" or "N consecutive nights" of something the user did. Only use ' +
  '"consecutive"/"straight" language when the evidence explicitly states an unbroken run ' +
  '(e.g. RECENT CONTEXT TAGS literally says "occurred N consecutive nights"). For a ' +
  'nightly context tag (alcohol, late meal, magnesium, etc.), use ONLY the exact dated ' +
  'phrasing given in RECENT CONTEXT TAGS ("occurred on K of the last N completed nights", ' +
  'with its exact "the night ending <date>" / "last night" wording) — never compute or ' +
  'invent a percentage-above-baseline for one of these, and never state a streak length ' +
  'that isn\'t the literal number given there. ' +
  'CRITICAL — a RECENT CONTEXT TAGS entry is ALWAYS a historical, already-occurred ' +
  'observation about a COMPLETED past night — it is NEVER evidence of a plan for tonight ' +
  'or today, no matter how recent ("last night" is still the past). Never rephrase one as ' +
  '"tonight," "on deck tonight," "planned for tonight," "coming up," or any other current/ ' +
  'future framing. Only a genuinely planned/upcoming event named ELSEWHERE in the data ' +
  'above (never derived from RECENT CONTEXT TAGS) may be described as happening tonight or ' +
  'today. ' +
  'WRITING: complete, well-punctuated sentences. Never run two independent clauses ' +
  'together without a period, semicolon, or conjunction (no "a strong base for the week your ' +
  'stated focus is…" — close the first thought, then start the next). ' +
  'TIMES: always use a 12-hour clock with am/pm exactly as given in the data (e.g. "2:00 PM", ' +
  '"9:00 AM–6:00 PM"). Never write 24-hour times like "09:00" or "18:00". ' +
  'Return ONLY a single valid JSON object — no markdown, no code fences, no commentary.\n\n' +
  'Return ONLY valid JSON with EXACTLY these fields:\n\n' +
  '{\n' +
  '  "chiefBrief": {\n' +
  '    "synthesis": "ONE sentence (20-35 words): the single most important thing about today, synthesized ACROSS domains (body, money, focus, inbox, schedule). Lead with the domain with the highest urgency or consequence TODAY. Use the WORK calendar free/busy blocks (only) to gauge meeting load — if the day is blocked-up, factor that into the energy/recovery framing. If citing a meeting-hours figure, use TOTAL MEETING LOAD TODAY verbatim — it is already computed net of personal-calendar overlap; never re-sum the raw block list yourself. Do NOT anchor on an empty personal calendar; assume a real workday. NEVER count a personal-calendar event (family time, an observance/religious block like a Sabbath window, a personal appointment) toward \\"heavy,\\" \\"blocked,\\" or \\"packed\\" — blocking personal time off is protecting it, the opposite of a demanding calendar; describe it as protected time if you mention it at all, never sum its hours into a workload figure. This applies EQUALLY to a work-calendar busy block explicitly marked as matching a personal-calendar event (the free/busy feed mirrors that same commitment there too, under a different, titleless entry) — treat it exactly like the personal one, never as separate meeting hours on top of it. When referencing health, use the recovery BAND (green/yellow/red) or score, not raw HRV. Name a real number. State any recovery or sleep SCORE as a bare number (e.g. \\"Recovery is green at 90\\"), NEVER as \\"90/100\\" or \\"90 out of 100\\" — the headline shows the number itself, not a fraction. If PERSISTENT ISSUES shows today\'s lead topic has been open 3+ days, do NOT re-derive and re-explain it as if fresh — name the streak length plainly (e.g. \'steps — day 4 of the same flag\') and shift to why it hasn\'t moved or what\'s actually different today, rather than restating the original setup.",\n' +
  '    "action": "THE ACTION (1-2 sentences). The highest-leverage thing to do NOW — draw from the HIGHEST-LEVERAGE ACTIONS block (leverage engine) above when present. Concrete and doable today. Tie to an observed pattern in their own data when relevant (\'on Zone 2 days your recovery score tends to run higher the next morning\') — this is an association from OBSERVED PATTERNS in the self-model, not a proven cause: never call it "confirmed," never use an arrow or "drives"/"causes"/"boosts"/"effect" language for it, unless PROVEN ON THEM explicitly lists a completed, confirmed self-experiment for that exact relationship — only then may you state it as settled. CHECK LAST ACTION SUGGESTED FIRST — this is a real chief of staff who follows up, not one who forgets what they said yesterday: if it shows \'did not help\' / \'no effect\', do NOT suggest the identical thing again — propose a genuinely different mechanism; if it shows it worked, briefly acknowledge that win before moving to today\'s action (reinforcement, not silence). If it shows the outcome is STILL BEING MEASURED, that is normal and automatic — outcomes are judged from their own data (recommendations after ~a week; experiments run to their end date), the user has no feedback to give and nowhere they\'re supposed to give it. NEVER say they \'haven\'t given feedback\', never count days waiting, never make the follow-up itself the action — at most a half-sentence of quiet continuity using ONLY the ACTUAL item named in LAST ACTION SUGGESTED above, then give a REAL action for today. Do NOT invent, name, or reference any experiment, recommendation, or \\"still logging in the background\\" continuity that isn\'t literally given to you in the data above — if LAST ACTION SUGGESTED is empty or absent, skip the continuity clause entirely and go straight to today\'s action. A fabricated callback (naming an experiment that was never in the context) is worse than no callback at all. Only when LAST ACTION SUGGESTED is absent, stale (not shown), or clearly resolved should you pick a fresh action with no callback. If WEEK-AHEAD PERIODIZATION is present and nothing higher-priority is competing for this slot, it can BE today\'s action (e.g. \'ease off intensity today so tomorrow\'s session doesn\'t stack on top of an already-elevated load\'). TRAINING-AWARE: any movement/training advice MUST acknowledge \\"Today\'s workout\\" from the data above — never prescribe walks or extra cardio as if the day were empty when a session is already planned. Frame it relative to the plan: additive (\'walks on top of today\'s intervals — the session alone won\'t fix a steps deficit\'), sequenced (\'after today\'s Push session\'), or a swap only when recovery genuinely argues for it. An action that ignores the planned session reads as a bot, not a chief of staff.",\n' +
  '    "risk": "THE RISK (1-2 sentences). The ONE thing trending wrong — draw from the TRENDING WRONG block (at-risk forecasts) or a genuinely slipping habit / declining metric. CRITICAL: gate on ABSOLUTE level, not just direction. A metric still in a healthy range (mood/energy/focus ≥4/5, sleep ≥7h, recovery green) is NOT a risk even if it ticked down vs last week — that\'s \'holding strong\', and you should say so rather than inventing a downtrend. Reserve RISK for something actually below its healthy range, a sustained multi-week decline, or an at-risk forecast. Never manufacture alarm from normal day-to-day variation on a coarse 1–5 scale. If genuinely nothing is at risk, say what to protect to keep it that way.",\n' +
  '    "move": "THE MOVE (1-2 sentences). The single most consequential thing that CHANGED (or, if UPCOMING BILLS WARNING is present, that\'s ABOUT TO hit) and why it matters. HARD RULE: never mention net worth or any net-worth figure or percentage, and never tie a balance to their work — it\'s noise in a daily brief. Wealth belongs here ONLY as a spending/cashflow insight, and ONLY when genuinely notable: a spend spike, an unusual category, savings rate/budget pace moved meaningfully, OR an UPCOMING BILLS WARNING (this one is forward-looking — frame it as a heads-up before it lands, e.g. \'rent hits Friday and will eat most of your buffer\', never as something that already happened). UPCOMING BILLS WARNING takes priority over a routine spend observation when present. If neither applies, do NOT force a finance line — draw THE MOVE from a real changed number in habits, recovery, or sleep instead. Name the before→after (or now→upcoming) and the implication.",\n' +
  '    "openQuestion": "AT MOST ONE short question (≤ ~15 words) — the SINGLE thing you\'re genuinely uncertain about today whose answer would most improve tomorrow\'s read, phrased like a sharp friend checking in (\'HRV dipped — the Goose show, or something else?\'; \'Called today a rest day — still right?\'). STRICT: only when you have a REAL, SPECIFIC uncertainty tied to today\'s data — a number you can\'t explain, an assumption you made (a rest day, an OOO, a cause), a flag you\'re not sure is real. Return EMPTY STRING on any day you don\'t have a genuinely valuable question — most days. NEVER a generic \'anything to flag?\', never a question you could ask any day, never one whose answer you already have. Restraint is the point: a rare, well-aimed question reads as intelligence; a daily prompt reads as a chore.",\n' +
  '    "affirmation": "ONE first-person, warm sentence (10-25 words) affirming something REAL and specific from their OWN data — a streak, a consistency win, an improvement, evidence of showing up. MUST name the actual number/streak/trend it\'s grounded in (e.g. \'I\'ve shown up for cold showers 12 days straight\' or \'My recovery held green through a genuinely heavy week — that\'s real resilience, not luck\'), drawn from the SELF-MODEL, recovery, habits, wealth, or YOU VS PAST YOU data above. NEVER a generic self-help line with no data behind it (\'I show up with joy and courage\', \'everything always works out\') — if you can\'t point to a specific real thing, pick the most genuinely earned option available rather than inventing one. CRITICAL — do not embellish a real fact with an invented feeling, motive, or backstory: naming a completed goal is grounded, but adding \'...which I was worried about\' or \'...even though I doubted myself\' fabricates an emotional state that is not literally stated anywhere in the data above. State the bare, real fact plainly; do not narrate feelings about it unless a feeling is explicitly given (e.g. in wellbeing check-ins or the user\'s own goal text). Always generate one — the self-model always has enough context (a habit rate, a streak, a completed goal, a recovery trend) to find something real and earned to affirm."\n' +
  '  },\n' +
  '  "morningFocus": "1-2 sentences (35-60 words). Chief-of-staff situation report. Use the SELF-MODEL (7-day averages, habit trends, observed patterns) as your primary source — it always has context even before today\'s check-in or watch sync. Supplement with any real-time recovery/wellbeing data if present. For HRV: use today\'s reading from Recovery status (e.g. \'HRV 47ms\') — it is the accurate overnight number. The self-model HRV is a 7-day average and will differ. For sleep hours and habit rates, use self-model. Tell them what it means and the one thing that matters most today. Always generate this — never return empty string.",\n' +
  '  "urgentEmails": [\n' +
  '    { "from": "sender", "subject": "subject", "action": "1-2 sentences on what action is needed and why it\'s urgent" }\n' +
  '  ]\n' +
  '}\n\n' +
  'Rules:\n' +
  '- openQuestion: this is a RARE, high-value check-in, not a daily habit. Emit it ONLY when you have a genuine, specific uncertainty about TODAY that the user could resolve in a sentence and that would measurably sharpen tomorrow\'s brief (an unexplained number, an assumption you made about a cause / a rest day / an OOO, a flag you\'re not sure is real). On the majority of days you have no such question — return "" then. Never a generic "anything to flag?", never something you could ask any morning, never a question whose answer is already in the data. One well-aimed question a week beats a prompt every day.\n' +
  '- affirmation: unlike openQuestion, generate this EVERY day — but it must be earned, not generic. Pick the single most genuine, specific, data-backed thing to affirm from what\'s above (a habit streak, a recovery trend holding up, a savings-rate win, a goal closed out, an observed pattern they\'re honoring). Say it in first person like something they\'d actually think about themselves, not a poster. A quiet, real "I\'ve kept my sleep above 7 hours for 5 days" beats a loud, empty "I am unstoppable." If several options exist, prefer the one most relevant to today\'s other fields (reinforcing, not repeating, the synthesis) over the single biggest number. State the fact plainly — do not decorate it with an invented feeling or struggle ("...which I was worried about," "...despite my doubts") that is not actually present in the data; a real fact stated straight is more credible than a real fact wrapped in a made-up emotional arc.\n' +
  '- DAY CONTEXT (when present): if today is a weekend or a holiday / day off, the whole brief shifts register — this is NOT a workday. Do NOT frame meeting load, a busy or all-day-blocked calendar, or "open focus windows" as a risk or a lever; an all-day calendar block on a day off is time away from the desk, not a packed schedule. Lead with recovery, rest, family/presence, and enjoying the day; the ACTION should be about protecting the day off (or a genuinely wanted light workout), not shipping work. On the day BEFORE a holiday, you may note the long weekend starting as a light framing, not a warning.\n' +
  '- chiefBrief: this is the centerpiece — write it as a person who KNOWS them, not a report. Sharp, caring, blunt, numerate. The synthesis MUST span domains. Calendar rule: the MEETINGS lines are BUSY time (actual meetings — not focus blocks). The OPEN windows are the real uninterrupted focus stretches. Use meeting density (WORK calendar only) to gauge the day\'s cognitive load. Never call a meeting time a "focus block" or "uninterrupted stretch." The PERSONAL calendar is a different category entirely: a block there (family time, an observance/religious window, a personal appointment) is the user protecting time, never a source of load — do not add its hours to the work calendar\'s busy time, do not call the day "heavy" or "blocked" because of it, and do not let its mere presence override an otherwise light day\'s framing. A MEETINGS block explicitly annotated as matching a personal-calendar event is the SAME commitment showing up twice under different labels, not two separate things — subtract it from any hour count you cite, the same as you would the personal-calendar entry itself. Draw the ACTION from the leverage engine when present, otherwise from the most consequential thing in their finances/habits/inbox/schedule. RISK from at-risk forecasts or a metric genuinely below its healthy range — NOT a metric that merely dipped while still running high (a mood that\'s still high but ticked down slightly is "holding strong", not a risk; when citing mood/energy/focus, always in plain words — low/ok/high — never a raw number like "4.3/5"). MOVE: the most consequential real change — NEVER net worth or a net-worth figure/percentage, and never tie a balance to their work. Surface wealth ONLY as a spending/cashflow insight and ONLY when genuinely notable; otherwise use a habit rate or the composite recovery score. Name actual numbers everywhere. Never invent a tie-in or number. Always generate all four fields. Anti-repetition: check YOUR LAST MORNING BRIEFS before writing — if you\'re about to open with the same topic in roughly the same words, that\'s a sign you\'re on autopilot. Either the data has genuinely moved (say what\'s different, e.g. a new number, a new cause, progress vs stuck) or it\'s a real streak (say so explicitly and change the register — escalate, question, or pivot the ask) — never just re-run the same sentence shape with updated numbers. If a genuinely different domain is more pressing today, lead with THAT instead of defaulting back to yesterday\'s topic out of habit. Calibration: if CALIBRATION CHECK is present and flags a miss, weave a brief, honest acknowledgment into whichever field touches recovery today (synthesis or risk, whichever fits) — a chief of staff who admits a wrong call is more credible than one who never mentions it, but don\'t force this in if recovery isn\'t otherwise part of today\'s brief.\n' +
  '- LIFE CHAPTERS (when present): these are the long arcs the daily numbers live inside — a pregnancy advancing week by week, a date approaching. They inform TONE and PLANNING quietly: never re-announce a chapter as if it\'s news, never manufacture urgency from it, and never use it as filler. Surface a chapter explicitly only when it genuinely intersects today (a milestone week, a date now close enough to act on) — and at most once or twice a week, when the relevant domain is already the topic, you may point at ONE concrete preparation step it implies (e.g. a baby due date → 529 / insurance / cash-buffer prep as a wealth action). A chief of staff who knows a baby is coming plans differently — but says so sparingly. RELAY, DON\'T RESTATE: this same fact is also shown verbatim elsewhere in the app (goals, forecasts, Ask) — your job here is never to just repeat "she\'s pregnant" or "week 14," it\'s to advance the thread with something only TODAY\'s data makes true. Bad: "sending you strength as Nancy enters her second trimester." Good: "second trimester starts this week — that transition has historically dented sleep, worth protecting this week specifically." If you have nothing to add beyond the bare fact, don\'t mention the chapter at all this time.\n' +
  '- THIS WEEK\'S STATED GOALS (when present): these are the user\'s OWN commitments — a real chief of staff tracks them without being asked. From Wednesday onward, if a consequential goal (especially a work deliverable) is still [OPEN], surface exactly ONE: into THE ACTION if it\'s genuinely today\'s highest-leverage move, otherwise woven into the synthesis. Escalate as the week runs out (\'two working days left and the valuation update is still open\'). Use the work calendar\'s open windows to make it concrete (\'the 2:30–6:00 stretch is enough to close it out\'). Mon/Tue: stay quiet unless a goal is explicitly time-critical. Never list all goals, never nag about personal/relational goals in work-pressure terms (a goal like \'be present with family\' gets a gentle nudge, not a deadline). If everything is checked off, one earned sentence at most.\n' +
  '- CRITICAL — goal completion: AUTHORITATIVE LIVE GOAL STATE (when present) is the ONLY source of truth for whether a weekly goal is done. NEVER describe a goal marked OPEN there as done, completed, finished, closed, delivered, or wrapped up — not because a calendar event for it happened today, not because a prior brief implied it, not because similar wording appears elsewhere in this prompt, and not from your own assumption that it probably got done. A meeting or deadline PASSING is not the same as the user checking the goal off. If you are unsure whether a goal is done, treat it as OPEN and say so plainly (e.g. "still open") rather than guessing it\'s finished.\n' +
  '- YOU VS PAST YOU (when present — Monday\'s zoom-out): weave the single strongest shift into synthesis or morningFocus as perspective the daily numbers hide ("resting HR averaged 57 three months ago — it\'s 54 now"). An improvement is earned and gets named plainly — this is the payoff of the daily work, not flattery. A regression gets named just as honestly, framed as this week\'s quiet project, not a crisis. Use at most ONE shift; never let it displace something genuinely urgent today; never manufacture a longitudinal claim when this block is absent.\n' +
  '- RECOVERY CAUSATION: if you state or imply a CAUSE for today\'s recovery score/HRV/RHR (e.g. "recovery dipped because of X," "X explains the lower HRV"), X MUST come from ELIGIBLE RECOVERY DRIVERS — nothing else qualifies, no matter how health-plausible it sounds: not Active life context, not a habit or trend from the self-model, not something you infer. If ELIGIBLE RECOVERY DRIVERS is empty, do not name a cause at all — say the cause is unclear/unknown, or simply report the number without explaining it. It is always better to say "not sure why" than to guess.\n' +
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

function buildChiefBriefPrompt(emailData, currentDay, workoutPlan, calendarEvents, wellbeingContext = '', annotationsContext = '', recoveryContext = '', experimentsContext = '', selfModel = '', leverageContext = '', workBusyBlocks = [], strengthContext = '', spendingContext = '', continuityContext = '', cashflowContext = '', progressContext = '', weeklyGoalsContext = '', chaptersContext = '', dayOffContext = '', attentionContext = '', openGoals = [], recoveryDriversContext = '', calendarSourcesAvailable = { workBusy: true, calendar: true }, answeredQuestionsContext = '', classifiedOverrides = [], nightlyContextHistoryContext = '') {
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

  // Canonical calendar-load projection (shared with pre-brief-signals.js's
  // packed_calendar question — see intelligence/calendar-load.js) computes
  // the open focus windows, the all-day/OOO detection, and which work-busy
  // blocks overlap a NAMED personal-calendar event (e.g. a Sabbath block
  // mirrored onto the work calendar's titleless free/busy feed as a separate
  // anonymous chunk — without this the model summed it into "8.5h of
  // meetings" on top of the personal-calendar entry for the same commitment).
  // classifiedOverrides — user calendar-classification corrections ("that's
  // a Sabbath block, not meetings") already matched to a specific
  // work-busy/calendar interval by context-resolver.js's
  // matchCalendarClassifications (harden pass, item 3a). Passed straight
  // through to computeCalendarLoad, which nets them out of meeting load via
  // the identical mechanism a real named personal-calendar event already
  // uses — this is what makes the correction change the ACTUAL computed
  // meeting hours the model sees below, not just prose the claim validator
  // rejects after the fact.
  const calendarLoad = computeCalendarLoad({
    workBusy: workBusyBlocks, calendar: calendarEvents, sourcesAvailable: calendarSourcesAvailable, classifiedOverrides,
  });
  const allDayBlock = calendarLoad.isAllDayBlocked;
  const openWindows = calendarLoad.openWindows;
  const overlapLabel = (block) => {
    const title = calendarLoad.overlapTitleFor(block);
    return title ? ` (matches your personal calendar's "${title}" — not a real meeting, do not count toward meeting load)` : '';
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

  // The authoritative meeting-load total, computed deterministically (not
  // left for the model to sum from the block list) — net of any block
  // overlapping a named personal-calendar event, so the number itself can
  // never double-count a mirrored Sabbath/family-time/appointment block. The
  // model should CITE this figure rather than re-derive one from the raw
  // block list below.
  //
  // calendarLoad.degraded (a required source's fetch failed — see
  // calendar-load.js) takes priority over every other branch: workBusyBlocks
  // can be non-empty (the work free/busy feed succeeded) while the personal
  // calendar fetch failed, which is exactly the state that reproduces the
  // mirrored-Sabbath double-count if a number gets cited anyway. Never sum
  // or cite meetingHours in that state — tell the model the figure is
  // unavailable and to avoid asserting a meeting-load claim at all.
  const workBusySection = calendarLoad.degraded
    ? `WORK CALENDAR: meeting-load data is INCOMPLETE right now (${calendarLoad.degradedReason === 'calendar_unavailable' ? 'the personal calendar' : 'the work calendar'} failed to load), so no reliable meeting-hours total or busy/free breakdown is available. Do NOT state a number of meeting hours, do NOT say the day is "packed" or "light," and do NOT list specific busy blocks or open windows — acknowledge the data gap in passing if relevant, otherwise omit calendar load from today's brief entirely.`
    : allDayBlock
      ? 'WORK CALENDAR: an ALL-DAY block covers today (out-of-office / PTO / holiday / travel — the free/busy feed has no titles). This is NOT a day packed with meetings; treat it as a day away from the desk. Do NOT say "zero open focus windows" or frame meeting load as a problem.'
      : workBusyBlocks.length > 0
        ? `TOTAL MEETING LOAD TODAY (authoritative — already net of any personal-calendar overlap; cite this figure, do not re-sum the block list below): ${calendarLoad.meetingHours.toFixed(1)}h\n` +
          `MEETINGS (busy — no titles): ${workBusyBlocks.map((b) => `${b.start}–${b.end}${overlapLabel(b)}`).join(', ')}\nOPEN windows for focus work: ${openWindows.length ? openWindows.join(', ') : 'none'}`
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

Active life context (acknowledge if relevant — NEVER cite anything here as a cause of today's recovery number, even if it sounds health-related; that requires ELIGIBLE RECOVERY DRIVERS below): ${annotationsContext || 'none'}

ELIGIBLE RECOVERY DRIVERS (the ONLY things that may explain today's recovery score/HRV/RHR — already filtered to the exact overnight window that produced today's reading): ${recoveryDriversContext || 'none identified'}
${recoveryDriversContext ? '' : 'If recovery moved and you reference a cause, you have NO eligible driver to cite — say the cause is unknown/unclear rather than guessing from Active life context, a habit, or anything not listed here.\n'}
${answeredQuestionsContext ? `ALREADY ANSWERED TODAY (do NOT set openQuestion to any of these, or a close paraphrase of one — a deterministic check will strip it anyway, but asking again reads as not listening; instead, fold the answer in as live context for today's synthesis, exactly like any other fact above):\n${answeredQuestionsContext}\n\n` : ''}${attentionContext ? `FLAGGED EARLIER TODAY (the attention policy noticed these but judged them not worth a real-time interruption — fold whichever are genuinely relevant into the brief; skip the rest, and never invent detail beyond what's stated):\n${attentionContext}\n\n` : ''}${chaptersContext ? `LIFE CHAPTERS (standing long-arc facts about the user's life right now — auto-updated, always true, the user never needs to repeat them):\n${chaptersContext}\n\n` : ''}${continuityContext ? `${continuityContext}\n\n` : ''}${nightlyContextHistoryContext ? `${nightlyContextHistoryContext}\n\n` : ''}${openGoalsBlock}${weeklyGoalsContext ? `THIS WEEK'S STATED GOALS (the user wrote these themselves at the Sunday check-in — [OPEN] = not yet checked off): ${weeklyGoalsContext}\n\n` : ''}${progressContext ?`YOU VS PAST YOU (longitudinal zoom-out — trailing 4-week averages vs the same measures ~3 months ago; only shifts big enough to be real are listed): ${progressContext}\n\n` : ''}${cashflowContext ? `UPCOMING BILLS WARNING (forward-looking — this hasn't happened yet, don't describe it in the past tense): ${cashflowContext}\n\n` : ''}${spendingContext ? `Spending signal: ${spendingContext}\n\n` : ''}${strengthContext ? `Strength progression (logged lifts): ${strengthContext}\n\n` : ''}${leverageContext ? `${leverageContext}\n\n` : ''}Unread emails (${emailData.length} threads):
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
// Sonnet 5 with adaptive thinking + medium effort (below) is the current
// default: comparable reasoning quality to Opus-tier for this call at a
// fraction of the cost, at this call volume (once or twice a day) still a
// negligible absolute spend either way — this is a cost/quality dial, not a
// capability cliff. Independently env-overridable (ANTHROPIC_CHIEF_MODEL) so
// Railway can pin a different model (e.g. back to an Opus tier) without
// touching this file or the shared ANTHROPIC_MODEL default (used for every
// lighter call — wisdom reflections, context adjustment, habit parsing).
const CHIEF_MODEL = process.env.ANTHROPIC_CHIEF_MODEL || 'claude-sonnet-5';

// Reasoning depth for the chief-brief call (output_config.effort). 'medium'
// is the current default — a deliberate cost/quality balance point paired
// with Sonnet 5 above, not a ceiling: independently overridable
// (ANTHROPIC_CHIEF_EFFORT) up to 'xhigh'/'max' without touching CHIEF_MODEL,
// e.g. if a stronger model is pinned via the override above. Validated
// against Anthropic's actual accepted values at require time (i.e. at server
// boot, since this module is required from routes/briefing.js at startup)
// rather than left to surface as a 400 on the first real request — an
// invalid value would otherwise fail identically on both attempts of every
// single brief build, burning two paid calls for nothing.
const VALID_CHIEF_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CHIEF_EFFORT = process.env.ANTHROPIC_CHIEF_EFFORT || 'medium';
if (!VALID_CHIEF_EFFORTS.has(CHIEF_EFFORT)) {
  throw new Error(
    `Invalid ANTHROPIC_CHIEF_EFFORT "${CHIEF_EFFORT}" — must be one of: ${[...VALID_CHIEF_EFFORTS].join(', ')}.`
  );
}

// maxTokens for the chief-brief call. Thinking tokens share this budget with
// the final JSON, so the right ceiling depends on effort: xhigh/max produce
// substantially more thinking output on Opus-tier models, and Anthropic
// recommends at least 65536 max_tokens at those levels so a genuinely
// complete response isn't truncated by a cap sized for a lower tier.
// low/medium/high (the current default) start at a smaller, still-generous
// ceiling and only pay for more on an actual max_tokens truncation (see the
// error-specific retry policy below). CHIEF_MAX_TOKENS_CEILING is a
// conservative absolute cap this app never exceeds regardless of which
// Anthropic model CHIEF_MODEL is pinned to — sized at the top end of the
// Opus tier so it stays a genuine ceiling if a caller overrides CHIEF_MODEL
// back to one, not a per-model exact limit.
const CHIEF_MAX_TOKENS_BASE = 16384;
const CHIEF_MAX_TOKENS_XHIGH_MIN = 65536;
const CHIEF_MAX_TOKENS_CEILING = 128000;
function chiefInitialMaxTokens() {
  return CHIEF_EFFORT === 'xhigh' || CHIEF_EFFORT === 'max' ? CHIEF_MAX_TOKENS_XHIGH_MIN : CHIEF_MAX_TOKENS_BASE;
}
function chiefBumpedMaxTokens(initial) {
  return Math.min(initial * 2, CHIEF_MAX_TOKENS_CEILING);
}

// Native Structured Outputs schema (output_config.format) for the chief-brief
// call. This is the guaranteed-shape mechanism that composes with extended
// thinking — unlike the OLDER forced-tool-call approach (jsonMode+jsonSchema
// on the anthropic provider), which the API refuses to combine with
// `thinking`. `additionalProperties: false` is required on every object node
// for Anthropic's Structured Outputs; no numeric/string-length constraints or
// recursive refs are used, so the schema needs no further simplification to
// fit the documented complexity limits.
const CHIEF_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chiefBrief: {
      type: 'object',
      additionalProperties: false,
      properties: {
        synthesis: { type: 'string' },
        action: { type: 'string' },
        risk: { type: 'string' },
        move: { type: 'string' },
        openQuestion: { type: 'string' },
        affirmation: { type: 'string' },
      },
      required: ['synthesis', 'action', 'risk', 'move', 'openQuestion', 'affirmation'],
    },
    morningFocus: { type: 'string' },
    urgentEmails: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
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

// Business-logic shape check + transform, run on the parsed structured-output
// object. Schema validity (types, required keys) is already guaranteed by
// output_config.format — this layer only enforces the stricter internal
// contract the rest of the app relies on (non-empty required strings, the
// openQuestion length floor, urgentEmails as an array), the same contract the
// old forced-tool/prose-JSON path enforced. Returns null (retryable) if the
// four core fields aren't all present non-empty strings.
function validateChiefBriefShape(parsed, attemptLabel, correlationId) {
  const cb = parsed.chiefBrief;
  const shapeOk = cb && typeof cb === 'object' && CHIEF_REQUIRED_FIELDS.every((k) => typeof cb[k] === 'string' && cb[k].trim());
  if (!shapeOk) {
    // Field NAMES only (e.g. "risk missing/empty") — never the field values,
    // which is where the sensitive health/finance/goal content actually is.
    const missing = !cb || typeof cb !== 'object'
      ? 'chiefBrief missing or not an object'
      : CHIEF_REQUIRED_FIELDS.filter((k) => !(typeof cb[k] === 'string' && cb[k].trim())).join(', ') + ' missing/empty';
    console.error(`[briefing-ai] chief-brief shape invalid (${attemptLabel}) [correlationId=${correlationId}]: ${missing}.`);
    return null;
  }
  // Defensively normalize any "NN/100" the model still writes down to the bare
  // number ("90/100" -> "90") in the user-facing prose fields. The headline
  // (synthesis) must never show a "/100" fraction; applied to the other text
  // fields too so a stray "sleep score 82/100" reads clean as well. The
  // deterministic grounded fallback already emits a bare number
  // (claimValidator.js), so this only catches a fresh generation.
  const stripScoreDenominator = (s) => (typeof s === 'string' ? s.replace(/\b(\d{1,3})\s*\/\s*100\b/g, '$1') : s);
  return {
    morningFocus: stripScoreDenominator(typeof parsed.morningFocus === 'string' ? parsed.morningFocus : ''),
    chiefBrief: {
      synthesis: stripScoreDenominator(cb.synthesis), action: stripScoreDenominator(cb.action),
      risk: stripScoreDenominator(cb.risk), move: stripScoreDenominator(cb.move),
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
}

/**
 * One LLM call + parse + shape-validate.
 *
 * Returns `{ result, failureType }`: `result` is the validated brief shape or
 * null; `failureType` is null on success or one of 'refusal' | 'max_tokens' |
 * 'network' | 'parse' | 'shape' — the caller (generateChiefBrief) branches on
 * this to decide whether/how to retry (see the retry policy there). Never
 * logs response content — chief briefs carry health, finance, email, and
 * goal data, so every log line here is restricted to safe metadata: model,
 * response length, stop reason, attempt label, and the request/correlation
 * IDs needed to trace one failure across log lines.
 */
async function chiefBriefAttempt(prompt, attemptLabel, { maxTokens, correlationId }) {
  let text, stopReason, requestId;
  try {
    // Chief-brief is the load-bearing call — several dense sections + urgent
    // emails + finance/goal bullets, genuinely cross-domain reasoning, not
    // extraction. It used to force a tool call (jsonMode+jsonSchema) for
    // guaranteed shape, which the API refuses to combine with extended
    // thinking — so the ONE call that most needs to actually reason ran with
    // thinking silently off. It then briefly went through a free-form-prose
    // "ask nicely in the system prompt, repair/parse whatever comes back"
    // approach, which traded the thinking bug for a schema guarantee. Native
    // Structured Outputs (output_config.format below) removes that tradeoff
    // entirely: the response is schema-constrained server-side AND thinking
    // stays on — no forced tool, no tool_choice, no prefill.
    //
    // No `temperature` here: the Anthropic provider never forwards it (Opus
    // 4.6+/5 reject non-default sampling parameters with a 400), so passing
    // one is dead weight. Response variability across attempts comes from
    // the model's own adaptive-thinking sampling, not a temperature knob.
    //
    // `provider: 'anthropic'` pins this call to the Anthropic provider
    // regardless of the globally configured LLM_PROVIDER — CHIEF_MODEL is
    // always an Anthropic model ID, and Structured Outputs + adaptive
    // thinking are Anthropic-specific, so routing through whatever provider
    // happens to be globally configured (e.g. LLM_PROVIDER=gemini) would
    // silently mishandle or reject these options. Going through the `llm`
    // module's provider override (rather than requiring
    // '../llm/providers/anthropic' directly here) keeps provider resolution
    // in one place.
    ({ text, stopReason, requestId } = await llm.generateText({
      system: CHIEF_SYSTEM, prompt, maxTokens, model: CHIEF_MODEL,
      outputSchema: CHIEF_JSON_SCHEMA, effort: CHIEF_EFFORT,
      provider: 'anthropic', returnMeta: true,
    }));
  } catch (err) {
    if (err instanceof AnthropicRefusalError) {
      console.error(
        `[briefing-ai] chief-brief refused (${attemptLabel}) [correlationId=${correlationId}] ` +
        `model=${CHIEF_MODEL} category=${err.category || 'unspecified'} requestId=${err.requestId || 'n/a'}`
      );
      return { result: null, failureType: 'refusal' };
    }
    if (err instanceof AnthropicMaxTokensError) {
      console.error(
        `[briefing-ai] chief-brief truncated at max_tokens (${attemptLabel}) [correlationId=${correlationId}] ` +
        `model=${CHIEF_MODEL} maxTokens=${maxTokens} responseLength=${err.responseLength ?? 'n/a'} requestId=${err.requestId || 'n/a'}`
      );
      return { result: null, failureType: 'max_tokens' };
    }
    console.error(`[briefing-ai] chief-brief generation failed (${attemptLabel}) [correlationId=${correlationId}]:`, err.message);
    return { result: null, failureType: 'network' };
  }

  // Structured Outputs guarantees schema-valid JSON here (refusal and
  // max_tokens — the two documented ways that guarantee can fail — are both
  // already handled above, as thrown errors, before this line runs). So this
  // is a direct JSON.parse, NOT the prose-JSON repair path (extractJson's
  // code-fence stripping / brace-slicing / control-character patching) that
  // parseAndValidate uses for the wisdom call below — that repair machinery
  // existed to rescue free-form prose that was never schema-constrained to
  // begin with, which no longer describes this call. A parse failure here
  // means the API contract broke, not that the model wrote slightly-off
  // prose, and should fail loudly rather than be silently patched — but
  // still WITHOUT logging the actual (potentially sensitive) response text;
  // only its length and the parser's own error message.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(
      `[briefing-ai] chief-brief (${attemptLabel}) [correlationId=${correlationId}]: structured-output response was ` +
      `not valid JSON — model=${CHIEF_MODEL} responseLength=${text.length} stopReason=${stopReason || 'unknown'} ` +
      `requestId=${requestId || 'n/a'} parseError=${err.message}`
    );
    return { result: null, failureType: 'parse' };
  }

  const result = validateChiefBriefShape(parsed, attemptLabel, correlationId);
  return { result, failureType: result ? null : 'shape' };
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
async function generateChiefBrief(emailData, currentDay, workoutPlan, calendarEvents, wellbeingContext = '', annotationsContext = '', recoveryContext = '', experimentsContext = '', selfModel = '', leverageContext = '', workBusyBlocks = [], strengthContext = '', spendingContext = '', continuityContext = '', cashflowContext = '', progressContext = '', weeklyGoalsContext = '', chaptersContext = '', dayOffContext = '', attentionContext = '', openGoals = [], snapshotFacts = null, recoveryDriversContext = '', calendarSourcesAvailable = { workBusy: true, calendar: true }, answeredQuestionsContext = '', nightlyContextHistoryContext = '') {
  // Apply the same hard filter as generateEmailBriefs so automated senders
  // never reach the main briefing LLM call either.
  const filteredEmails = filterActionableEmails(emailData);

  // Match any active calendar-classification correction ("that's a Sabbath
  // block, not meetings") against TODAY's real calendar/workBusy intervals
  // off the SAME resolvedContext already carried on snapshotFacts for claim
  // validation — no extra fetch/param needed at either call site. Best-effort:
  // a matching failure must never block brief generation, it just means the
  // correction isn't reflected in this build's meeting-load number (the claim
  // validator's checkResolvedContextConflicts still catches stale prose).
  let classifiedOverrides = [];
  if (snapshotFacts?.resolvedContext) {
    try {
      classifiedOverrides = require('../intelligence/context-resolver')
        .matchCalendarClassifications(snapshotFacts.resolvedContext, { calendar: calendarEvents, workBusy: workBusyBlocks });
    } catch (e) { console.error('[chief-brief] matchCalendarClassifications failed:', e.message); }
  }

  const prompt = buildChiefBriefPrompt(filteredEmails, currentDay, workoutPlan, calendarEvents, wellbeingContext, annotationsContext, recoveryContext, experimentsContext, selfModel, leverageContext, workBusyBlocks, strengthContext, spendingContext, continuityContext, cashflowContext, progressContext, weeklyGoalsContext, chaptersContext, dayOffContext, attentionContext, openGoals, recoveryDriversContext, calendarSourcesAvailable, answeredQuestionsContext, classifiedOverrides, nightlyContextHistoryContext);

  // One correlation ID per build, threaded through every attempt's log lines
  // so a failure can be traced across attempts without ever logging content.
  const correlationId = crypto.randomUUID();

  // Error-specific retry policy — one retry budget, spent differently
  // depending on WHY attempt 1 failed:
  //   - refusal: do NOT retry. Repeating the identical request against a
  //     safety decline wastes a paid call for a result that won't change,
  //     and generating/reusing anything from a declined response would be
  //     unvalidated content. Fail safely straight to the empty fallback.
  //   - max_tokens: retry once, but with a LARGER maxTokens — a same-size
  //     retry would just truncate again.
  //   - network / parse / shape: retry once with identical params — the
  //     model call is non-deterministic (adaptive thinking's own sampling,
  //     not a temperature knob — Opus 4.6+/5 don't accept one), and this
  //     exact class of failure (silently falling back to yesterday's brief,
  //     repeatedly) is what a live user hit. A second identical attempt has
  //     a real chance of coming back valid.
  const initialMaxTokens = chiefInitialMaxTokens();
  const { result: firstResult, failureType: firstFailure } =
    await chiefBriefAttempt(prompt, 'attempt 1/2', { maxTokens: initialMaxTokens, correlationId });

  const FAILED_QUALITY = (reasonCode) => ({ status: 'failed', reasonCodes: [reasonCode], fieldWordCounts: {}, fallbackFields: [], violatedChecks: [] });

  let result = firstResult;
  let successMaxTokens = initialMaxTokens;
  if (!result) {
    if (firstFailure === 'refusal') {
      console.error(`[briefing-ai] chief-brief refused — not retrying the identical request. [correlationId=${correlationId}]`);
      return { ...EMPTY_CHIEF, chiefBriefQuality: FAILED_QUALITY('refusal') };
    }
    const retryMaxTokens = firstFailure === 'max_tokens' ? chiefBumpedMaxTokens(initialMaxTokens) : initialMaxTokens;
    const { result: secondResult } =
      await chiefBriefAttempt(prompt, 'attempt 2/2 (retry)', { maxTokens: retryMaxTokens, correlationId });
    result = secondResult;
    successMaxTokens = retryMaxTokens;
  }
  if (!result) return { ...EMPTY_CHIEF, chiefBriefQuality: FAILED_QUALITY('generation_failed') };

  // ── Semantic guards ────────────────────────────────────────────────────
  // (1) Goal completion: weekly_intentions.goals[].achieved is the SOLE
  //     authority — a shape-valid response can still describe an OPEN goal as
  //     done. This guard has a deterministic rewrite backstop, so a violation
  //     here is ALWAYS scrubbed before shipping.
  // (2) Broader claim validation (brain/claimValidator): when the caller
  //     supplies canonical facts from the BrainSnapshot, also catch statements
  //     that contradict the authoritative recovery band/score, the EFFECTIVE
  //     (not scheduled) workout, commitment completion, experiment verdicts, or
  //     spending totals — the LLM may choose wording, never recalculate facts.
  //     Any contradiction (recovery/workout/completion/forecast/date AND the
  //     formerly "low-severity" spending/experiment ones) triggers the one-shot
  //     correction retry; a contradiction that SURVIVES the retry is never
  //     shipped — goal completions are rephrased by rewriteFalseGoalCompletions,
  //     every other class has its offending sentence deterministically stripped
  //     (neutralizeClaimViolations). Absent facts, this is a no-op, so every
  //     existing caller keeps working unchanged.
  const { neutralizeClaimViolations, ensureRequiredFieldsPresent, assessChiefBriefQuality, buildQualityRetryPrompt } = require('../brain/claimValidator');
  const goalViolations = findFalseGoalCompletions(result, openGoals);
  const { violations: claimViolations } = validateChiefBriefClaims(result, snapshotFacts);
  if (claimViolations.length) {
    console.error(`[briefing-ai] chief-brief contradicted canonical state (${claimViolations.length} claim violation(s): ${claimViolations.map((v) => v.check).join(', ')}) [correlationId=${correlationId}]`);
  }

  const finalizeSafe = (r) => {
    const gv = findFalseGoalCompletions(r, openGoals);
    let out = gv.length ? rewriteFalseGoalCompletions(r, gv) : r;
    const { violations: cv } = validateChiefBriefClaims(out, snapshotFacts);
    if (cv.length) {
      console.error(`[briefing-ai] neutralizing ${cv.length} surviving claim contradiction(s) deterministically (${cv.map((v) => v.check).join(', ')}) [correlationId=${correlationId}]`);
      out = neutralizeClaimViolations(out, cv, snapshotFacts);
    }
    // Backstop: guarantee no required field shipped blank, independent of
    // WHY it might be (neutralization stripped every sentence, the model
    // itself returned an empty string, a malformed retry shape).
    out = ensureRequiredFieldsPresent(out, snapshotFacts);
    // Rerun claim validation once more on the FINAL text — this only logs; the
    // shape guarantee above is unconditional and doesn't depend on this passing.
    const { violations: finalViolations } = validateChiefBriefClaims(out, snapshotFacts);
    if (finalViolations.length) {
      console.error(`[briefing-ai] ${finalViolations.length} claim violation(s) still present after finalization (${finalViolations.map((v) => v.check).join(', ')}) — shipping anyway, no required field is blank. [correlationId=${correlationId}]`);
    }
    return out;
  };

  if (!goalViolations.length && !claimViolations.length) {
    const quality = assessChiefBriefQuality(result, snapshotFacts);
    if (quality.status === 'fresh') return { ...result, chiefBriefQuality: quality };

    // Schema-valid and not contradicting anything, but underfilled (or, in
    // theory, exactly a grounded fallback with zero claim violations — that
    // can't happen on a clean attempt 1/2 result, but the contract still
    // handles it correctly either way). Worth exactly ONE bounded, targeted
    // retry — never an unbounded watcher loop.
    console.error(`[briefing-ai] chief-brief quality ${quality.status} (${quality.reasonCodes.join(',') || 'none'}) — retrying once with a targeted quality prompt. [correlationId=${correlationId}]`);
    const { result: qualityRetry } = await chiefBriefAttempt(
      buildQualityRetryPrompt(prompt, quality), 'attempt 3/3 (quality retry)', { maxTokens: successMaxTokens, correlationId }
    );
    if (!qualityRetry) return { ...result, chiefBriefQuality: quality };

    const retryGoalViolations = findFalseGoalCompletions(qualityRetry, openGoals);
    const { violations: retryClaimViolations } = validateChiefBriefClaims(qualityRetry, snapshotFacts);
    if (!retryGoalViolations.length && !retryClaimViolations.length) {
      const retryQuality = assessChiefBriefQuality(qualityRetry, snapshotFacts);
      return { ...qualityRetry, chiefBriefQuality: retryQuality };
    }
    // The quality retry introduced a NEW contradiction — do not ship it;
    // finalize the ORIGINAL underfilled-but-correct result deterministically.
    console.error(`[briefing-ai] quality retry introduced a contradiction — discarding it, finalizing the original result instead. [correlationId=${correlationId}]`);
    const safe = finalizeSafe(result);
    return { ...safe, chiefBriefQuality: assessChiefBriefQuality(safe, snapshotFacts) };
  }

  // ANY contradiction is worth one paid correction attempt — a wrong spend total
  // or experiment verdict is still a false claim we won't ship.
  if (goalViolations.length) {
    console.error(`[briefing-ai] chief-brief claimed an OPEN goal was done (${goalViolations.length} instance(s)) — retrying with a targeted correction. [correlationId=${correlationId}]`);
  }
  // Layer whichever corrections apply onto the base prompt (goal first, then
  // claim contradictions) — either or both may be present.
  let correctionPrompt = prompt;
  if (goalViolations.length) correctionPrompt = buildGoalCorrectionPrompt(correctionPrompt, goalViolations);
  if (claimViolations.length) {
    const { buildClaimCorrectionPrompt } = require('../brain/claimValidator');
    correctionPrompt = buildClaimCorrectionPrompt(correctionPrompt, claimViolations);
  }

  // Deterministically FINALIZE a result so nothing contradicting ever ships
  // (finalizeSafe defined above): rephrase goal-completion sentences, strip
  // any other surviving contradiction, then rerun BOTH checks and apply a
  // grounded backstop:
  //   1. Shape: every REQUIRED field (synthesis/action/risk/move) must still be
  //      a non-empty string after neutralization — stripping every sentence in
  //      a field that was ENTIRELY the false claim would otherwise ship a blank
  //      card, which is a worse failure than the contradiction it replaced.
  //   2. Claims: re-validate the finalized text — neutralization only strips
  //      the SPECIFIC flagged sentences, so this is a correctness check that
  //      nothing else in the field still contradicts state (logged if so; the
  //      shape guarantee above always holds regardless).
  const { result: retry } = await chiefBriefAttempt(
    correctionPrompt, 'attempt 3/3 (semantic correction)', { maxTokens: successMaxTokens, correlationId }
  );
  if (retry) {
    const retryGoalViolations = findFalseGoalCompletions(retry, openGoals);
    const { violations: retryClaimViolations } = validateChiefBriefClaims(retry, snapshotFacts);
    if (!retryGoalViolations.length && !retryClaimViolations.length) {
      // Clean on correctness — still run it through the quality contract:
      // neutralization never ran, so this can only be fresh or underfilled,
      // never a fallback-field degrade, but it must still be assessed rather
      // than assumed.
      return { ...retry, chiefBriefQuality: assessChiefBriefQuality(retry, snapshotFacts) };
    }
    // The retry STILL contradicts canonical state — do NOT ship it as-is.
    console.error(`[briefing-ai] semantic correction retry still contradicted state (goals:${retryGoalViolations.length}, claims:${retryClaimViolations.map((v) => v.check).join('|') || 0}) — finalizing deterministically. [correlationId=${correlationId}]`);
    const safe = finalizeSafe(retry);
    return { ...safe, chiefBriefQuality: assessChiefBriefQuality(safe, snapshotFacts) };
  }
  // The correction retry failed entirely — finalize the FIRST valid result
  // deterministically rather than losing it (returning EMPTY_CHIEF would make the
  // caller reuse a POTENTIALLY CONTAMINATED prior brief, which is what this guard
  // exists to avoid).
  console.error(`[briefing-ai] semantic correction retry failed — finalizing the original result deterministically instead. [correlationId=${correlationId}]`);
  const safe = finalizeSafe(result);
  return { ...safe, chiefBriefQuality: assessChiefBriefQuality(safe, snapshotFacts) };
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
