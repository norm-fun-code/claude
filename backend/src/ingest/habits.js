// Maps the end-of-day habit stack into canonical daily metrics. Each habit is a
// 0/1 daily signal; eat_healthy is a 1–5 scale; habit_score is the % of the
// binary habits completed — a single number that correlates strongly with
// next-day outcomes (HRV, focus, mood). Domain 'habits' keeps them grouped.
const { dayAnchorTs } = require('../util/date');

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
  const when = ts || body.ts ? new Date(ts || body.ts) : dayAnchorTs(tz);
  const metrics = [];
  let done = 0;
  let count = 0;

  for (const [field, metric] of Object.entries(BINARY)) {
    if (body[field] === undefined || body[field] === null) continue;
    const value = body[field] ? 1 : 0;
    metrics.push({ ts: when, domain: DOMAIN, metric, value, unit: 'bool', source: SOURCE });
    count += 1;
    done += value;
  }

  const eat = Number(body.eatHealthy);
  if (Number.isFinite(eat)) {
    metrics.push({ ts: when, domain: DOMAIN, metric: 'eat_healthy', value: eat, unit: 'score', source: SOURCE });
  }

  // Composite completion (0–100) over whatever binary habits were reported.
  if (count > 0) {
    metrics.push({
      ts: when, domain: DOMAIN, metric: 'habit_score',
      value: Math.round((done / count) * 100), unit: 'percent', source: SOURCE,
    });
  }

  return { metrics };
}

module.exports = { mapHabits, SOURCE, DOMAIN };
