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

function composeFallback({ autonomic, load, openHabits }) {
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
    const vs =
      load.stepsBaseline != null
        ? load.steps >= load.stepsBaseline
          ? ` — at or above your ${commas(load.stepsBaseline)} norm`
          : ` — under your ${commas(load.stepsBaseline)} norm`
        : '';
    today = `You logged ${commas(load.steps)} steps today${vs}.`;
  }

  const tomorrow =
    tone === 'settled'
      ? 'Hold your bedtime window and tomorrow opens from a good place.'
      : 'Lights down on time tonight is the single biggest lever on tomorrow — protect the bedtime window.';

  const habits = openHabits.length
    ? `Still open: ${openHabits.join(', ')} — quick wins before bed.`
    : '';

  return {
    tone: tone || 'unknown',
    headline: TONE_HEADLINE[tone] || TONE_HEADLINE.unknown,
    readiness,
    today,
    tomorrow,
    habits,
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

function buildPrompt(signals) {
  const { autonomic: a, load: l, openHabits } = signals;
  const lines = [
    `Autonomic tone: ${a.tone}${a.sampleThin ? ' (thin data — soft-pedal)' : ''}`,
    a.hrv != null ? `Daytime HRV today: ${ms(a.hrv)}${a.hrvBaseline != null ? ` (your norm ${ms(a.hrvBaseline)})` : ''}` : 'Daytime HRV today: (none)',
    a.rhr != null ? `Resting HR today: ${bpm(a.rhr)}${a.rhrBaseline != null ? ` (your norm ${bpm(a.rhrBaseline)})` : ''}` : 'Resting HR today: (none)',
    l.steps != null ? `Steps today: ${commas(l.steps)}${l.stepsBaseline != null ? ` (norm ${commas(l.stepsBaseline)})` : ''}` : 'Steps today: (none)',
    l.activeEnergy != null ? `Active energy today: ${commas(l.activeEnergy)} kcal` : null,
    openHabits.length ? `Evening habits still open: ${openHabits.join(', ')}` : 'Evening habits: all logged',
  ].filter(Boolean);

  return `Tonight's signals:
${lines.join('\n')}

Write the evening wind-down brief as JSON with EXACTLY these string fields:
{
  "headline": "≤6 words capturing tonight's read (e.g. 'Settled — wind down easy')",
  "readiness": "1-2 sentences on autonomic tone from the HRV/RHR vs the user's norm, and what it means for tonight. If data is thin, say so and defer to how they feel.",
  "today": "ONE sentence closing the loop on today's movement (steps/energy). Empty string if no data.",
  "tomorrow": "ONE sentence: the bedtime/wind-down lever that sets up tomorrow. Do not cite a recovery score.",
  "habits": "ONE short nudge listing the still-open evening habits, or empty string if none."
}`;
}

function validate(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const s = (k) => (typeof parsed[k] === 'string' ? parsed[k].trim() : '');
  if (!s('headline') || !s('readiness')) return null; // the two load-bearing fields
  return { headline: s('headline'), readiness: s('readiness'), today: s('today'), tomorrow: s('tomorrow'), habits: s('habits') };
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

  const signals = await gatherEvening({ tz });
  const content = await composeEveningBrief(signals);
  content.day = day;
  content.builtAt = new Date().toISOString();

  await briefingsStore.saveBriefing({ kind: 'evening', content });

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
