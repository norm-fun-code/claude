// Evening wind-down brief — auto-built and pushed at 9:30pm.
//
// Built on Apple-Health DAYTIME HRV/RHR (see evening-readiness.js for why that's a
// tone signal, not a recovery score). Complements the morning brief: morning =
// recovery + the plan; evening = how today landed on your body + how to close it.
//
// Prose is LLM-written in the chief-of-staff voice, but every field has a
// deterministic fallback so the brief always lands even if the model is down.
const llm = require('../llm');
const { gatherEvening } = require('../intelligence/evening-readiness');
const briefingsStore = require('../store/briefings');
const devicesStore = require('../store/devices');
const nudgesStore = require('../store/nudges');
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

function composeFallback({ autonomic, load, openHabits, gratitude = [], training = null, isRestDay = false }) {
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

  let today = '';
  if (load.steps != null) {
    if (isRestDay) {
      // A rest day has no training-day norm to fall short of — lighter movement
      // is the plan working, not a miss.
      today = `You logged ${commas(load.steps)} steps today — a scheduled rest day, so lighter movement is expected.`;
    } else {
      const vs =
        load.stepsBaseline != null
          ? load.steps >= load.stepsBaseline
            ? ` — at or above your ${commas(load.stepsBaseline)} norm`
            : ` — under your ${commas(load.stepsBaseline)} norm`
          : '';
      today = `You logged ${commas(load.steps)} steps today${vs}.`;
    }
  }

  const tomorrow =
    tone === 'settled'
      ? 'Hold your bedtime window and tomorrow opens from a good place.'
      : 'Lights down on time tonight is the single biggest lever on tomorrow — protect the bedtime window.';

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
      openHabits,
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
  const { autonomic: a, load: l, openHabits, gratitude = [], morningPlan = null, training = null, commitments = null, dayContext = '', isRestDay = false } = signals;
  const lines = [
    `Autonomic tone: ${a.tone}${a.sampleThin ? ' (thin data — soft-pedal)' : ''}`,
    a.hrv != null ? `Daytime HRV today: ${ms(a.hrv)}${a.hrvBaseline != null ? ` (your norm ${ms(a.hrvBaseline)})` : ''}` : 'Daytime HRV today: (none)',
    a.rhr != null ? `Resting HR today: ${bpm(a.rhr)}${a.rhrBaseline != null ? ` (your norm ${bpm(a.rhrBaseline)})` : ''}` : 'Resting HR today: (none)',
    l.steps != null ? `Steps today: ${commas(l.steps)}${l.stepsBaseline != null ? ` (norm ${commas(l.stepsBaseline)})` : ''}` : 'Steps today: (none)',
    l.activeEnergy != null ? `Active energy today: ${commas(l.activeEnergy)} kcal` : null,
    isRestDay ? 'Today was a SCHEDULED REST DAY — lower steps/energy and no exercise are EXPECTED, not a shortfall. Do not compare against the training-day norm as if something was missed.' : null,
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
  ].filter(Boolean);

  return `Tonight's signals:
${lines.join('\n')}

Write the evening wind-down brief as JSON with EXACTLY these string fields:
{
  "headline": "≤6 words capturing tonight's read (e.g. 'Settled — wind down easy')",
  "readiness": "1-2 sentences on autonomic tone from the HRV/RHR vs the user's norm, and what it means for tonight. If data is thin, say so and defer to how they feel.",
  "today": "ONE sentence closing the loop on today's movement (steps/energy). If today was a scheduled rest day, say so and frame lower activity as expected/fine — never as falling short of the training-day norm. Empty string if no data.",
  "plan": "ONE sentence grading the day against what was asked of it — this morning's plan AND any commitments the user made today (see the commitments line). The honest ledger, not a lecture: credit what they kept (session done, commitments honored) plainly; name what slipped without guilt and without re-issuing the instruction — the day is over. On a rest day, there was no session to grade — do not treat the rest itself as a miss. Prefer concrete evidence (planned session done/not, commitments kept/open, steps vs norm). Empty string only if there's genuinely nothing to grade.",
  "tomorrow": "ONE sentence: the bedtime/wind-down lever that sets up tomorrow. Do not cite a recovery score.",
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

function extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function composeEveningBrief(signals) {
  const fallback = composeFallback(signals);
  try {
    const text = await llm.generateText({
      system: SYSTEM,
      prompt: buildPrompt(signals),
      temperature: 0.3,
      maxTokens: 700,
    });
    const v = validate(extractJson(text));
    if (!v) return fallback;
    // Keep the deterministic tone band + signals; take the model's prose.
    return { ...fallback, ...v };
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
  // override (workout_overrides) first — getTodayWorkout() alone only knows the
  // static weekly schedule, so a "swap today to rest" voice command would
  // otherwise be invisible here even though it's exactly what the swap_workout
  // action is for.
  const OVERRIDE_LABELS = { push: 'Push', pull: 'Pull', zone2: 'Zone 2', mobility: 'Mobility', intervals: 'Intervals', rest: 'Rest' };
  let plannedLabel = null;
  let isRestDay = false;
  try {
    const { getTodayWorkout } = require('../services/workout');
    const db = require('../db');
    const { rows: overrideRows } = await db.query(
      `SELECT workout_id FROM workout_overrides WHERE log_date = $1`,
      [day]
    );
    const overrideId = overrideRows[0]?.workout_id ?? null;
    if (overrideId) {
      plannedLabel = OVERRIDE_LABELS[overrideId] ?? overrideId;
      isRestDay = overrideId === 'rest';
    } else {
      const scheduled = getTodayWorkout();
      plannedLabel = scheduled?.type ?? null;
      isRestDay = scheduled?.type === 'Rest';
    }
  } catch { /* non-critical — defaults (null, false) are safe */ }

  const signals = await gatherEvening({ tz, isRestDay });
  signals.isRestDay = isRestDay;
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
  // Today's context the user narrated (if any) — so the wind-down speaks to the
  // day they actually had, not just the numbers.
  try {
    const entries = await require('../store/dayJournal').forDay(day);
    signals.dayContext = entries.map((e) => e.text).join(' ');
  } catch { signals.dayContext = ''; }
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

module.exports = { runEveningHealthBrief, composeEveningBrief, composeFallback, buildPrompt };
