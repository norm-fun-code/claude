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
  'wellbeing:mood': { label: 'Mood', goodWhen: 'up' },
  'wellbeing:energy': { label: 'Energy', goodWhen: 'up' },
  'wellbeing:focus': { label: 'Focus', goodWhen: 'up' },
  'habits:morning_tm': { label: 'Morning TM', goodWhen: 'up' },
  'habits:afternoon_tm': { label: 'Afternoon TM', goodWhen: 'up' },
  'habits:gratitude': { label: 'Gratitude journal', goodWhen: 'up' },
  'habits:cold_shower': { label: 'Cold shower', goodWhen: 'up' },
  'habits:exercise': { label: 'Exercise (habit)', goodWhen: 'up' },
  'habits:eat_healthy': { label: 'Eating healthy', goodWhen: 'up' },
  'habits:habit_score': { label: 'Habit completion', goodWhen: 'up' },
  'wealth:net_worth': { label: 'Net worth', goodWhen: 'up' },
  'wealth:assets': { label: 'Assets', goodWhen: 'up' },
  'wealth:liabilities': { label: 'Liabilities', goodWhen: 'down' },
  'wealth:cash': { label: 'Cash', goodWhen: null },
  'wealth:investments': { label: 'Investments', goodWhen: 'up' },
  'wealth:spending': { label: 'Spending', goodWhen: null },
  'wealth:income': { label: 'Income', goodWhen: 'up' },
  'wealth:net_cashflow': { label: 'Net cashflow', goodWhen: 'up' },
  'productivity:meetings': { label: 'Meetings', goodWhen: null },
  'productivity:calendar_events': { label: 'Calendar events', goodWhen: null },
  'learning:highlights_synced': { label: 'Highlights captured', goodWhen: 'up' },
  'learning:books_synced': { label: 'Books active', goodWhen: 'up' },
  'learning:notion_pages': { label: 'Notion pages', goodWhen: null },
  'environment:temperature': { label: 'Temperature', goodWhen: null },
  'environment:humidity': { label: 'Humidity', goodWhen: null },
  'environment:uv_index': { label: 'UV index', goodWhen: null },
};

// Flow/count metrics are summed per day; everything else is averaged.
const SUM_METRICS = new Set([
  'steps',
  'active_energy',
  'exercise_minutes',
  'mindful_minutes',
  'meetings',
  'calendar_events',
  'highlights_synced',
  'books_synced',
  'notion_pages',
  'notion_pages_synced',
  'spending',
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

function aggFor(metric) {
  return SUM_METRICS.has(metric) ? 'sum' : 'avg';
}

module.exports = { CATALOG, key, label, goodWhen, aggFor, titleCase };
