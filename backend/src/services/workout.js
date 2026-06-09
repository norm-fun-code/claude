const plan = {
  Monday: {
    type: 'Zone 2 Walk',
    duration: '45 min',
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
    type: 'Japanese Intervals',
    duration: '45–55 min',
    hrTarget: null,
    protein: '70–85g',
  },
  Thursday: {
    type: 'Strength — Push',
    duration: '45–60 min',
    hrTarget: null,
    protein: '100–115g',
  },
  Friday: {
    type: 'Full Recovery',
    duration: null,
    hrTarget: null,
    protein: '70–85g',
  },
  Saturday: {
    type: 'Zone 2 Walk',
    duration: '45 min',
    hrTarget: '135–145 bpm',
    protein: '70–85g',
  },
  Sunday: {
    type: 'Strength — Pull',
    duration: '45–60 min',
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

module.exports = { getWorkout, getTodayWorkout };
