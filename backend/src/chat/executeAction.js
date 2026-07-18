// Execute a validated app action the Ask brain chose to take (parsed + strictly
// validated in src/chat/ask.js's parseAction, so `routed` is already a known,
// enum-checked shape). Shared by the /api/chat and /api/voice/ask routes.
// Returns { done, description } or null.
const db = require('../db');
const sourcesStore = require('../store/sources');
const metricsStore = require('../store/metrics');
const { mapCheckin, SOURCE: CHECKIN_SOURCE } = require('../ingest/checkin');
const { mapHabits, SOURCE: HABITS_SOURCE } = require('../ingest/habits');
const annotationsStore = require('../store/annotations');
const gratitudeLogsStore = require('../store/gratitudeLogs');
const lifeChaptersStore = require('../store/lifeChapters');
const commitmentsStore = require('../store/commitments');
const dayJournalStore = require('../store/dayJournal');
const { recomputeHabitScore } = require('../intelligence/habit-score');
const { recordUserContext } = require('../intelligence/context-input');
const { VALID_WORKOUT_IDS, setWorkoutOverride } = require('../services/workout');

async function executeAction(routed) {
  const tz = process.env.TZ || 'America/New_York';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  try {
    if (routed.action === 'swap_workout' && VALID_WORKOUT_IDS.has(routed.workoutId)) {
      // Transactional Brain Invalidation (audit recommendation #2), item 4:
      // this used to write workout_overrides directly with NO invalidation
      // at all — a voice/Ask-driven swap left the forecast/brief/surfaces
      // silently stale (the REST route had its own, different, correct
      // invalidation path). Now routes through the SAME shared helper the
      // REST route and the rest-day-commitment helper use, so every
      // workout-override write emits the exact same invalidation.
      await setWorkoutOverride({ date: today, workoutId: routed.workoutId });
      return { done: true, description: `Swapped today's workout to ${routed.workoutId}` };
    }
    if (routed.action === 'log_habit' && ['morningTM', 'afternoonTM', 'gratitude', 'coldShower', 'exercise'].includes(routed.habit)) {
      await sourcesStore.registerSource({ id: HABITS_SOURCE, domain: 'habits', displayName: 'Habit Stack' });
      const { metrics } = mapHabits({ [routed.habit]: true }, { tz });
      await metricsStore.insertMetrics(metrics);
      await recomputeHabitScore(tz);
      await sourcesStore.markSync(HABITS_SOURCE);
      return { done: true, description: `Logged ${routed.habit} as done` };
    }
    if (routed.action === 'log_activity' && routed.activityType) {
      // Same write the manual "Log a different activity" button makes
      // (POST /api/activity), so a voice-logged activity shows up in "What I
      // actually did" identically to a manually-logged one.
      const plannedType = (() => {
        try { return require('../services/workout').getTodayWorkout()?.type ?? null; } catch { return null; }
      })();
      await db.query(
        `INSERT INTO activity_logs (log_date, activity_type, label, duration_min, note, planned_type, no_watch)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [today, routed.activityType, routed.label, routed.durationMin, null, plannedType, routed.noWatch]
      );
      await require('../intelligence/activity-sync').syncActivityMinutes(today);
      // Mirrors mobile's addActivity(): logging a non-rest activity for today
      // also marks the Exercise habit, so streaks/insights stay in sync.
      if (routed.activityType !== 'rest') {
        await sourcesStore.registerSource({ id: HABITS_SOURCE, domain: 'habits', displayName: 'Habit Stack' });
        const { metrics } = mapHabits({ exercise: true }, { tz });
        await metricsStore.insertMetrics(metrics);
        await recomputeHabitScore(tz);
        await sourcesStore.markSync(HABITS_SOURCE);
      }
      const durationStr = routed.durationMin ? `${routed.durationMin} min ` : '';
      return { done: true, description: `Logged ${durationStr}${routed.label || routed.activityType}` };
    }
    if (routed.action === 'log_checkin' && (routed.mood != null || routed.energy != null || routed.focus != null)) {
      await sourcesStore.registerSource({ id: CHECKIN_SOURCE, domain: 'wellbeing', displayName: 'Daily Check-in' });
      const body = {};
      if (routed.mood != null) body.mood = routed.mood;
      if (routed.energy != null) body.energy = routed.energy;
      if (routed.focus != null) body.focus = routed.focus;
      const { metrics } = mapCheckin(body, { tz });
      await metricsStore.insertMetrics(metrics);
      await sourcesStore.markSync(CHECKIN_SOURCE);
      const parts = [];
      if (routed.mood != null) parts.push(`mood ${routed.mood}`);
      if (routed.energy != null) parts.push(`energy ${routed.energy}`);
      if (routed.focus != null) parts.push(`focus ${routed.focus}`);
      return { done: true, description: `Logged your check-in: ${parts.join(', ')}` };
    }
    if (routed.action === 'log_weight' && routed.weightLb != null) {
      const WEIGHT_SOURCE = 'weight_log';
      await sourcesStore.registerSource({ id: WEIGHT_SOURCE, domain: 'health', displayName: 'Weight Log' });
      await metricsStore.insertMetrics([
        { ts: new Date(), domain: 'health', metric: 'weight', value: routed.weightLb, unit: 'lbs', source: WEIGHT_SOURCE },
      ]);
      await sourcesStore.markSync(WEIGHT_SOURCE);
      return { done: true, description: `Logged your weight: ${routed.weightLb} lbs` };
    }
    if (routed.action === 'log_gratitude_text' && routed.text) {
      // Same write the manual gratitude-journal box makes (POST
      // /api/habits/gratitude): save the reflection AND mark the habit done, so
      // a voice-logged entry is indistinguishable from a manually-logged one.
      await gratitudeLogsStore.upsert({ logDate: today, text: routed.text });
      await sourcesStore.registerSource({ id: HABITS_SOURCE, domain: 'habits', displayName: 'Habit Stack' });
      const { metrics } = mapHabits({ gratitude: true }, { tz });
      await metricsStore.insertMetrics(metrics);
      await recomputeHabitScore(tz);
      await sourcesStore.markSync(HABITS_SOURCE);
      return { done: true, description: 'Logged your gratitude reflection for today.' };
    }
    if (routed.action === 'add_chapter' && routed.label) {
      const { replaced } = await lifeChaptersStore.createOrReplace({
        kind: ['pregnancy', 'countdown', 'note'].includes(routed.kind) ? routed.kind : 'note',
        label: String(routed.label).slice(0, 120),
        keyDate: routed.keyDate || null,
        keyDateLabel: routed.keyDateLabel || null,
      });
      return {
        done: true,
        description: replaced
          ? `Updated the standing life chapter: ${routed.label}${routed.keyDate ? ` (${routed.keyDateLabel || 'date'}: ${routed.keyDate})` : ''}`
          : `Remembered as a standing life chapter: ${routed.label}`,
      };
    }
    if (routed.action === 'add_context' && routed.text) {
      const text = String(routed.text);
      // Context Understanding Layer: compile through the SAME shared
      // pipeline routes/annotations.js's POST /briefing/context uses (see
      // intelligence/context-input.js) — this is what makes an Ask
      // statement or a realtime voice statement (realtimeTools.js's
      // executeNormosAction/deepAsk both call this same executeAction())
      // reach ResolvedContext, not just the raw annotations table.
      await recordUserContext({
        rawText: text, source: 'ask_add_context', tz,
        writeInTransaction: (client, db) => annotationsStore.createAnnotation({
          category: 'brief_context',
          label: text.slice(0, 200),
          startTs: new Date(),
          endTs: new Date(Date.now() + 24 * 3600 * 1000),
        }, db),
        getSourceAnnotationId: (written) => written?.id ?? null,
      });
      return { done: true, description: `Noted for the next brief: ${routed.text}` };
    }
    if (routed.action === 'log_day_context' && routed.text) {
      const text = String(routed.text);
      const entryDate = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD local
      await recordUserContext({
        rawText: text, source: 'voice_day_context', tz,
        writeInTransaction: (client, db) => dayJournalStore.create({ text: text.slice(0, 4000), entryDate, source: 'voice' }, db),
      });
      return { done: true, description: 'Logged today\'s context — I\'ll factor it into your briefs and remember it.' };
    }
    if (routed.action === 'set_reminder' && routed.text) {
      const { dueAt } = commitmentsStore.resolveReminderTime(routed.at, new Date());
      await commitmentsStore.create({ title: String(routed.text).slice(0, 200), source: 'voice', dueAt });
      // Same process runs the scheduler, so arm a precise timer for near-term
      // reminders — they land on the minute instead of waiting for the poll.
      if (dueAt) require('../notify/commitments').armPreciseReminder(dueAt);
      const when = dueAt
        ? ` for ${dueAt.toLocaleString('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
        : '';
      return { done: true, description: `Reminder set${when}: ${routed.text}` };
    }
  } catch (err) {
    console.error('[voice action] failed:', err.message);
    return { done: false, description: `Tried to ${routed.action} but it failed` };
  }
  return null;
}

module.exports = { executeAction };
