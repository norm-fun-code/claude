// Maps an inbound health payload (from the mobile app's HealthKit read) into
// canonical metric rows. Accepts either:
//   1. An array of canonical rows: [{ metric, value, unit?, ts?, metadata? }]
//   2. A flat object of known HealthKit fields: { hrv, restingHeartRate, ... }
const { dayAnchorTs, safeDate } = require('../util/date');

const SOURCE = 'apple_health';
const DOMAIN = 'health';

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
      .map((r) => ({
        ts: safeDate(r.ts) || when,
        domain: DOMAIN,
        metric: r.metric,
        value: Number(r.value),
        unit: r.unit ?? null,
        source: SOURCE,
        metadata: r.metadata ?? {},
      }));
  }

  if (body && typeof body === 'object') {
    return Object.entries(body)
      .map(([key, value]) => {
        const mapped = FIELD_MAP[key];
        if (!mapped || !Number.isFinite(Number(value))) return null;
        const [metric, unit] = mapped;
        return { ts: when, domain: DOMAIN, metric, value: Number(value), unit, source: SOURCE };
      })
      .filter(Boolean);
  }

  return [];
}

module.exports = { mapHealthPayload, SOURCE, DOMAIN };
