// Evening wind-down brief — auto-built and pushed at 9:30pm.
//
// Built on Apple-Health DAYTIME HRV/RHR (see evening-readiness.js for why that's a
// tone signal, not a recovery score). Complements the morning brief: morning =
// recovery + the plan; evening = how today landed on your body + how to close it.
//
// Prose is LLM-written in the chief-of-staff voice, but every field has a
// deterministic fallback so the brief always lands even if the model is down.
const llm = require('../llm');
const { parseAndValidate } = require('../llm/parseJson');
const { gatherEvening, detectDeviceDataGap, isSickDay } = require('../intelligence/evening-readiness');
const { wellbeingLevel } = require('../intelligence/catalog');
const briefingsStore = require('../store/briefings');
const devicesStore = require('../store/devices');
const nudgesStore = require('../store/nudges');
const annotationsStore = require('../store/annotations');
const { sendPush } = require('./expo');

const ms = (n) => (n != null ? `${Math.round(n)} ms` : null);
const bpm = (n) => (n != null ? `${Math.round(n)} bpm` : null);
const commas = (n) => (n != null ? Math.round(n).toLocaleString('en-US') : null);

const TONE_HEADLINE = {
  settled: "You're settled — wind down easy",
  mild: 'Mild load — wind down for real',
  elevated: "Your body's still spending — protect tonight",
  unknown: 'Wind down — soft read tonight',
};

// ── deterministic fallback (also the LLM's scaffold) ─────────────────────────

// A cumulative 7-night net (recovery.js's sleepBalance7 — see its own doc
// comment for why this, not Eight Sleep's raw debt field, is canonical) below
// this many hours is treated as a real deficit worth naming tonight. Below
// this, day-to-day noise isn't worth a special call-out.
const MEANINGFUL_SLEEP_DEBT_HOURS = -2;

function composeFallback({
  autonomic, load, openHabits, gratitude = [], training = null, isRestDay = false,
  tomorrowFirstEvent = null, tomorrowIsDayOff = false, tomorrowHoliday = null,
  checkin = null, dataGap = null, sleepBalance = null,
}) {
  const { hrv, hrvBaseline, rhr, rhrBaseline, tone, sampleThin } = autonomic;

  let readiness;
  if (sampleThin) {
    readiness =
      "Not much Apple Watch HRV today, so take this as a soft read — go by how you actually feel heading into tonight.";
  } else {
    const bits = [];
    if (hrv != null) {
      bits.push(
        hrvBaseline != null
          ? `HRV today averaged ${ms(hrv)} vs your ${ms(hrvBaseline)} daytime norm`
          : `HRV today averaged ${ms(hrv)}`
      );
    }
    if (rhr != null) {
      bits.push(
        rhrBaseline != null
          ? `resting HR's at ${bpm(rhr)} vs ${bpm(rhrBaseline)}`
          : `resting HR's at ${bpm(rhr)}`
      );
    }
    const lead = bits.join(', ');
    const read =
      tone === 'elevated'
        ? "your body's still spending — a genuine wind-down banks tomorrow's recovery."
        : tone === 'mild'
        ? "mild sympathetic load — wind down for real tonight and it pays off by morning."
        : "your system looks settled — you've got room to relax or do something restorative.";
    readiness = lead ? `${lead.charAt(0).toUpperCase() + lead.slice(1)} — ${read}` : read;
  }
  // The body metrics can look fine while the day genuinely wasn't — surface a
  // notably low self-reported check-in even when HRV/RHR read as settled.
  // Plain words only (low/ok/high), never the raw "2/5" — reads like someone
  // who actually noticed, not a clinical readout.
  if (checkin) {
    const low = ['mood', 'energy', 'focus'].filter((k) => wellbeingLevel(checkin[k]) === 'low');
    if (low.length) readiness += ` Your ${low.join(' and ')} ${low.length > 1 ? 'were' : 'was'} low today too — worth trusting how you actually felt over the numbers tonight.`;
  }

  // Steps/movement are judged against the user's own baseline, independent of
  // whether today was a rest day — a rest day means no planned hard TRAINING,
  // it does not imply low steps. Without a valid baseline, stay neutral
  // (never "high"/"low"/"lighter") rather than guess.
  let today = '';
  if (load.steps != null) {
    const steps = commas(load.steps);
    const aboveBaseline = load.stepsBaseline != null && load.steps >= load.stepsBaseline;
    const belowBaseline = load.stepsBaseline != null && load.steps < load.stepsBaseline;
    if (isRestDay) {
      if (aboveBaseline) {
        today = `You still logged ${steps} steps on a scheduled rest day — plenty of movement without adding structured training stress.`;
      } else if (belowBaseline) {
        today = `You logged ${steps} steps on a scheduled rest day, a bit under your ${commas(load.stepsBaseline)} norm — no structured training today, and that's the plan working as intended.`;
      } else {
        today = `You logged ${steps} steps today, a scheduled rest day — no structured training, just how the day landed.`;
      }
    } else {
      const vs =
        load.stepsBaseline != null
          ? aboveBaseline
            ? ` — at or above your ${commas(load.stepsBaseline)} norm`
            : ` — under your ${commas(load.stepsBaseline)} norm`
          : '';
      today = `You logged ${steps} steps today${vs}.`;
    }
  }
  if (dataGap) today = today ? `${today} ${dataGap}` : dataGap;

  // Bedtime/wind-down lever — grounded in tonight's own recovery signal
  // (autonomic tone) and the canonical 7-night sleep balance (recovery.js's
  // sleepBalance7), plus tomorrow's ACTUAL requirements. Whether tomorrow
  // happens to be free never loosens this: a day off is not evidence that
  // shortening sleep tonight is harmless.
  const sleepDebtHours = sleepBalance ? sleepBalance.net : null;
  const hasMeaningfulDebt = sleepDebtHours != null && sleepDebtHours <= MEANINGFUL_SLEEP_DEBT_HOURS;
  let tomorrow;
  if (tomorrowFirstEvent) {
    tomorrow = `${tomorrowFirstEvent} tomorrow — get to bed on time so you're not running on empty for it.`;
  } else {
    // A day off/holiday may be named as a FACT, but it never changes the
    // advice itself — that's driven only by debt/tone above, exactly as it
    // would be on a normal working day.
    const dayOffNote = tomorrowIsDayOff ? `Tomorrow${tomorrowHoliday ? ` is ${tomorrowHoliday}` : "'s a day off"}. ` : '';
    const advice = hasMeaningfulDebt
      ? "You're carrying a sleep deficit over the last week — tonight's a good night to actually catch up."
      : tone === 'settled'
        ? 'Hold your bedtime window and tomorrow opens from a good place.'
        : 'Lights down on time tonight is the single biggest lever on tomorrow — protect the bedtime window.';
    tomorrow = `${dayOffNote}${advice}`;
  }

  const habits = openHabits.length
    ? `Still open: ${openHabits.join(', ')} — quick wins before bed.`
    : '';

  // Deterministic plan-vs-actual line so the day-close ledger survives an LLM
  // outage. The nuanced version comes from the prose pass.
  let plan = '';
  if (training?.planned && String(training.planned).toLowerCase() !== 'rest') {
    plan = training.completed
      ? `Planned ${training.planned} — done${training.actual && String(training.actual).toLowerCase() !== String(training.planned).toLowerCase() ? ` (logged as ${training.actual})` : ''}.`
      : `Planned ${training.planned} — not logged as done; the day's closed either way.`;
  }

  // Presence beat — the mindfulness counterpart to the body read. The LLM pass
  // writes the nuanced version; this deterministic path keeps it graceful if the
  // model is down: a soft echo when there's a recent gratitude note, a gentle
  // invite otherwise.
  const reflection = gratitude.length
    ? 'Carry what you were grateful for today into tomorrow — that thread matters as much as the numbers.'
    : 'Before sleep, name one thing you’re grateful for — a small close that steadies the day.';

  return {
    tone: tone || 'unknown',
    headline: TONE_HEADLINE[tone] || TONE_HEADLINE.unknown,
    readiness,
    today,
    plan,
    tomorrow,
    habits,
    reflection,
    signals: {
      hrv, hrvBaseline, rhr, rhrBaseline,
      steps: load.steps, stepsBaseline: load.stepsBaseline, activeEnergy: load.activeEnergy,
      openHabits, dataGap, sleepDebtHours,
    },
  };
}

// ── LLM prose pass ───────────────────────────────────────────────────────────

const SYSTEM =
  'You are NormOS — the user\'s chief of staff, writing their EVENING wind-down brief. ' +
  'Warm, sharp, numerate, brief. This is the end-of-day counterpart to the morning brief: ' +
  'do NOT restate recovery scores or morning advice — focus on how today landed on the body ' +
  'and how to close the day. Use ONLY the numbers provided; never invent data. ' +
  'Daytime HRV is a noisy autonomic-tone signal, NOT a recovery score — never call it recovery. ' +
  'HARD RULES (never violate these, no matter how natural the phrasing feels): ' +
  '(1) A scheduled rest day means no planned hard TRAINING today — it does NOT mean low steps or ' +
  'light movement. Judge steps/movement against the user\'s own step baseline ONLY. If a valid ' +
  'baseline is not provided, use neutral factual language (just state the number) — never call ' +
  'steps "light", "low", or "lighter" without a baseline that actually supports it. ' +
  '(2) Never describe steps or general daily movement as if it were a hard or structured workout — ' +
  'only a logged/completed training session earns that language. ' +
  '(3) A free or day-off tomorrow is NEVER evidence that shortening sleep tonight is harmless. ' +
  'Ground the wind-down/bedtime advice in tonight\'s autonomic tone, the sleep debt/surplus figure ' +
  'if given, recent sleep, and tomorrow\'s ACTUAL requirements (an early commitment) or explicit ' +
  'user plans — never in "tomorrow is free so there is more room tonight". If the user has genuinely ' +
  'late plans of their own, you may acknowledge the tradeoff honestly without endorsing loosening ' +
  'the wind-down because of it. ' +
  'Return ONLY valid JSON.';

function commitmentsLine(commitments) {
  if (!commitments) return null;
  const done = commitments.done || [];
  const open = commitments.open || [];
  const skipped = commitments.skipped || [];
  if (!done.length && !open.length && !skipped.length) return null;
  const parts = [];
  if (done.length) parts.push(`kept: ${done.map((c) => `"${c.title}"`).join(', ')}`);
  if (open.length) parts.push(`still open: ${open.map((c) => `"${c.title}"`).join(', ')}`);
  if (skipped.length) parts.push(`skipped: ${skipped.map((c) => `"${c.title}"`).join(', ')}`);
  return `Today's commitments — ${parts.join('; ')}`;
}

function buildPrompt(signals) {
  const {
    autonomic: a, load: l, openHabits, gratitude = [], morningPlan = null, training = null,
    commitments = null, dayContext = '', isRestDay = false,
    tomorrowFirstEvent = null, tomorrowIsDayOff = false, tomorrowHoliday = null,
    checkin = null, dataGap = null, sleepBalance = null,
  } = signals;
  const checkinParts = checkin
    ? ['mood', 'energy', 'focus'].filter((k) => checkin[k] != null).map((k) => `${k} ${wellbeingLevel(checkin[k])}`)
    : [];
  const lines = [
    `Autonomic tone: ${a.tone}${a.sampleThin ? ' (thin data — soft-pedal)' : ''}`,
    a.hrv != null ? `Daytime HRV today: ${ms(a.hrv)}${a.hrvBaseline != null ? ` (your norm ${ms(a.hrvBaseline)})` : ''}` : 'Daytime HRV today: (none)',
    a.rhr != null ? `Resting HR today: ${bpm(a.rhr)}${a.rhrBaseline != null ? ` (your norm ${bpm(a.rhrBaseline)})` : ''}` : 'Resting HR today: (none)',
    checkinParts.length
      ? `Today's self-reported check-in: ${checkinParts.join(', ')} — this is how they said they actually felt today; weave it into the read wherever it's genuinely relevant (it can reinforce or contradict the body metrics — a settled HRV with a low mood/energy check-in is still worth naming, not just the numbers). Speak in these same plain words (low/ok/high) — never a raw score like "2/5".`
      : `Today's self-reported check-in: (none logged)`,
    l.steps != null
      ? `Steps today: ${commas(l.steps)}${l.stepsBaseline != null ? ` (your baseline norm: ${commas(l.stepsBaseline)})` : ' (NO valid step baseline available — do not call this high/low/light, just state the number)'}`
      : 'Steps today: (none)',
    l.activeEnergy != null ? `Active energy today: ${commas(l.activeEnergy)} kcal` : null,
    isRestDay
      ? 'Today was a SCHEDULED REST DAY — this means no planned hard TRAINING today, nothing more. It does NOT mean steps or movement were low; judge steps ONLY against the step baseline line above, exactly as you would on a training day.'
      : null,
    sleepBalance
      ? `7-night sleep balance (canonical, hours vs need — negative = debt, positive = surplus): ${sleepBalance.net > 0 ? '+' : ''}${sleepBalance.net}h over ${sleepBalance.nights} nights. Use this (not tomorrow's calendar) to judge whether tonight's wind-down needs to be firmer than usual.`
      : 'Sleep balance: (not enough recent data to compute)',
    dataGap
      ? `DATA QUALITY FLAG: ${dataGap} Say this plainly in "today" (or "readiness" if more natural) — don't grade the day against these numbers as if they're real, and don't invent a health explanation for the dip.`
      : null,
    openHabits.length ? `Evening habits still open: ${openHabits.join(', ')}` : 'Evening habits: all logged',
    training
      ? `Planned session today: ${training.planned ?? '(none)'} — ${training.completed ? `DONE${training.actual ? ` (logged: ${training.actual})` : ''}` : 'not logged as done'}`
      : null,
    morningPlan?.action ? `This morning's brief asked: "${String(morningPlan.action).slice(0, 300)}"` : 'This morning\'s brief: (not available)',
    commitmentsLine(commitments),
    dayContext && dayContext.trim()
      ? `What the user told you about today (their own words — speak to THIS, not just the numbers): "${dayContext.slice(0, 600)}"`
      : null,
    gratitude.length
      ? `Recent gratitude notes (most recent first — reflect the THEME back in your own words, do not quote verbatim or list): ${gratitude.map((g) => `"${String(g.text).slice(0, 200)}"`).join(' | ')}`
      : 'Recent gratitude notes: (none logged)',
    tomorrowFirstEvent
      ? `Tomorrow's first commitment: ${tomorrowFirstEvent} — this is EARLY, factor it into how firmly you push bedtime tonight.`
      : tomorrowIsDayOff
        ? `Tomorrow is a day off${tomorrowHoliday ? ` (${tomorrowHoliday})` : ''} — no early alarm to protect. This is calendar information ONLY: it must NOT be treated as a reason the wind-down can be looser tonight. Base tonight's advice on the sleep-balance and autonomic-tone lines above instead.`
        : 'Tomorrow: (no early commitment on record — a normal working day)',
  ].filter(Boolean);

  return `Tonight's signals:
${lines.join('\n')}

Write the evening wind-down brief as JSON with EXACTLY these string fields:
{
  "headline": "≤6 words capturing tonight's read (e.g. 'Settled — wind down easy')",
  "readiness": "1-2 sentences on autonomic tone from the HRV/RHR vs the user's norm, and what it means for tonight. If data is thin, say so and defer to how they feel. If today's self-reported check-in (mood/energy/focus) is present and notably low or notably high, fold it in — a settled HRV reading doesn't override a day that was actually hard or draining; when the body metrics and the self-report disagree, say so plainly rather than only reporting the numbers.",
  "today": "ONE sentence closing the loop on today's movement (steps/energy), judged ONLY against the step baseline line above — if no baseline was given, just state the number neutrally, never 'high'/'low'/'lighter'. Separately, if today was a scheduled rest day, you may note that no structured training happened, but that is a statement about TRAINING, not about steps — never use the rest day to describe substantial or baseline-or-above steps as light, low, or lighter. Empty string if no data.",
  "plan": "ONE sentence grading the day against what was asked of it — this morning's plan AND any commitments the user made today (see the commitments line). The honest ledger, not a lecture: credit what they kept (session done, commitments honored) plainly; name what slipped without guilt and without re-issuing the instruction — the day is over. On a rest day, there was no session to grade — do not treat the rest itself as a miss, and do not describe steps/movement as a hard workout when no session was logged. Prefer concrete evidence (planned session done/not, commitments kept/open, steps vs norm, today's check-in and what the user told you about their day). Empty string only if there's genuinely nothing to grade.",
  "tomorrow": "ONE sentence: the bedtime/wind-down lever for tonight, grounded in the sleep-balance and autonomic-tone lines above, recent sleep, and tomorrow's ACTUAL requirements. If tomorrow's first commitment is early, make the bedtime push concrete and specific to that (e.g. 'a 7:30 start tomorrow — get down by 10:30'), not generic. If tomorrow is a day off, you may say so factually, but never use it as a reason the wind-down can be looser — a free day is not evidence reduced sleep is harmless. If the user has genuinely late plans of their own tonight (see 'what the user told you about today'), you may acknowledge that tradeoff honestly without endorsing it. Do not cite a recovery score.",
  "habits": "ONE short nudge listing the still-open evening habits, or empty string if none.",
  "reflection": "ONE sentence — the presence beat that closes the day, the mindfulness counterpart to the body read above. If recent gratitude notes are present, gently echo their theme in your own words (never quote verbatim, never list them like a report) so the reflection lands as something a person who was listening would say. If none are present, warmly invite one line of gratitude before bed. Keep it human and unforced; empty string only if anything here would feel hollow."
}`;
}

function validate(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const s = (k) => (typeof parsed[k] === 'string' ? parsed[k].trim() : '');
  if (!s('headline') || !s('readiness')) return null; // the two load-bearing fields
  return { headline: s('headline'), readiness: s('readiness'), today: s('today'), plan: s('plan'), tomorrow: s('tomorrow'), habits: s('habits'), reflection: s('reflection') };
}

async function composeEveningBrief(signals) {
  const fallback = composeFallback(signals);
  try {
    const text = await llm.generateText({
      system: SYSTEM,
      prompt: buildPrompt(signals),
      temperature: 0.3,
      maxTokens: 700,
      jsonMode: true,
    });
    const v = parseAndValidate(text, { label: 'evening-brief', validate });
    if (!v) return fallback;
    // Keep the deterministic tone band + signals; take the model's prose.
    const merged = { ...fallback, ...v };
    // Deterministic last-resort guard: the prompt instructs the model not to
    // conflate a rest day with low steps, not to call steps a workout, and not
    // to treat a free tomorrow as sleep-loosening permission — but an LLM can
    // still slip. Any field that violates one of those rules gets replaced
    // wholesale with the fallback's already-safe version of that same field.
    const { validateEveningBriefClaims, neutralizeEveningBriefViolations } = require('./evening-brief-validator');
    const violations = validateEveningBriefClaims(merged, signals);
    if (violations.length) {
      console.warn('[evening-brief] neutralizing LLM violations:', violations.map((x) => `${x.check}:${x.field}`).join(', '));
      return neutralizeEveningBriefViolations(merged, violations, fallback);
    }
    return merged;
  } catch (err) {
    console.error('[evening-brief] LLM compose failed, using fallback:', err.message);
    return fallback;
  }
}

// ── build + push ─────────────────────────────────────────────────────────────

/**
 * Build today's evening brief, persist it (kind='evening'), and push the
 * wind-down notification. Deduped per local day. Safe to call repeatedly.
 * @param {{ send?: boolean, tz?: string }} [opts]
 */
async function runEveningHealthBrief(opts = {}) {
  const send = opts.send !== false;
  const tz = opts.tz || process.env.TZ || 'America/New_York';
  const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });

  // Today's planned session — checked FIRST (before gatherEvening) so the rest-
  // day flag can suppress the "Exercise" habit nag and let the LLM correctly
  // frame lower steps as expected, not a shortfall. Reads the manual swap
  // override (workout_overrides) first via the shared getEffectiveWorkout
  // resolver (services/workout.js) — getTodayWorkout() alone only knows the
  // static weekly schedule, so a "swap today to rest" voice command would
  // otherwise be invisible here even though it's exactly what the swap_workout
  // action is for.
  let plannedLabel = null;
  let isRestDay = false;
  try {
    const { getEffectiveWorkout } = require('../services/workout');
    const effective = await getEffectiveWorkout({ tz });
    plannedLabel = effective?.label ?? null;
    isRestDay = effective?.workoutId === 'rest';
  } catch { /* non-critical — defaults (null, false) are safe */ }

  // Today's context the user narrated (if any) — fetched BEFORE gatherEvening
  // so a sick-day note ("not feeling well, getting sick") can suppress the
  // cold-shower/exercise nag the same way a scheduled rest day suppresses
  // exercise. Fetching this after gatherEvening (as it used to be) meant the
  // habit list was already locked in by the time the context existed to read.
  let dayContext = '';
  try {
    const entries = await require('../store/dayJournal').forDay(day);
    dayContext = entries.map((e) => e.text).join(' ');
  } catch { /* non-critical — empty context is safe */ }
  const isSick = isSickDay(dayContext);

  const signals = await gatherEvening({ tz, isRestDay, isSick });
  signals.isRestDay = isRestDay;
  signals.isSick = isSick;
  signals.dayContext = dayContext;
  // Data-quality flag: steps + active energy collapsing together vs. their own
  // baseline reads as a dead/unworn Watch, not a real behavior change. Surface
  // it in tonight's brief AND record it as a life-context annotation for
  // TODAY so tomorrow's trend/anomaly narration (which reads the SAME metrics)
  // doesn't mistake the gap for a genuine dip — this is what makes the
  // flagging actually useful the next day, not just tonight's footnote.
  signals.dataGap = detectDeviceDataGap({ load: signals.load, isRestDay });
  if (signals.dataGap) {
    try {
      const { id } = await annotationsStore.createAnnotation({
        startTs: new Date().toISOString(),
        category: 'data_quality',
        label: 'Watch data gap — active energy/steps look under-tracked, not a real dip',
        note: signals.dataGap,
      });
      // Transactional Brain Invalidation (audit recommendation #2): the store
      // no longer invalidates itself (see its doc comment) — a single INSERT
      // already commits atomically on its own, so invalidating right after it
      // resolves is "strictly after commit."
      if (id) await require('../brain/invalidation').bumpDurable('annotation_retirement');
    } catch (err) {
      console.error('[evening-brief] data-gap annotation failed:', err.message);
    }
  }
  // Recent gratitude reflections feed the evening presence beat — what you wrote
  // in the habit stack gets reflected back instead of being write-only.
  try {
    signals.gratitude = await require('../store/gratitudeLogs').recent(5);
  } catch (err) {
    console.error('[evening-brief] gratitude fetch failed:', err.message);
    signals.gratitude = [];
  }
  // Day-close accountability: what did this morning's brief ask for, and did
  // the planned session actually happen? Grading its own morning call is what
  // separates a chief of staff from a daily fortune cookie.
  try {
    signals.morningPlan = await briefingsStore.todaysMorningBrief();
  } catch { signals.morningPlan = null; }
  try {
    const db = require('../db');
    const [{ rows: exercised }, { rows: acts }] = await Promise.all([
      db.query(
        `SELECT 1 FROM metrics
          WHERE domain = 'habits' AND metric = 'exercise' AND value >= 0.5
            AND (ts AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
          LIMIT 1`,
        [tz]
      ),
      db.query(
        `SELECT activity_type FROM activity_logs
          WHERE log_date = (now() AT TIME ZONE $1)::date ORDER BY id DESC LIMIT 1`,
        [tz]
      ),
    ]);
    signals.training = {
      planned: plannedLabel,
      completed: exercised.length > 0 || acts.length > 0,
      actual: acts[0]?.activity_type ?? null,
    };
  } catch { signals.training = null; }
  // Today's commitments — so the day-close grades what the user actually said
  // they'd do, not only the morning brief's asks.
  try {
    signals.commitments = await require('../store/commitments').todaySummary(tz);
  } catch { signals.commitments = null; }
  // Tomorrow's calendar — makes the bedtime lever concrete ("7:30 start
  // tomorrow, get down by 10:30") instead of the same generic sleep-hygiene
  // line every night. Best-effort: calendar creds may be absent.
  try {
    const tmr = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const tomorrowStr = tmr.toLocaleDateString('en-CA', { timeZone: tz });
    const { dayOff, holiday } = require('../util/dayContext').isDayOff(tomorrowStr);
    const calendarSvc = require('../services/calendar');
    const [tomorrowEvents, tomorrowWorkBusy] = await Promise.all([
      calendarSvc.fetchCalendarEvents({ date: tmr }).catch(() => []),
      calendarSvc.fetchWorkBusyBlocks({ date: tmr }).catch(() => []),
    ]);
    const toMin = require('../util/date').toMinutesSinceMidnight;
    const candidates = [];
    for (const e of tomorrowEvents) {
      if (!e.allDay && e.startTime) {
        const min = toMin(e.startTime);
        if (min != null) candidates.push({ min, label: `"${e.title}" at ${e.startTime}` });
      }
    }
    for (const b of tomorrowWorkBusy) {
      const min = toMin(b.start);
      if (min != null) candidates.push({ min, label: `a meeting at ${b.start}` });
    }
    candidates.sort((x, y) => x.min - y.min);
    const EARLY_CUTOFF_MIN = 8 * 60 + 30; // 8:30am — earlier than this tightens tonight's bedtime push
    const earliest = candidates[0];
    signals.tomorrowFirstEvent = earliest && earliest.min < EARLY_CUTOFF_MIN ? earliest.label : null;
    signals.tomorrowIsDayOff = dayOff;
    signals.tomorrowHoliday = holiday;
  } catch (err) {
    console.error('[evening-brief] tomorrow context failed:', err.message);
    signals.tomorrowFirstEvent = null;
    signals.tomorrowIsDayOff = false;
    signals.tomorrowHoliday = null;
  }
  const content = await composeEveningBrief(signals);
  content.day = day;
  content.builtAt = new Date().toISOString();

  await briefingsStore.saveBriefing({ kind: 'evening', content });

  // Pre-warm the spoken narration so the first tap of "Listen" plays instantly
  // instead of waiting on synthesis. Fire-and-forget.
  require('../services/brief-audio').prewarm('evening', content, day)
    .catch((err) => console.error('[evening audio prewarm] failed:', err.message));

  if (!send) return { built: true, sent: 0, content };

  const dedupKey = `evening_health_brief:${day}`;
  const recent = await nudgesStore.recentlySentKeys(1);
  if (recent.has(dedupKey)) return { built: true, sent: 0, skipped: 'already_sent', content };

  const id = await nudgesStore.recordNudge({
    dedupKey,
    title: 'Wind down 🌙',
    body: content.headline + (content.habits ? ` · ${content.habits}` : ''),
    priority: 0.5,
    basis: { type: 'evening_health_brief', day },
    status: 'pending',
  });
  // null means another concurrent caller already claimed this exact nudge
  // (recordNudge's atomic dedup guard) — don't push a second time.
  if (id == null) return { built: true, sent: 0, skipped: 'concurrent_duplicate', content };

  const tokens = await devicesStore.listActiveTokens();
  if (tokens.length === 0) return { built: true, sent: 0, reason: 'no_devices', content };

  try {
    const r = await sendPush(tokens, {
      title: 'Wind down 🌙',
      body: content.headline + (content.habits ? ` · ${content.habits}` : ''),
      data: { type: 'evening_health_brief' },
    });
    for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
    await nudgesStore.markStatus(id, 'sent');
    return { built: true, sent: r.sent, content };
  } catch (err) {
    await nudgesStore.markStatus(id, 'failed');
    return { built: true, sent: 0, error: err.message, content };
  }
}

module.exports = { runEveningHealthBrief, composeEveningBrief, composeFallback, buildPrompt, SYSTEM };
