// Human-readable labels and "which direction is good" for known metrics.
// Used to turn raw findings into natural-language narratives. Unknown metrics
// fall back to a title-cased label and neutral direction.

// goodWhen: 'up' = higher is better, 'down' = lower is better, null = neutral.
const CATALOG = {
  'health:hrv': { label: 'HRV', goodWhen: 'up' },
  'health:resting_hr': { label: 'Resting HR', goodWhen: 'down' },
  'health:sleep_hours': { label: 'Sleep', goodWhen: 'up' },
  'health:sleep_score': { label: 'Sleep score', goodWhen: 'up' },
  'health:deep_sleep_hours': { label: 'Deep sleep', goodWhen: 'up' },
  'health:rem_sleep_hours': { label: 'REM sleep', goodWhen: 'up' },
  'health:steps': { label: 'Steps', goodWhen: 'up' },
  'health:active_energy': { label: 'Active energy', goodWhen: 'up' },
  'health:exercise_minutes': { label: 'Exercise', goodWhen: 'up' },
  'health:mindful_minutes': { label: 'Mindfulness', goodWhen: 'up' },
  'health:vo2_max': { label: 'VO₂ max', goodWhen: 'up' },
  'health:respiratory_rate': { label: 'Respiratory rate', goodWhen: null },
  'health:body_fat': { label: 'Body fat', goodWhen: 'down' },
  'health:weight': { label: 'Weight', goodWhen: null },
  'health:wake_time': { label: 'Wake time', goodWhen: null },
  'wellbeing:mood': { label: 'Mood', goodWhen: 'up' },
  'wellbeing:energy': { label: 'Energy', goodWhen: 'up' },
  'wellbeing:focus': { label: 'Focus', goodWhen: 'up' },
  'habits:morning_tm': { label: 'Morning TM', goodWhen: 'up' },
  'habits:afternoon_tm': { label: 'Afternoon TM', goodWhen: 'up' },
  'habits:gratitude': { label: 'Gratitude journal', goodWhen: 'up' },
  'habits:cold_shower': { label: 'Cold shower', goodWhen: 'up' },
  'habits:exercise': { label: 'Exercise (habit)', goodWhen: 'up' },
  'habits:exercise_time_of_day': { label: 'Exercise timing', goodWhen: null },
  'habits:eat_healthy': { label: 'Eating healthy', goodWhen: 'up' },
  'habits:habit_score': { label: 'Habit completion', goodWhen: 'up' },
  'wealth:net_worth': { label: 'Net worth', goodWhen: 'up' },
  'wealth:assets': { label: 'Assets', goodWhen: 'up' },
  'wealth:liabilities': { label: 'Liabilities', goodWhen: 'down' },
  'wealth:cash': { label: 'Cash', goodWhen: null },
  'wealth:investments': { label: 'Investments', goodWhen: 'up' },
  'wealth:spending': { label: 'Spending', goodWhen: null },
  'wealth:spending_discretionary': { label: 'Discretionary spending', goodWhen: null },
  'wealth:income': { label: 'Income', goodWhen: 'up' },
  'wealth:net_cashflow': { label: 'Net cashflow', goodWhen: 'up' },
  'productivity:meetings': { label: 'Meetings', goodWhen: null },
  'productivity:calendar_events': { label: 'Calendar events', goodWhen: null },
  'environment:temperature': { label: 'Temperature', goodWhen: null },
  'environment:humidity': { label: 'Humidity', goodWhen: null },
  'environment:uv_index': { label: 'UV index', goodWhen: null },
};

// Nightly context tags (context:<key>) — registered so the intelligence layer
// tracks/correlates them. goodWhen null: direction is learned from the data.
for (const t of require('./context-tags').CONTEXT_TAGS) {
  CATALOG[`context:${t.key}`] = { label: t.label, goodWhen: null };
}

// Flow/count metrics are summed per day; everything else is averaged.
const SUM_METRICS = new Set([
  'steps',
  'active_energy',
  'exercise_minutes',
  'mindful_minutes',
  'meetings',
  'calendar_events',
  'spending',
  'spending_discretionary',
  'income',
  'net_cashflow',
]);

function key(domain, metric) {
  return `${domain}:${metric}`;
}

function titleCase(s) {
  return s
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function label(domain, metric) {
  return CATALOG[key(domain, metric)]?.label || titleCase(metric);
}

function goodWhen(domain, metric) {
  return CATALOG[key(domain, metric)]?.goodWhen ?? null;
}

// Is this a metric we deliberately track and want findings on? The intelligence
// layer gates on this so retired/unknown metrics lingering in the spine (old
// sync counts, experiments) can't generate spurious trends or anomalies.
function isTracked(domain, metric) {
  return Object.prototype.hasOwnProperty.call(CATALOG, key(domain, metric));
}

function aggFor(metric) {
  return SUM_METRICS.has(metric) ? 'sum' : 'avg';
}

/**
 * Qualitative label for a 1-5 self-rated value (mood/energy/focus, eating
 * well) — "low" / "ok" / "high", never the raw number. Used everywhere these
 * surface (self-model, briefs, chat) so a check-in reads as something a
 * person said ("energy's been low") rather than a clinical "2.3/5".
 */
function wellbeingLevel(v) {
  if (v == null) return null;
  return v >= 4 ? 'high' : v >= 3 ? 'ok' : 'low';
}

module.exports = { CATALOG, key, label, goodWhen, isTracked, aggFor, titleCase, wellbeingLevel };
