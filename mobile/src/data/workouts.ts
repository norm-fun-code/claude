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
  constraints: string[];
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
  label: 'Session A — Push',
  duration: '~35 min',
  constraints: [
    'No Valsalva — exhale on every rep',
    'No cervical extension under load — head on bench throughout',
    'No overhead pressing (permanent — C4-C5 nerve impingement)',
    'Cervical neutral mandatory in all exercises',
  ],
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
    {
      name: 'Shoulder CARs',
      sets: '1 × 5 slow each side',
      rest: '30 sec',
      load: 'Bodyweight',
      cue: 'Full controlled articular rotation. Joint prep before loading.',
    },
  ],
  working: [
    {
      name: 'Incline dumbbell press',
      sets: '3 × 10',
      rest: '75 sec',
      load: 'RPE 7–8, moderate only',
      cue: 'Head stays on bench — never crane or lift neck. Exhale on press. 3-sec eccentric. Cervical neutral is non-negotiable.',
    },
    {
      name: 'Cable chest press (chest height)',
      sets: '3 × 12',
      rest: '60 sec',
      load: 'Light-moderate',
      cue: 'Permanently replaces overhead press. Arms at chest height, step back slightly from cable, press forward. Exhale. Zero cervical risk.',
    },
    {
      name: 'Cable face pull',
      sets: '3 × 15',
      rest: '45 sec',
      load: 'Light',
      cue: 'Priority exercise for rotator cuff AND cervical health. External rotation at peak. Also do 1 set as a desk break 2× per day.',
    },
    {
      name: 'Leg press',
      sets: '3 × 12',
      rest: '75 sec',
      load: 'Moderate — start light, build over weeks',
      cue: 'Feet shoulder-width, toes slightly out. Full range without lower back rounding at the bottom. Exhale on press — no Valsalva. No heavy load given PF constraints.',
    },
    {
      name: 'Leg extension',
      sets: '3 × 12',
      rest: '60 sec',
      load: 'Light-moderate',
      cue: 'Quad isolation. Controlled full extension, slow 3-sec return. No axial load. PF safe.',
    },
    {
      name: 'Copenhagen plank',
      sets: '3 × 25 sec each side',
      rest: '45 sec',
      load: 'Bodyweight',
      cue: 'Hip adductor + lateral core. Top leg on bench, bottom leg elevated. No cervical involvement.',
    },
  ],
};

export const SESSION_B: StrengthSession = {
  id: 'hinge_pull',
  label: 'Session B — Hinge + Pull',
  duration: '~30 min',
  constraints: [
    'No Valsalva — exhale on every rep',
    'No passive dead hang',
    'No heavy axial loading',
    'Cervical neutral: chin tucked, eyes 45° down during RDL',
  ],
  warmup: [
    {
      name: 'Cat-cow + thoracic rotation',
      sets: '2 × 8 each',
      rest: '30 sec',
      load: 'Bodyweight',
      cue: 'Prioritize thoracic extension. Rotation counteracts cervical dextroscoliosis pattern.',
    },
    {
      name: 'Chin tucks',
      sets: '2 × 10 (hold 3 sec)',
      rest: '30 sec',
      load: 'Bodyweight',
      cue: 'Restores cervical lordosis before loading the posterior chain.',
    },
    {
      name: '90/90 hip stretch',
      sets: '1 × 45 sec each side',
      rest: '30 sec',
      load: 'Bodyweight',
      cue: 'Posterior hip capsule prep. Feeds directly into single-leg RDL mechanics.',
    },
  ],
  working: [
    {
      name: 'Single-leg Romanian deadlift',
      sets: '3 × 8 each side',
      rest: '60 sec',
      load: '10–20 lb DB',
      cue: 'Most important longevity exercise in the protocol. Chin tucked, eyes at 45° down — never look up during the balance movement. Hinge from hip, flat back, slow descent.',
    },
    {
      name: 'Neutral grip lat pulldown',
      sets: '3 × 10–12',
      rest: '75 sec',
      load: 'Light-moderate',
      cue: 'V-bar or neutral handle (palms facing each other). Reduces C5 nerve tension vs supinated grip. Chest tall, no forward lean, no cervical flexion under load.',
    },
    {
      name: 'Machine rows',
      sets: '3 × 10–12',
      rest: '60 sec',
      load: 'Moderate',
      cue: 'Horizontal pull — scapular retraction first, then elbow drive. Chest tall throughout. Adds the horizontal pulling pattern the session was missing.',
    },
    {
      name: 'Scapular bar hang',
      sets: '3 × 25 sec',
      rest: '60 sec',
      load: 'Bodyweight',
      cue: 'Grip bar, actively depress and elevate scapulae. Do NOT relax into passive hang — pending Dr. Lachmann clearance for full dead hang due to C3-C4 cord deformity.',
      flag: 'Pending Dr. Lachmann clearance for full dead hang',
    },
    {
      name: 'Hammer curls',
      sets: '3 × 12',
      rest: '45 sec',
      load: 'Moderate DB',
      cue: 'Brachialis and brachioradialis. Neutral grip throughout. Slow 3-sec eccentric. No swinging.',
    },
  ],
};

export const ZONE2: Zone2Session = {
  id: 'zone2',
  label: 'Zone 2 — Incline Walk',
  duration: '45–60 min',
  details: [
    'Incline treadmill 6–10% grade OR outdoor hills — flat walking undershoots target HR',
    'Target HR: 135–145 BPM throughout',
    'Should be able to hold a full conversation at target HR',
    'If HR drops below 135: increase grade. If above 145: decrease grade.',
    'Adjust grade as fitness recovers — you will need more grade to hit same HR over time.',
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
  0: 'hinge_pull', // Sunday → Session B (HRV logic downgrades if yellow/red)
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

export function getTodaysWorkout(dayOfWeek: number, hrv: number | null): WorkoutResult {
  if (hrv === null) {
    const scheduled = WEEKLY_SCHEDULE[dayOfWeek];
    const workoutMap: Record<string, AnySession> = {
      zone2: ZONE2,
      mobility: MOBILITY,
      push: SESSION_A,
      hinge_pull: SESSION_B,
      rest: REST,
      intervals: INTERVALS,
    };
    return { workout: workoutMap[scheduled] ?? REST, zone: 'unknown' };
  }
  const zone = getHRVZone(hrv);
  if (zone === 'red') {
    return { workout: ZONE2, zone, override: 'Red HRV — all training replaced with Zone 2 walk.' };
  }
  const scheduled = WEEKLY_SCHEDULE[dayOfWeek];
  if (scheduled === 'hinge_pull') {
    if (zone === 'green') return { workout: SESSION_B, zone };
    return { workout: ZONE2, zone, override: 'Yellow HRV — Session B replaced with Zone 2 walk.' };
  }
  if (scheduled === 'intervals') return { workout: INTERVALS, zone };
  const workoutMap: Record<string, AnySession> = {
    zone2: ZONE2,
    mobility: MOBILITY,
    push: SESSION_A,
    rest: REST,
  };
  return { workout: workoutMap[scheduled] ?? REST, zone };
}
