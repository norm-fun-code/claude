// Pre-brief signal detection — finds genuine anomalies before the brief builds
// and returns questions for the mobile app to surface. Answers POST back as
// annotations, which flow into annotationsContext automatically next build.
//
// Each signal: { key, question, context, severity }
//   key      — stable ID for dedup / dismissal. For calendar-load signals
//              this is `calendar_load:<local-date>` — a DURABLE subject key
//              shared across whichever build asks about that date (see
//              calendarLoadAnswers below), not a per-call literal.
//   question — the string shown to the user
//   context  — label prefix used when the answer is stored as an annotation
//   severity — 0–1, higher floats to top in selectQuestions()

const { toMinutesSinceMidnight, localDateStr, addDays } = require('../util/date');
const { computeCalendarLoad } = require('./calendar-load');

const fmt = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US');

// How much a calendar-load fingerprint (meeting-hours, or 'allday') has to
// move before a previously-answered day's question is allowed to resurface —
// a genuinely rescheduled day, not the same schedule read a few minutes
// apart by two different signals (today's packed-calendar vs yesterday's
// tomorrow-look-ahead computing the same underlying day).
const CALENDAR_LOAD_CHANGE_THRESHOLD_HOURS = 1;

function calendarLoadFingerprint(load) {
  return load.isAllDayBlocked ? 'allday' : load.meetingHours.toFixed(2);
}

/** True if `load`'s current fingerprint differs materially from the one
 *  stored when the day's question was last answered. */
function calendarLoadMateriallyChanged(storedFingerprint, load) {
  if (storedFingerprint == null) return true;
  const current = calendarLoadFingerprint(load);
  if (storedFingerprint === 'allday' || current === 'allday') return storedFingerprint !== current;
  return Math.abs(Number(storedFingerprint) - Number(current)) >= CALENDAR_LOAD_CHANGE_THRESHOLD_HOURS;
}

function buildSignals({
  recovery, calendar = [], workBusy = [], spend, spendBaseline, tomorrowWorkBusy = [], tomorrowCalendar = [],
  tz = process.env.TZ || 'America/New_York', now = new Date(),
  // Map<localDate, {fingerprint, answer}> from store/signalAnswers.js's
  // answersFor('calendar_load', ...) — the server-side authority for
  // whether a calendar_load question for a given date has already been
  // answered. Callers that don't pass this (e.g. unit tests exercising
  // other signals) get no suppression, matching the old unconditional
  // behavior.
  calendarLoadAnswers = new Map(),
  // Did each calendar source's fetch actually SUCCEED (not just come back
  // empty)? Defaults to true for every existing caller that doesn't track
  // this — see calendar-load.js's computeCalendarLoad for why an omitted
  // fetch failure must never silently read as "genuinely no events."
  workBusyAvailable = true, calendarAvailable = true,
  tomorrowWorkBusyAvailable = true, tomorrowCalendarAvailable = true,
} = {}) {
  const signals = [];
  const todayKey = localDateStr(tz, now);
  const tomorrowKey = localDateStr(tz, addDays(now, 1));

  // A long / all-day block on TOMORROW's work calendar (an OOO, a travel day, a
  // wall of meetings) — ask the day PRIOR so the user can add context that flows
  // into tomorrow's brief instead of it guessing from a titleless busy block.
  // Uses the SAME canonical projection (and the SAME durable subject key,
  // calendar_load:<the date being described>) as the packed-calendar signal
  // below — this is literally the same underlying day's schedule read from
  // one day earlier, so an answer to either suppresses both. Passing
  // tomorrowCalendar (not calendar: []) is required, not cosmetic — without
  // it there is nothing for a work-busy block that mirrors a NAMED personal
  // event (e.g. a Sabbath block also mirrored onto the work free/busy feed)
  // to net against, reproducing the exact double-counting bug one day early.
  {
    const tomorrowLoad = computeCalendarLoad({
      workBusy: tomorrowWorkBusy, calendar: tomorrowCalendar,
      sourcesAvailable: { workBusy: tomorrowWorkBusyAvailable, calendar: tomorrowCalendarAvailable },
    });
    if (tomorrowLoad.degraded) {
      // A source needed to rule out double-counting is unavailable — never
      // ask a question built from a meeting-load number that might be
      // wrong. Suppress and log degraded provenance instead of guessing.
      console.error(`[pre-brief-signals] tomorrow calendar_load degraded (${tomorrowLoad.degradedReason}) — suppressing the look-ahead question`);
    } else {
      const stored = calendarLoadAnswers.get(tomorrowKey);
      const suppressed = stored && !calendarLoadMateriallyChanged(stored.fingerprint, tomorrowLoad);
      if (!suppressed && (tomorrowLoad.isAllDayBlocked || tomorrowLoad.meetingHours >= 6)) {
        signals.push({
          key: `calendar_load:${tomorrowKey}`,
          // Echoed back by the client on answer so the server can record
          // "what the schedule looked like when this was answered" without
          // re-fetching calendar data inside the annotation route.
          fingerprint: calendarLoadFingerprint(tomorrowLoad),
          question: tomorrowLoad.isAllDayBlocked
            ? "There's an all-day block on your work calendar tomorrow — what's going on? (OOO, travel, an offsite?)"
            : `Tomorrow's work calendar is heavily blocked (${tomorrowLoad.meetingHours.toFixed(1)}h) — anything specific driving it?`,
          context: 'calendar note',
          severity: 0.72,
        });
      }
    }
  }

  // Recovery outlier — score < 50 (red / lower-yellow band)
  if (recovery?.score != null && recovery.score < 50) {
    const severity = 0.9 - (recovery.score / 100) * 0.4; // lower = more severe
    signals.push({
      key: 'recovery_low',
      question: `Your recovery score is ${recovery.score} today — what do you think is really driving it?`,
      context: 'recovery note',
      severity,
    });
  }

  // Packed calendar — canonical union-of-work-busy meeting load for TODAY,
  // net of any overlap with named personal-calendar events (so a Sabbath
  // block mirrored onto the work free/busy feed is never double-counted) and
  // never counting personal-calendar time as meetings. Same durable subject
  // key as the tomorrow-look-ahead signal above.
  if (workBusy.length > 0 || calendar.length > 0 || !workBusyAvailable || !calendarAvailable) {
    const todayLoad = computeCalendarLoad({
      workBusy, calendar,
      sourcesAvailable: { workBusy: workBusyAvailable, calendar: calendarAvailable },
    });
    if (todayLoad.degraded) {
      console.error(`[pre-brief-signals] today calendar_load degraded (${todayLoad.degradedReason}) — suppressing the packed-calendar question`);
    } else {
      const stored = calendarLoadAnswers.get(todayKey);
      const suppressed = stored && !calendarLoadMateriallyChanged(stored.fingerprint, todayLoad);
      if (!suppressed && !todayLoad.isAllDayBlocked && todayLoad.meetingHours >= 4) {
        signals.push({
          key: `calendar_load:${todayKey}`,
          fingerprint: calendarLoadFingerprint(todayLoad),
          question: `You have ${todayLoad.meetingHours.toFixed(1)}h of meetings today — anything specific driving that, or just a heavy week?`,
          context: 'calendar note',
          severity: Math.min(0.75, 0.4 + (todayLoad.meetingHours - 4) * 0.06),
        });
      }
    }
  }

  // Discretionary spending spike — today > 1.8× daily baseline.
  // Uses spending_discretionary (rent/fixed excluded) so a 1st-of-month rent
  // payment never triggers a question about something completely expected.
  if (spend != null && spendBaseline != null && spendBaseline > 10 && spend > spendBaseline * 1.8) {
    signals.push({
      key: 'spending_spike',
      question: `You spent ${fmt(spend)} in discretionary yesterday (avg is ${fmt(spendBaseline)}/day) — anything to explain that?`,
      context: 'spending note',
      severity: Math.min(0.8, 0.5 + (spend / spendBaseline - 1.8) * 0.08),
    });
  }

  return signals;
}

/** Pick the top `max` signals by severity. */
function selectQuestions(signals, max = 2) {
  return [...signals].sort((a, b) => b.severity - a.severity).slice(0, max);
}

module.exports = { buildSignals, selectQuestions };
