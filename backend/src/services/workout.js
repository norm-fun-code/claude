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

module.exports = { getWorkout, getTodayWorkout, getUpcomingWorkouts };
