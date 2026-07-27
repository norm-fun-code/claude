// Per-action consent policy for Ask/voice mutations: which validated actions
// (chat/ask.js's validateAction output — {action, ...fields}) may execute
// immediately on the strength of the user's own single-utterance statement,
// and which are significant/cross-surface-visible enough to require an
// explicit confirm step first (POST /api/chat/confirm-action). This is the
// ONE place that decision is made — routes/chat.js and routes/voice.js both
// consult it instead of each re-deciding, so the rule can never drift
// between the typed and voice-dictation surfaces.
'use strict';

// Reversible, low-blast-radius, easily corrected — the user's own clear,
// fully-specified single-utterance statement ("log my cold shower", "my
// energy is a 3 today") is already unambiguous consent for these; a second
// confirm tap would add friction with no real safety benefit, since a
// mistake here is simply re-logged or edited later. This preserves the
// existing "chief of staff who does things" behavior for everyday logging.
const IMMEDIATE_ACTIONS = new Set([
  'log_habit', 'log_activity', 'log_checkin', 'log_weight',
  'log_gratitude_text', 'add_context', 'log_day_context', 'set_reminder',
]);

// Meaningful, cross-surface-visible mutations: a workout swap changes what
// Today/Health show as today's plan for the rest of the day, and a life
// chapter is a standing long-term fact. These get an explicit preview +
// confirmation step before touching real state (see routes/chat.js's
// POST /api/chat/confirm-action), per the Ask contract's Act-flow
// requirement — "require confirmation for meaningful mutations unless an
// existing per-action consent rule explicitly allows immediate execution."
const CONFIRM_REQUIRED_ACTIONS = new Set(['swap_workout', 'add_chapter']);

function needsConfirmation(action) {
  return !!action && CONFIRM_REQUIRED_ACTIONS.has(action.action);
}

const WORKOUT_LABELS = {
  push: 'Push', pull: 'Pull', zone2: 'Zone 2', mobility: 'Mobility', intervals: 'Intervals', rest: 'Rest day',
};

/** Human-readable {title, preview} for a validated action — shown as the
 *  acknowledgment for an immediately-executed action, or as the confirm
 *  card's content for a deferred one. Pure (no DB access), so it's usable
 *  both server-side and unit-testable without a database. */
function describeAction(action) {
  if (!action || !action.action) return { title: 'Action', preview: '' };
  switch (action.action) {
    case 'swap_workout': {
      const label = WORKOUT_LABELS[action.workoutId] || action.workoutId;
      return { title: `Swap today's workout to ${label}`, preview: `Today's plan will change to ${label} across Today and Health.` };
    }
    case 'add_chapter':
      return {
        title: `Remember: ${action.label}`,
        preview: `Adds a standing life chapter${action.keyDate ? ` (${action.keyDateLabel || 'date'}: ${action.keyDate})` : ''}.`,
      };
    case 'log_habit':
      return { title: `Log ${action.habit} as done`, preview: `Marks today's ${action.habit} habit complete.` };
    case 'log_activity':
      return {
        title: `Log ${action.label || action.activityType}`,
        preview: `Adds ${action.durationMin ? `${action.durationMin} min ` : ''}${action.activityType} to today's activity log.`,
      };
    case 'log_checkin': {
      const parts = [];
      if (action.mood != null) parts.push(`mood ${action.mood}`);
      if (action.energy != null) parts.push(`energy ${action.energy}`);
      if (action.focus != null) parts.push(`focus ${action.focus}`);
      return { title: 'Log check-in', preview: parts.join(', ') };
    }
    case 'log_weight':
      return { title: `Log weight: ${action.weightLb} lbs`, preview: 'Adds a weight entry for today.' };
    case 'log_gratitude_text':
      return { title: 'Log gratitude', preview: action.text || '' };
    case 'add_context':
      return { title: 'Note for the next brief', preview: action.text || '' };
    case 'log_day_context':
      return { title: "Log today's context", preview: (action.text || '').length > 140 ? `${action.text.slice(0, 140)}…` : (action.text || '') };
    case 'set_reminder':
      return { title: 'Set reminder', preview: action.text || '' };
    default:
      return { title: action.action, preview: '' };
  }
}

// Every action type in this file writes to internal, user-owned data with a
// real edit/undo path elsewhere in the app (re-log, re-swap, delete the
// commitment/chapter) — none reaches an external system. "reversible" here
// means "a genuine corrective path exists," not "there is a one-tap undo
// button for this exact turn."
function reversibilityOf(action) {
  return action && action.action ? 'reversible' : 'unknown';
}

module.exports = {
  IMMEDIATE_ACTIONS,
  CONFIRM_REQUIRED_ACTIONS,
  needsConfirmation,
  describeAction,
  reversibilityOf,
};
