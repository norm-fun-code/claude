const plan = {
  Monday: {
    type: 'Zone 2 — Incline Walk or Jog',
    duration: '30–45 min',
    hrTarget: '135–145 bpm',
    protein: '70–85g',
  },
  Tuesday: {
    type: 'Recovery + Mobility',
    duration: '20–30 min',
    hrTarget: null,
    protein: '70–85g',
  },
  Wednesday: {
    type: '4×4 Intervals',
    duration: '~55 min',
    hrTarget: null,
    protein: '70–85g',
  },
  Thursday: {
    type: 'Push',
    duration: '~45 min',
    hrTarget: null,
    protein: '100–115g',
  },
  Friday: {
    type: 'Rest',
    duration: null,
    hrTarget: null,
    protein: '70–85g',
  },
  Saturday: {
    type: 'Zone 2 — Incline Walk or Jog',
    duration: '30–45 min',
    hrTarget: '135–145 bpm',
    protein: '70–85g',
  },
  Sunday: {
    type: 'Pull',
    duration: '~45 min',
    hrTarget: null,
    protein: '100–115g',
  },
};

// Canonical workout ids — the same vocabulary workout_overrides/swap_workout
// use (routes/workout.js's VALID_WORKOUT_IDS). Every plan-type string maps
// onto one of these so overrides and the scheduled plan can be compared and
// classified with a single vocabulary instead of two parallel ones.
const OVERRIDE_LABELS = { push: 'Push', pull: 'Pull', zone2: 'Zone 2', mobility: 'Mobility', intervals: 'Intervals', rest: 'Rest' };

// Training-load classification: which workout ids actually load the body hard
// enough to carry fatigue into tomorrow. Rest and Recovery + Mobility are
// explicitly restorative, not hard; Zone 2 is aerobic base work, not hard;
// Intervals/Push/Pull are the sessions that plausibly drag on tomorrow's
// recovery. This is the single source of truth other modules (predict.js,
// evening-brief.js) must classify against — no separate heuristic per caller.
const HARD_WORKOUT_IDS = new Set(['push', 'pull', 'intervals']);

/** Pure: does this workout id (the vocabulary workout_overrides uses) count as hard? */
function isHardWorkoutId(workoutId) {
  return HARD_WORKOUT_IDS.has(String(workoutId || '').toLowerCase());
}

/** Map a scheduled plan's free-text `type` (e.g. "4×4 Intervals",
 *  "Recovery + Mobility") onto the same canonical id vocabulary the manual
 *  override system uses, so both can be classified/compared identically. */
function workoutIdForPlanType(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('rest')) return 'rest';
  if (t.includes('recovery') || t.includes('mobility')) return 'mobility';
  if (t.includes('zone 2') || t.includes('zone2')) return 'zone2';
  if (t.includes('interval')) return 'intervals';
  if (t.includes('push')) return 'push';
  if (t.includes('pull')) return 'pull';
  return null;
}

/** Pure: does this scheduled plan `type` string count as hard? */
function isHardWorkoutType(type) {
  const id = workoutIdForPlanType(type);
  return id != null && isHardWorkoutId(id);
}

// Generic duration text for an auto-downgraded session — the scheduled day's
// OWN plan entry doesn't apply (e.g. Thursday's plan IS "Push"; there's no
// "what would Mobility look like on a Thursday" entry), so this mirrors the
// mobile client's dedicated MOBILITY/ZONE2 session objects (data/workouts.ts)
// closely enough for the brief's "Today's workout: X (duration)" line.
const AUTO_DOWNGRADE_DURATIONS = { mobility: '20–30 min + an easy walk', zone2: '30–45 min' };

/**
 * Pure: does last night's recovery call for easing off TODAY'S scheduled
 * session, absent any manual override? Mirrors the mobile client's
 * getTodaysWorkout() zone logic (mobile/src/data/workouts.ts) bit-for-bit —
 * same precedence (manual override > this auto-downgrade > static schedule),
 * same rule (red always drops to Mobility regardless of what was scheduled;
 * yellow only downgrades a scheduled Pull to Zone 2; everything else is
 * unchanged) — so the brief, the forecast, and the Health tab always describe
 * the SAME effective session instead of two independently-computed answers.
 * Returns the downgraded workoutId, or null when nothing changes.
 */
function autoDowngradeFor(scheduledWorkoutId, band) {
  if (band === 'red') return 'mobility';
  if (band === 'yellow' && scheduledWorkoutId === 'pull') return 'zone2';
  return null;
}

function getWorkout(dayName) {
  const workout = plan[dayName];
  if (!workout) {
    throw new Error(`Unknown day: ${dayName}`);
  }
  return {
    day: dayName,
    type: workout.type,
    duration: workout.duration,
    hrTarget: workout.hrTarget,
    protein: workout.protein,
    hrvNote: 'Green=train as planned | Yellow=downgrade intensity | Red=mobility/walk only',
  };
}

function getTodayWorkout() {
  const dayName = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.TZ || 'America/New_York',
    weekday: 'long',
  }).format(new Date());
  return getWorkout(dayName);
}

/**
 * THE authoritative "what's today's effective workout" resolver. Precedence,
 * highest first: (1) a manual day-swap in workout_overrides (e.g. a voice
 * "swap today to rest"), (2) an automatic recovery-based downgrade when
 * last night's recovery band is red (or yellow on a scheduled Pull day) —
 * see autoDowngradeFor — (3) the scheduled weekly plan unchanged. Every
 * caller that needs to know today's plan (predict.js's forecast,
 * evening-brief.js's plan-vs-actual grading, chat/ask.js's command context,
 * the chief-brief prompt) should call this instead of duplicating the
 * override SQL or reading getTodayWorkout() alone — the latter only knows
 * the static schedule and silently misses BOTH a manual swap and an
 * automatic one, which is exactly how a brief ended up telling the user to
 * "scale back today's Push" hours after red recovery had already swapped it
 * to Mobility on their Health tab.
 *
 * @param {{ asOf?: Date, tz?: string, band?: 'green'|'yellow'|'red'|null }} [opts]
 *   `band` is the recovery band for the day; pass it when the caller already
 *   has it (avoids a redundant lookup) — omit it to have this fetch it itself
 *   via the cached liveRecovery() (cheap: same TTL-cached promise every other
 *   recovery-aware caller in a request already shares).
 * @returns {Promise<{ source: 'override'|'auto_downgrade'|'scheduled', workoutId: string|null,
 *   label: string, duration?: string|null, hrTarget?: string|null,
 *   protein?: string|null, isHard: boolean, scheduledWorkoutId?: string|null,
 *   scheduledLabel?: string, recoveryBand?: string|null }>}
 */
async function getEffectiveWorkout({ asOf = new Date(), tz = process.env.TZ || 'America/New_York', band } = {}) {
  const day = asOf.toLocaleDateString('en-CA', { timeZone: tz });
  let overrideId = null;
  try {
    const db = require('../db');
    const { rows } = await db.query(
      `SELECT workout_id FROM workout_overrides WHERE log_date = $1`,
      [day]
    );
    overrideId = rows[0]?.workout_id ?? null;
  } catch { /* fall through to the scheduled plan */ }

  if (overrideId) {
    return {
      source: 'override',
      workoutId: overrideId,
      label: OVERRIDE_LABELS[overrideId] ?? overrideId,
      isHard: isHardWorkoutId(overrideId),
    };
  }

  const dayName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(asOf);
  const scheduled = getWorkout(dayName);
  const scheduledId = workoutIdForPlanType(scheduled.type);

  let resolvedBand = band;
  if (resolvedBand === undefined) {
    try {
      const rec = await require('../intelligence/recovery').liveRecovery();
      resolvedBand = rec?.band ?? null;
    } catch { resolvedBand = null; }
  }
  const downgradeId = autoDowngradeFor(scheduledId, resolvedBand);
  if (downgradeId) {
    return {
      source: 'auto_downgrade',
      workoutId: downgradeId,
      label: OVERRIDE_LABELS[downgradeId] ?? downgradeId,
      duration: AUTO_DOWNGRADE_DURATIONS[downgradeId] ?? null,
      isHard: isHardWorkoutId(downgradeId),
      scheduledWorkoutId: scheduledId,
      scheduledLabel: scheduled.type,
      recoveryBand: resolvedBand,
    };
  }

  return {
    source: 'scheduled',
    workoutId: scheduledId,
    label: scheduled.type,
    duration: scheduled.duration,
    hrTarget: scheduled.hrTarget,
    protein: scheduled.protein,
    isHard: isHardWorkoutType(scheduled.type),
  };
}

// The next `days` days' scheduled sessions (NOT including today), for
// week-ahead periodization advice. Reads the same fixed weekly plan as
// getTodayWorkout — doesn't know about manual day swaps (workout_overrides),
// same simplification getTodayWorkout already makes for today.
function getUpcomingWorkouts(days = 3) {
  const tz = process.env.TZ || 'America/New_York';
  const out = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(Date.now() + i * 86400000);
    const dayName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(d);
    out.push({ day: dayName, type: plan[dayName]?.type ?? 'Rest' });
  }
  return out;
}

// A commitment (from THE ACTION card's "Commit to something else" freeform
// box, or a manually-typed commitment) that says the user is taking a rest
// day used to be pure text — it never touched workout_overrides, the table
// swap_workout writes to. Every OTHER consumer of "today's plan" (this
// module's getTodayWorkout, the evening brief's plan-vs-actual grading,
// chat/ask.js's TODAY'S PLANNED WORKOUT) reads that table, so a rest-day
// commitment was invisible to all of them — the evening brief kept grading
// against the original scheduled session ("Planned Pull — not logged as
// done") even though the user told the app, that same morning, they were
// resting instead. Careful with the regex: "rest day"/"take a rest" are
// specific enough to avoid firing on unrelated uses of "rest" (rest assured,
// restaurant, etc.) — same lesson as evening-readiness.js's SICK_KEYWORDS.
const REST_DAY_COMMITMENT_RE = /\brest day\b|\bfull rest\b|\b(?:taking|take) (?:a |the )?day off\b|\bresting (?:today|instead)\b|\bskip(?:ping)? (?:my |today'?s )?(?:workout|training|session)\b/i;

/** Pure: does this commitment/context text read as "I'm taking a rest day"? */
function isRestDayCommitment(text) {
  return REST_DAY_COMMITMENT_RE.test(String(text || ''));
}

/**
 * Write-through: same upsert swap_workout performs (see chat/executeAction.js,
 * routes/workout.js), so a rest-day commitment becomes visible to every other
 * reader of workout_overrides, not just the commitments list.
 */
async function applyRestDayOverride(tz = process.env.TZ || 'America/New_York') {
  const db = require('../db');
  const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  await db.query(
    `INSERT INTO workout_overrides (log_date, workout_id) VALUES ($1, 'rest')
     ON CONFLICT (log_date) DO UPDATE SET workout_id = EXCLUDED.workout_id, created_at = now()`,
    [day]
  );
}

module.exports = {
  getWorkout, getTodayWorkout, getUpcomingWorkouts, isRestDayCommitment, applyRestDayOverride,
  getEffectiveWorkout, isHardWorkoutId, isHardWorkoutType, workoutIdForPlanType, OVERRIDE_LABELS,
  autoDowngradeFor,
};
