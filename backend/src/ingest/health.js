// Maps an inbound health payload (from the mobile app's HealthKit read) into
// canonical metric rows. Accepts either:
//   1. An array of canonical rows: [{ metric, value, unit?, ts?, metadata? }]
//   2. A flat object of known HealthKit fields: { hrv, restingHeartRate, ... }
const { dayAnchorTs, safeDate } = require('../util/date');

const SOURCE = 'apple_health';
const DOMAIN = 'health';

// Physiological bounds — values outside these are almost certainly sensor
// glitches or Apple Health import artifacts. Filter before writing to the spine
// so a bad sync can't corrupt rolling averages and recovery scores.
const BOUNDS = {
  hrv:               [2,   300],  // ms
  resting_hr:        [25,  130],  // bpm
  sleep_hours:       [0.5, 16],
  sleep_score:       [0,   100],
  steps:             [0,   100000],
  active_energy:     [0,   7000], // kcal
  exercise_minutes:  [0,   720],
  deep_sleep_hours:  [0,   14],
  rem_sleep_hours:   [0,   14],
  weight:            [60,  500],  // lbs
  body_fat:          [2,   65],   // percent
  respiratory_rate:  [4,   50],
  vo2_max:           [10,  90],
  mindful_minutes:   [0,   480],
};

function inBounds(metric, value) {
  const b = BOUNDS[metric];
  if (!b) return true;
  return value >= b[0] && value <= b[1];
}

// Known HealthKit-ish fields -> canonical metric name + unit.
const FIELD_MAP = {
  // Heart / recovery
  hrv: ['hrv', 'ms'],
  heartRateVariability: ['hrv', 'ms'],
  restingHeartRate: ['resting_hr', 'bpm'],
  restingHr: ['resting_hr', 'bpm'],
  respiratoryRate: ['respiratory_rate', 'breaths_per_min'],
  vo2Max: ['vo2_max', 'ml_kg_min'],
  // Sleep
  sleepHours: ['sleep_hours', 'hours'],
  sleep: ['sleep_hours', 'hours'],
  deepSleepHours: ['deep_sleep_hours', 'hours'],
  remSleepHours: ['rem_sleep_hours', 'hours'],
  sleepScore: ['sleep_score', 'score'],
  // Activity
  steps: ['steps', 'count'],
  activeEnergy: ['active_energy', 'kcal'],
  activeCalories: ['active_energy', 'kcal'],
  exerciseMinutes: ['exercise_minutes', 'minutes'],
  mindfulMinutes: ['mindful_minutes', 'minutes'],
  // Body
  weight: ['weight', 'lb'],
  bodyWeight: ['weight', 'lb'],
  bodyFat: ['body_fat', 'percent'],
  bodyFatPercentage: ['body_fat', 'percent'],
};

function mapHealthPayload(body, { ts, tz = 'UTC' } = {}) {
  // Anchor to one stable per-day timestamp (noon UTC of the local date), exactly
  // like habits/check-in. Two reasons this matters:
  //  - WITHOUT it, every app refresh wrote a NEW row (the request's millisecond
  //    time never hit the (ts,domain,metric,source) upsert), so steps/active
  //    energy — which sum per day — inflated several-fold across refreshes.
  //  - Noon-UTC-of-the-LOCAL-date also buckets to the correct local day, so an
  //    evening reading isn't filed on tomorrow (UTC) and misaligned from that
  //    day's mood/habits in correlations.
  const when = safeDate(ts) || dayAnchorTs(tz);

  if (Array.isArray(body)) {
    return body
      .filter((r) => r && r.metric != null && Number.isFinite(Number(r.value)))
      .map((r) => {
        const value = Number(r.value);
        if (!inBounds(r.metric, value)) {
          console.warn(`[health ingest] out-of-bounds value rejected: ${r.metric}=${value}`);
          return null;
        }
        // Anchor a client-supplied per-row ts the same way `when` is anchored
        // (noon UTC of ITS OWN local calendar day) instead of using the raw
        // HealthKit sample timestamp verbatim — otherwise two refreshes for
        // the same logical day land at different `ts` values, miss the
        // (ts, domain, metric, source) upsert conflict target, and both
        // persist as separate rows. This is the same duplication this app
        // already hit once in production (see db/migrations/019's incident
        // note) and shipped four repair migrations for; this closes the gap
        // in the writer itself rather than repairing it after the fact.
        const rowTs = safeDate(r.ts) ? dayAnchorTs(tz, safeDate(r.ts)) : when;
        return {
          ts: rowTs,
          domain: DOMAIN,
          metric: r.metric,
          value,
          unit: r.unit ?? null,
          source: SOURCE,
          metadata: r.metadata ?? {},
        };
      })
      .filter(Boolean);
  }

  if (body && typeof body === 'object') {
    return Object.entries(body)
      .map(([key, value]) => {
        const mapped = FIELD_MAP[key];
        if (!mapped || !Number.isFinite(Number(value))) return null;
        const [metric, unit] = mapped;
        const num = Number(value);
        if (!inBounds(metric, num)) {
          console.warn(`[health ingest] out-of-bounds value rejected: ${metric}=${num}`);
          return null;
        }
        return { ts: when, domain: DOMAIN, metric, value: num, unit, source: SOURCE };
      })
      .filter(Boolean);
  }

  return [];
}

module.exports = { mapHealthPayload, SOURCE, DOMAIN };
