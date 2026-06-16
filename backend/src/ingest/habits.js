// Maps the end-of-day habit stack into canonical daily metrics. Each habit is a
// 0/1 daily signal; eat_healthy is a 1–5 scale; habit_score is the % of the
// binary habits completed — a single number that correlates strongly with
// next-day outcomes (HRV, focus, mood). Domain 'habits' keeps them grouped.
const { dayAnchorTs, safeDate } = require('../util/date');

const SOURCE = 'habits';
const DOMAIN = 'habits';

// Incoming field (from the app) -> canonical metric name.
const BINARY = {
  morningTM: 'morning_tm',
  afternoonTM: 'afternoon_tm',
  gratitude: 'gratitude',
  coldShower: 'cold_shower',
  exercise: 'exercise',
};

function mapHabits(body = {}, { ts, tz = 'UTC' } = {}) {
  // Anchor to one stable per-day timestamp so incremental saves (checking boxes
  // one at a time through the day) upsert the same day's rows rather than piling
  // up duplicates — keeping the daily 0/1 signal clean for insights.
  const when = safeDate(ts ?? body.ts) || dayAnchorTs(tz);
  const metrics = [];
  let done = 0;
  let count = 0;

  for (const [field, metric] of Object.entries(BINARY)) {
    if (body[field] === undefined || body[field] === null) continue;
    const value = body[field] ? 1 : 0;
    metrics.push({ ts: when, domain: DOMAIN, metric, value, unit: 'bool', source: SOURCE });
    count += 1;
    done += value;
    // Log hour-of-day (0–23.99) when exercise is completed — enables timing vs
    // sleep/recovery correlations ("late workouts suppress HRV?").
    if (field === 'exercise' && value === 1 && body.exerciseCompletedAt) {
      const completedAt = new Date(body.exerciseCompletedAt);
      if (!isNaN(completedAt.getTime())) {
        const hoursOfDay = completedAt.getHours() + completedAt.getMinutes() / 60;
        metrics.push({ ts: when, domain: DOMAIN, metric: 'exercise_time_of_day', value: Math.round(hoursOfDay * 100) / 100, unit: 'hours', source: SOURCE });
      }
    }
  }

  const eat = Number(body.eatHealthy);
  if (Number.isFinite(eat) && eat >= 1 && eat <= 5) {
    metrics.push({ ts: when, domain: DOMAIN, metric: 'eat_healthy', value: eat, unit: 'score', source: SOURCE });
  }

  // Note: habit_score (the 0–100 composite) is NOT computed here. The /api/habits
  // route recomputes it from ALL of today's persisted binary habits after the
  // insert, so partial saves (e.g. the workout panel toggling just `exercise`)
  // and full submissions both yield a correct, consistent composite.

  return { metrics, count, done };
}

module.exports = { mapHabits, SOURCE, DOMAIN };
