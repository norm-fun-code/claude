// Human-readable labels and "which direction is good" for known metrics.
// Used to turn raw findings into natural-language narratives. Unknown metrics
// fall back to a title-cased label and neutral direction.

// goodWhen: 'up' = higher is better, 'down' = lower is better, null = neutral.
// unit: best-effort display unit for the anomaly-context contract (What
// Explains This — audit item) and any other surface that wants to show a
// value with its unit; null/omitted where genuinely unitless or unknown —
// same "graceful degradation for unknown metrics" spirit as goodWhen, not a
// per-metric special case (every metric flows through this one registry).
const CATALOG = {
  'health:hrv': { label: 'HRV', goodWhen: 'up', unit: 'ms' },
  'health:resting_hr': { label: 'Resting HR', goodWhen: 'down', unit: 'bpm' },
  'health:sleep_hours': { label: 'Sleep', goodWhen: 'up', unit: 'hr' },
  'health:sleep_score': { label: 'Sleep score', goodWhen: 'up' },
  'health:deep_sleep_hours': { label: 'Deep sleep', goodWhen: 'up', unit: 'hr' },
  'health:rem_sleep_hours': { label: 'REM sleep', goodWhen: 'up', unit: 'hr' },
  'health:steps': { label: 'Steps', goodWhen: 'up', unit: 'steps' },
  'health:active_energy': { label: 'Active energy', goodWhen: 'up', unit: 'kcal' },
  'health:exercise_minutes': { label: 'Exercise', goodWhen: 'up', unit: 'min' },
  'health:mindful_minutes': { label: 'Mindfulness', goodWhen: 'up', unit: 'min' },
  'health:vo2_max': { label: 'VO₂ max', goodWhen: 'up', unit: 'mL/kg/min' },
  'health:respiratory_rate': { label: 'Respiratory rate', goodWhen: null, unit: 'br/min' },
  'health:body_fat': { label: 'Body fat', goodWhen: 'down', unit: '%' },
  'health:weight': { label: 'Weight', goodWhen: null, unit: 'lb' },
  'health:wake_time': { label: 'Wake time', goodWhen: null },
  'wellbeing:mood': { label: 'Mood', goodWhen: 'up', unit: '/5' },
  'wellbeing:energy': { label: 'Energy', goodWhen: 'up', unit: '/5' },
  'wellbeing:focus': { label: 'Focus', goodWhen: 'up', unit: '/5' },
  'habits:morning_tm': { label: 'Morning TM', goodWhen: 'up' },
  'habits:afternoon_tm': { label: 'Afternoon TM', goodWhen: 'up' },
  'habits:gratitude': { label: 'Gratitude journal', goodWhen: 'up' },
  'habits:exercise': { label: 'Exercise (habit)', goodWhen: 'up' },
  'habits:exercise_time_of_day': { label: 'Exercise timing', goodWhen: null },
  'habits:eat_healthy': { label: 'Eating healthy', goodWhen: 'up' },
  'habits:habit_score': { label: 'Habit completion', goodWhen: 'up' },
  'wealth:net_worth': { label: 'Net worth', goodWhen: 'up', unit: '$' },
  'wealth:assets': { label: 'Assets', goodWhen: 'up', unit: '$' },
  'wealth:liabilities': { label: 'Liabilities', goodWhen: 'down', unit: '$' },
  'wealth:cash': { label: 'Cash', goodWhen: null, unit: '$' },
  'wealth:investments': { label: 'Investments', goodWhen: 'up', unit: '$' },
  'wealth:spending': { label: 'Spending', goodWhen: null, unit: '$' },
  'wealth:spending_discretionary': { label: 'Discretionary spending', goodWhen: null, unit: '$' },
  'wealth:income': { label: 'Income', goodWhen: 'up', unit: '$' },
  'wealth:net_cashflow': { label: 'Net cashflow', goodWhen: 'up', unit: '$' },
  'productivity:meetings': { label: 'Meetings', goodWhen: null, unit: 'count' },
  'productivity:calendar_events': { label: 'Calendar events', goodWhen: null, unit: 'count' },
  'environment:temperature': { label: 'Temperature', goodWhen: null, unit: '°F' },
  'environment:humidity': { label: 'Humidity', goodWhen: null, unit: '%' },
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

function unit(domain, metric) {
  return CATALOG[key(domain, metric)]?.unit ?? null;
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

module.exports = { CATALOG, key, label, goodWhen, unit, isTracked, aggFor, titleCase, wellbeingLevel };
