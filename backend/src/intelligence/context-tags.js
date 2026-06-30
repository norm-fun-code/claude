// Nightly context tags — the Eight-Sleep-style "what was different about today"
// markers (Magnesium, Alcohol, Late meal, …). Stored as daily 0/1 metrics under
// the `context` domain and correlated against HRV / sleep / recovery (and, unlike
// Eight Sleep, against mood / focus too) by the same habit-split engine. This list
// is the single source of truth: the catalog registration, the API, and the
// mobile chip list all derive from it.
//
// goodWhen is left null everywhere — the DIRECTION of each tag's effect is
// discovered from your own data, not assumed (your alcohol effect may differ from
// the textbook one).
const CONTEXT_TAGS = [
  { key: 'magnesium',     label: 'Magnesium',      emoji: '💊' },
  { key: 'alcohol',       label: 'Alcohol',        emoji: '🍷' },
  { key: 'late_meal',     label: 'Late meal',      emoji: '🍽️' },
  { key: 'melatonin',     label: 'Melatonin',      emoji: '😴' },
  { key: 'late_workout',  label: 'Late workout',   emoji: '🏋️' },
  { key: 'stressful_day', label: 'Stressful day',  emoji: '😣' },
  { key: 'sauna',         label: 'Sauna / heat',   emoji: '🧖' },
  { key: 'cold_plunge',   label: 'Cold plunge',    emoji: '🧊' },
  { key: 'travel',        label: 'Travel',         emoji: '✈️' },
  { key: 'late_screens',  label: 'Late screens',   emoji: '📱' },
  { key: 'under_weather', label: 'Under the weather', emoji: '🤒' },
  { key: 'warm_room',     label: 'Warm room',      emoji: '🌡️' },
];

const TAG_KEYS = CONTEXT_TAGS.map((t) => t.key);
const TAG_LABEL = Object.fromEntries(CONTEXT_TAGS.map((t) => [t.key, t.label]));
const isTagKey = (k) => TAG_KEYS.includes(k);

module.exports = { CONTEXT_TAGS, TAG_KEYS, TAG_LABEL, isTagKey };
