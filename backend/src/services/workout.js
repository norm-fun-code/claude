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

module.exports = { getWorkout, getTodayWorkout, getUpcomingWorkouts, isRestDayCommitment, applyRestDayOverride };
