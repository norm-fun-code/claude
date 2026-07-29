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
// use. Every plan-type string maps onto one of these so overrides and the
// scheduled plan can be compared and classified with a single vocabulary
// instead of two parallel ones.
const OVERRIDE_LABELS = { push: 'Push', pull: 'Pull', zone2: 'Zone 2', mobility: 'Mobility', intervals: 'Intervals', rest: 'Rest' };

// Derived from OVERRIDE_LABELS' own keys (not a second, separately-maintained
// list) — this used to be redefined independently in routes/workout.js, a
// duplicated vocabulary the comment above already warned against.
const VALID_WORKOUT_IDS = new Set(Object.keys(OVERRIDE_LABELS));

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

  const dayName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(asOf);
  const scheduled = getWorkout(dayName);
  const scheduledId = workoutIdForPlanType(scheduled.type);

  if (overrideId) {
    return {
      source: 'override',
      workoutId: overrideId,
      label: OVERRIDE_LABELS[overrideId] ?? overrideId,
      isHard: isHardWorkoutId(overrideId),
      // Always carry the scheduled baseline the override REPLACED, even for a
      // manual override — otherwise the claim validator can't tell that a brief
      // prescribing the original scheduled session contradicts an override that
      // swapped it away (the override branch used to omit these).
      scheduledWorkoutId: scheduledId,
      scheduledLabel: scheduled.type,
    };
  }

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
 * Transactional Brain Invalidation (audit recommendation #2), item 4: THE
 * ONE shared write path for every workout-override mutation — the manual
 * REST route (routes/workout.js), Ask/realtime voice's swap_workout
 * (chat/executeAction.js, shared by both since realtimeTools.js and
 * routes/chat.js/voice.js all funnel through the same executeAction()), and
 * the rest-day-commitment helper below all call this instead of each
 * upserting/deleting workout_overrides and invalidating independently. Live
 * bug this replaces: executeAction.js's swap_workout wrote workout_overrides
 * directly with no invalidation at all — a voice/Ask-driven swap left the
 * forecast/brief/surfaces silently stale until something ELSE happened to
 * invalidate workout_override.
 *
 * `workoutId` null/falsy reverts the day to the scheduled split (DELETE);
 * otherwise it must be one of VALID_WORKOUT_IDS. Idempotent (an UPSERT / a
 * DELETE of a possibly-already-absent row, either way safe to call twice).
 * Invalidates the workout_override trigger through the ONE bus — but ONLY
 * when the override state actually CHANGED (a DELETE that removed a real
 * row, or an UPSERT whose workout_id genuinely differs from what was already
 * stored) — never for a no-op call (re-applying the same swap twice, or
 * clearing a day that had no override to begin with). This avoids pointless
 * durable version churn (and the awaited DB round trip that comes with it)
 * for a call that changes nothing observable. Throws on an invalid
 * workoutId (the REST route turns that into its own 400; callers that
 * already validate upstream — like executeAction's own VALID_WORKOUT_IDS
 * check — won't hit it).
 */
async function setWorkoutOverride({ date, workoutId = null } = {}) {
  if (!date) throw new Error('setWorkoutOverride: date is required');
  const db = require('../db');
  let changed;
  if (!workoutId) {
    const { rowCount } = await db.query('DELETE FROM workout_overrides WHERE log_date = $1', [date]);
    changed = rowCount > 0;
  } else {
    if (!VALID_WORKOUT_IDS.has(workoutId)) throw new Error(`setWorkoutOverride: invalid workoutId "${workoutId}"`);
    // The WHERE clause on DO UPDATE makes this a genuine no-op (rowCount 0)
    // when the stored workout_id already matches — a fresh INSERT, or an
    // UPDATE that actually changes the value, both report rowCount 1.
    const { rowCount } = await db.query(
      `INSERT INTO workout_overrides (log_date, workout_id) VALUES ($1, $2)
       ON CONFLICT (log_date) DO UPDATE SET workout_id = EXCLUDED.workout_id, created_at = now()
         WHERE workout_overrides.workout_id IS DISTINCT FROM EXCLUDED.workout_id`,
      [date, workoutId]
    );
    changed = rowCount > 0;
  }
  // A workout override changes the effective plan, which the registry
  // declares also invalidates the forecast's hard-session assumption — bump
  // the ONE bus so every consumer of the effective workout / forecast
  // recomputes, exactly once per call regardless of caller, and only when
  // something actually changed. Durable and awaited (not bump()'s
  // fire-and-forget): this is a user-facing-state mutation the caller is
  // about to respond to the user as "done," so a request that immediately
  // hits a different instance right after must not be able to observe the
  // pre-swap state (Transactional Brain Invalidation, audit recommendation #2).
  if (changed) {
    await require('../brain/invalidation').bumpDurable('workout_override', { date });
  }
  return { date, workoutId: workoutId || null };
}

/**
 * Write-through: same upsert setWorkoutOverride performs, so a rest-day
 * commitment becomes visible to every other reader of workout_overrides,
 * not just the commitments list.
 */
async function applyRestDayOverride(tz = process.env.TZ || 'America/New_York') {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  await setWorkoutOverride({ date: day, workoutId: 'rest' });
}

/**
 * THE ONE shared write path for explicit workout-level completion
 * (workout_completions) — the "Mark as complete" button on the workout
 * currently displayed. Mirrors setWorkoutOverride's shape exactly: null/
 * falsy workoutId reverts to "not completed" (DELETE); otherwise upserts an
 * explicit completion record for `date`, keyed to `workoutId` (the effective
 * workout being marked) with `source` provenance ('manual' from the button,
 * 'activity_match' when resolveTrainingOutcome infers completion from a
 * logged activity whose type matches the effective workout — see below).
 * Idempotent; invalidates the 'training_change' trigger (→ trainingOutcome →
 * todayForecast) durably, and ONLY when something actually changed.
 */
async function setWorkoutCompletion({ date, workoutId = null, source = 'manual' } = {}) {
  if (!date) throw new Error('setWorkoutCompletion: date is required');
  const db = require('../db');
  let changed;
  if (!workoutId) {
    const { rowCount } = await db.query('DELETE FROM workout_completions WHERE log_date = $1', [date]);
    changed = rowCount > 0;
  } else {
    if (!VALID_WORKOUT_IDS.has(workoutId)) throw new Error(`setWorkoutCompletion: invalid workoutId "${workoutId}"`);
    const { rowCount } = await db.query(
      `INSERT INTO workout_completions (log_date, workout_id, source) VALUES ($1, $2, $3)
       ON CONFLICT (log_date) DO UPDATE SET workout_id = EXCLUDED.workout_id, source = EXCLUDED.source, completed_at = now()
         WHERE workout_completions.workout_id IS DISTINCT FROM EXCLUDED.workout_id
            OR workout_completions.source IS DISTINCT FROM EXCLUDED.source`,
      [date, workoutId, source]
    );
    changed = rowCount > 0;
  }
  if (changed) {
    await require('../brain/invalidation').bumpDurable('training_change', { date });
  }
  return { date, workoutId: workoutId || null, source: workoutId ? source : null };
}

/** Read the explicit completion record for one date, or null if the day's
 *  effective workout has not been explicitly completed. */
async function getWorkoutCompletion({ date }) {
  const db = require('../db');
  const { rows } = await db.query(
    `SELECT workout_id, source, completed_at FROM workout_completions WHERE log_date = $1`,
    [date]
  );
  const r = rows[0];
  return r ? { workoutId: r.workout_id, source: r.source, completedAt: r.completed_at } : null;
}

/** Human-friendly description of one logged activity, e.g. "a 60-minute
 *  walk" or "a run" — used by the evening brief's deterministic wording so
 *  it never has to guess at phrasing itself. Pure. */
function describeActivity(a) {
  if (!a) return null;
  const label = String(a.label || a.activityType || 'activity').toLowerCase();
  return a.durationMin ? `a ${a.durationMin}-minute ${label}` : `a ${label}`;
}

/**
 * THE authoritative "what actually happened toward training today" resolver
 * — the completion counterpart to getEffectiveWorkout's "what's planned".
 * Root-cause fix for the production bug where logging ANY activity (a walk)
 * on a hard-workout day (Intervals) got read as completing that specific
 * scheduled session, because the only completion signal available was the
 * generic Exercise habit boolean — which proves some exercise happened, not
 * WHICH workout or whether it was hard.
 *
 * Distinguishes:
 *   - exerciseHabitDone: the generic habit metric — proves only that SOME
 *     exercise occurred; never workout identity or intensity.
 *   - plannedWorkoutCompleted: the EFFECTIVE workout's id was explicitly
 *     completed — either a workout_completions row for it (source:'manual',
 *     the Mark Complete button), or a logged activity whose activity_type
 *     exactly equals the effective workoutId (source:'activity_match' —
 *     "explicitly logging an Intervals activity is valid evidence of a hard
 *     session even without tapping Mark Complete"). A logged activity of a
 *     DIFFERENT type (a walk on an Intervals day) never sets this.
 *   - actualActivities: every activity_logs row for the day, structured.
 *   - hardSessionCompleted: true when ANY logged activity's type is itself
 *     a hard workout id (push/pull/intervals — an unplanned hard session
 *     still counts, matching the pre-existing forecast rule), OR the
 *     effective workout was explicitly completed AND is itself hard. NEVER
 *     true from exerciseHabitDone alone, regardless of whether the
 *     effective plan is hard — that inference is exactly the bug this
 *     resolver exists to remove.
 *   - status: none | planned_only | planned_completed | alternate_activity |
 *     mixed | generic_exercise_only — see the branches below.
 *
 * Every DB read is fail-soft (a query failure yields "no evidence", never a
 * thrown error) — a training-outcome resolution failure must not break the
 * forecast/brief it feeds.
 *
 * @param {{ asOf?: Date, tz?: string, effectiveWorkout?: object }} [opts]
 *   Pass `effectiveWorkout` (as BrainSnapshot does) to reuse an
 *   already-resolved getEffectiveWorkout() result instead of a redundant
 *   lookup — omit it to have this resolve it itself.
 */
async function resolveTrainingOutcome({ asOf = new Date(), tz = process.env.TZ || 'America/New_York', effectiveWorkout } = {}) {
  const day = asOf.toLocaleDateString('en-CA', { timeZone: tz });
  const db = require('../db');

  const effective = effectiveWorkout !== undefined
    ? effectiveWorkout
    : await getEffectiveWorkout({ asOf, tz });

  let habitRows = [], activityRows = [], completionRows = [];
  try {
    [{ rows: habitRows }, { rows: activityRows }, { rows: completionRows }] = await Promise.all([
      db.query(
        `SELECT 1 FROM metrics WHERE domain = 'habits' AND metric = 'exercise' AND value >= 0.5
          AND (ts AT TIME ZONE $1)::date = $2::date LIMIT 1`,
        [tz, day]
      ),
      db.query(
        `SELECT activity_type, label, duration_min, created_at
           FROM activity_logs WHERE log_date = $1 ORDER BY created_at ASC`,
        [day]
      ),
      db.query(`SELECT workout_id, source, completed_at FROM workout_completions WHERE log_date = $1`, [day]),
    ]);
  } catch { /* fail-soft — resolve with no evidence rather than throw */ }

  const exerciseHabitDone = habitRows.length > 0;
  const actualActivities = activityRows.map((r) => ({
    activityType: r.activity_type,
    label: r.label,
    durationMin: r.duration_min,
    loggedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  }));

  const plannedWorkoutId = effective?.workoutId ?? null;
  const plannedWorkoutLabel = effective?.label ?? null;

  const manualCompletion = completionRows[0] || null;
  const matchingActivity = plannedWorkoutId
    ? activityRows.find((r) => r.activity_type === plannedWorkoutId) || null
    : null;

  let plannedWorkoutCompleted = false;
  let completionSource = null;
  let completedAt = null;
  if (manualCompletion && manualCompletion.workout_id === plannedWorkoutId) {
    plannedWorkoutCompleted = true;
    completionSource = manualCompletion.source || 'manual';
    completedAt = manualCompletion.completed_at ? new Date(manualCompletion.completed_at).toISOString() : null;
  } else if (matchingActivity) {
    plannedWorkoutCompleted = true;
    completionSource = 'activity_match';
    completedAt = matchingActivity.created_at ? new Date(matchingActivity.created_at).toISOString() : null;
  }

  const hardSessionCompleted =
    activityRows.some((r) => isHardWorkoutId(r.activity_type)) ||
    (plannedWorkoutCompleted && isHardWorkoutId(plannedWorkoutId));

  // Activities that are NOT evidence of the planned workout itself — logged
  // alongside an explicit completion (mixed), or on their own with no
  // completion at all (alternate_activity).
  const extraActivities = actualActivities.filter((a) => a.activityType !== plannedWorkoutId);

  let status;
  const isRestPlan = !plannedWorkoutId || plannedWorkoutId === 'rest';
  if (plannedWorkoutCompleted) {
    status = extraActivities.length > 0 ? 'mixed' : 'planned_completed';
  } else if (actualActivities.length > 0) {
    status = 'alternate_activity';
  } else if (exerciseHabitDone) {
    status = 'generic_exercise_only';
  } else if (isRestPlan) {
    status = 'none';
  } else {
    status = 'planned_only';
  }

  return {
    exerciseHabitDone,
    plannedWorkoutCompleted,
    actualActivities,
    hardSessionCompleted,
    status,
    plannedWorkoutId,
    plannedWorkoutLabel,
    completionSource,
    completedAt,
  };
}

module.exports = {
  getWorkout, getTodayWorkout, getUpcomingWorkouts, isRestDayCommitment, applyRestDayOverride,
  getEffectiveWorkout, isHardWorkoutId, isHardWorkoutType, workoutIdForPlanType, OVERRIDE_LABELS,
  VALID_WORKOUT_IDS, setWorkoutOverride,
  autoDowngradeFor,
  setWorkoutCompletion, getWorkoutCompletion, resolveTrainingOutcome, describeActivity,
};
