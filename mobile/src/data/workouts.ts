export type HRVZone = 'green' | 'yellow' | 'red' | 'unknown';

export interface Exercise {
  name: string;
  sets: string;
  rest?: string;
  load?: string;
  cue?: string;
  flag?: string;
}

export interface StrengthSession {
  id: string;
  label: string;
  duration: string;
  warmup: Exercise[];
  working: Exercise[];
}

export interface Zone2Session {
  id: 'zone2';
  label: string;
  duration: string;
  details: string[];
}

export interface IntervalsPhase {
  phase: string;
  duration: string;
  hr: string;
  note: string;
}

export interface IntervalsSession {
  id: 'intervals';
  label: string;
  duration: string;
  equipment: string;
  phases: IntervalsPhase[];
  note_yellow_hrv: string;
}

export interface MobilityExercise {
  name: string;
  sets: string;
  cue: string;
}

export interface MobilitySession {
  id: 'mobility';
  label: string;
  duration: string;
  note: string;
  exercises: MobilityExercise[];
}

export interface RestSession {
  id: 'rest';
  label: string;
  note: string;
}

export type AnySession =
  | StrengthSession
  | Zone2Session
  | IntervalsSession
  | MobilitySession
  | RestSession;

export interface WorkoutResult {
  workout: AnySession;
  zone: HRVZone;
  override?: string;
}

export const SESSION_A: StrengthSession = {
  id: 'push',
  label: 'Push',
  duration: '~45 min',
  warmup: [
    {
      name: 'Band pull-aparts',
      sets: '2 × 15',
      rest: '30 sec',
      load: 'Light band',
      cue: 'Scapular retraction. Counteracts forward head posture. Always first.',
    },
    {
      name: 'Chin tucks',
      sets: '2 × 10 (hold 3 sec each)',
      rest: '30 sec',
      load: 'Bodyweight',
      cue: 'Draw chin straight back — not down. Restores cervical lordosis.',
    },
  ],
  working: [
    {
      name: 'Machine Incline Chest Press',
      sets: '3 × 8–12',
      rest: '75 sec',
      cue: 'Head back against pad throughout. Exhale on press.',
    },
    {
      name: 'DB Lateral Raises',
      sets: '3 × 12–15',
      rest: '60 sec',
      cue: 'Controlled arc — no shrugging. Lead with elbows, not wrists.',
    },
    {
      name: 'Cable Triceps Pushdown',
      sets: '3 × 10–15',
      rest: '60 sec',
      cue: 'Eyes forward, head neutral. Elbows locked at sides. Full extension at bottom.',
    },
    {
      name: 'Leg Press',
      sets: '3 × 8–12',
      rest: '75 sec',
      cue: 'Exhale on push — no breath-hold. Feet shoulder-width, toes slightly out. Full range without lower back rounding.',
    },
    {
      name: 'Calf Raises',
      sets: '3 × 12–15',
      rest: '45 sec',
      cue: 'Full range: all the way up, all the way down. Pause at the stretch.',
    },
  ],
};

export const SESSION_B: StrengthSession = {
  id: 'pull',
  label: 'Pull',
  duration: '~45 min',
  warmup: [
    {
      name: 'Chin tucks',
      sets: '2 × 10 (hold 3 sec each)',
      rest: '30 sec',
      load: 'Bodyweight',
      cue: 'Draw chin straight back. Restores cervical lordosis before loading the posterior chain.',
    },
    {
      name: 'Band pull-aparts',
      sets: '2 × 15',
      rest: '30 sec',
      load: 'Light band',
      cue: 'Highest-priority accessory — do these every day as a desk break too.',
    },
  ],
  working: [
    {
      name: 'Lat Pulldown (front)',
      sets: '3 × 8–12',
      rest: '75 sec',
      cue: 'Pull to upper chest only — never behind the neck. Chest tall, no forward lean.',
    },
    {
      name: 'Seated Cable Row',
      sets: '3 × 10–12',
      rest: '75 sec',
      cue: 'Chest tall throughout. Squeeze shoulder blades at the finish. Control the return.',
    },
    {
      name: 'Face Pulls',
      sets: '3 × 15',
      rest: '45 sec',
      cue: 'Highest-priority accessory. External rotation at peak, elbows high. Also do 1 set as a desk break 2× per day.',
    },
    {
      name: 'DB Bicep Curls',
      sets: '3 × 10–12',
      rest: '45 sec',
      cue: 'Controlled tempo — slow 3-sec eccentric. No swinging.',
    },
    {
      name: 'Leg Extensions',
      sets: '3 × 10–12',
      rest: '60 sec',
      load: 'Light-moderate',
      cue: 'Or DB Romanian Deadlift (light, neutral spine). Full extension, slow 3-sec return.',
    },
  ],
};

export const ZONE2: Zone2Session = {
  id: 'zone2',
  label: 'Zone 2 — Incline Walk or Jog',
  duration: '30–45 min',
  details: [
    'Incline walk (treadmill 6–10% grade or hills) or easy jog — your pick',
    'Target HR: 135–145 BPM throughout',
    'Should be able to hold a conversation at target HR',
    'Walking flat usually undershoots target HR — add grade or switch to a jog',
    'If HR above 145: ease off. If below 135: add grade or pace.',
  ],
};

export const INTERVALS: IntervalsSession = {
  id: 'intervals',
  label: '4×4 Norwegian Intervals',
  duration: '~55 min total',
  equipment: 'Stationary bike, rower, or steep incline treadmill (12–15% grade)',
  note_yellow_hrv:
    'On yellow HRV: do 2 rounds only (Intervals 1–2 + recoveries). Still worth doing.',
  phases: [
    { phase: 'Warm-up', duration: '10 min', hr: '100–120 BPM', note: 'Easy progressive effort. Never skip.' },
    { phase: 'Interval 1', duration: '4 min', hr: '162–170 BPM', note: 'High resistance. This is the VO2max stimulus window.' },
    { phase: 'Recovery 1', duration: '4 min', hr: '< 120 BPM', note: 'Drop resistance sharply. Active recovery only.' },
    { phase: 'Interval 2', duration: '4 min', hr: '162–170 BPM', note: 'Maintain same output as round 1.' },
    { phase: 'Recovery 2', duration: '4 min', hr: '< 120 BPM', note: 'Hydrate. Breathe. Keep moving.' },
    { phase: 'Interval 3', duration: '4 min', hr: '162–170 BPM', note: 'Hardest round mentally. Hold the line.' },
    { phase: 'Recovery 3', duration: '4 min', hr: '< 120 BPM', note: 'Controlled breathing.' },
    { phase: 'Interval 4', duration: '4 min', hr: '162–170 BPM', note: 'Final push. Everything left.' },
    { phase: 'Cool-down', duration: '10 min', hr: '< 110 BPM', note: 'Gradual descent. Do not stop abruptly.' },
  ],
};

export const MOBILITY: MobilitySession = {
  id: 'mobility',
  label: 'Yoga + Walk',
  duration: 'Yoga routine + 20+ min walk',
  note: 'Do your full yoga routine, then a 20+ min walk at easy pace. Walk should be flat and comfortable — this is active recovery, not Zone 2. Fine to do in the evening.',
  exercises: [
    {
      name: 'Yoga routine',
      sets: 'Full session',
      cue: 'Your standard yoga routine. Focus on thoracic mobility and hip openers where possible — both support your cervical and pelvic floor PT work.',
    },
    {
      name: 'Walk',
      sets: '20+ min',
      cue: 'Easy flat pace, well below Zone 2 HR (aim for under 120 BPM). This is restorative, not training.',
    },
  ],
};

export const REST: RestSession = {
  id: 'rest',
  label: 'Rest Day',
  note: 'No structured training. A gentle 10–20 min walk is fine and encouraged — it activates AMPK without adding recovery cost. This is where adaptation happens.',
};

export const WEEKLY_SCHEDULE: Record<number, string> = {
  0: 'pull', // Sunday → Pull (HRV logic downgrades if yellow/red)
  1: 'zone2',
  2: 'mobility',
  3: 'intervals',
  4: 'push',
  5: 'rest',
  6: 'zone2',
};

export const HRV_ZONES: Record<
  'green' | 'yellow' | 'red',
  { min: number; color: string; instruction: string }
> = {
  green: {
    min: 50,
    color: '#1D9E75',
    instruction: 'Full planned session at target intensity.',
  },
  yellow: {
    min: 35,
    color: '#BA7517',
    instruction: 'Reduce load 20%. Drop to 2 sets. No PRs.',
  },
  red: {
    min: 0,
    color: '#993C1D',
    instruction: 'Zone 2 walk only. Skip all strength and intervals.',
  },
};

export function getHRVZone(hrv: number): 'green' | 'yellow' | 'red' {
  if (hrv >= 50) return 'green';
  if (hrv >= 35) return 'yellow';
  return 'red';
}

/**
 * Resolve the day's session and training zone. The zone drives auto-downgrades
 * (e.g. Pull → Zone 2 on a low day). `zoneOverride` lets the caller supply the
 * baseline-relative RECOVERY band (green/yellow/red) so training guidance matches
 * the Recovery card — instead of the old absolute HRV thresholds where 50ms read
 * "green" even when it was below your personal baseline. Falls back to the raw
 * HRV zone when no recovery band is available (e.g. viewing a non-today column).
 */
export function getTodaysWorkout(
  dayOfWeek: number,
  hrv: number | null,
  zoneOverride?: HRVZone | null,
): WorkoutResult {
  const scheduled = WEEKLY_SCHEDULE[dayOfWeek];
  const workoutMap: Record<string, AnySession> = {
    zone2: ZONE2,
    mobility: MOBILITY,
    push: SESSION_A,
    pull: SESSION_B,
    rest: REST,
    intervals: INTERVALS,
  };

  // Zone priority: explicit recovery band > raw HRV > unknown (scheduled as-is).
  const zone: HRVZone = zoneOverride ?? (hrv === null ? 'unknown' : getHRVZone(hrv));

  if (zone === 'unknown') {
    return { workout: workoutMap[scheduled] ?? REST, zone: 'unknown' };
  }
  if (zone === 'red') {
    return { workout: ZONE2, zone, override: 'Low recovery — all training replaced with Zone 2.' };
  }
  if (scheduled === 'pull') {
    if (zone === 'green') return { workout: SESSION_B, zone };
    return { workout: ZONE2, zone, override: 'Moderate recovery — Pull session replaced with Zone 2.' };
  }
  if (scheduled === 'intervals') return { workout: INTERVALS, zone };
  return { workout: workoutMap[scheduled] ?? REST, zone };
}
