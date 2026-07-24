// Deterministic (no LLM) detection of whether a freshly-generated Chief
// Brief openQuestion is ABOUT the canonical calendar-load projection — and
// if so, which exact work-busy block(s) it's asking about. This is the
// missing half of the calendar-load question-provenance contract already
// built for the pre-brief-signal path (pre-brief-signals.js's
// blockRefsFor): that path only covers signals it generates itself
// deterministically ("You have X.Xh of meetings today..."); the Chief
// Brief's own LLM-authored openQuestion can ask about the identical figure
// in its own words, with no structural link back to the computation that
// produced it — see open-question-policy.js's bindOpenQuestionInstance,
// which calls this right after generation, BEFORE the question is ever
// shown to the user.
//
// Deliberately regex/arithmetic only: the question text is matched against
// the SAME canonical meetingHours figure computeCalendarLoad already
// produced for today/tomorrow (the actual numbers the model was fed or
// could plausibly have summed itself) — never a second LLM call, never a
// guess from prose alone.
'use strict';

const { pickBlockBinding } = require('./calendar-block-identity');

const MEETING_KEYWORD_RE = /\b(meeting|meetings|busy|blocked|booked|packed)\b/i;
const MEETING_HOURS_RE = /(\d+(?:\.\d+)?)\s*[- ]?(hours?|hrs?|h)\b/i;
// How far the question's stated figure may drift from the canonical
// meetingHours it's presumably citing/summing (LLM rounding: "9 hours" for
// a computed 9.2) before we stop trusting the match.
const HOUR_TOLERANCE = 0.5;

/** Work-busy blocks that actually CONTRIBUTE to `load`'s meetingHours — i.e.
 *  not already netted against a named personal-calendar/classified event.
 *  Mirrors briefing-ai.js's own overlapLabel check. */
function contributingWorkBusyBlocks(load, workBusy) {
  if (!load || typeof load.overlapTitleFor !== 'function') return [];
  return (workBusy || []).filter((b) => b && b.id && !load.overlapTitleFor(b));
}

function usableLoad(load) {
  return load && !load.degraded && Number.isFinite(load.meetingHours);
}

/**
 * @param {string} questionText - the Chief Brief's freshly-generated openQuestion.
 * @param {object} ctx
 * @param {object} [ctx.todayLoad] - computeCalendarLoad(...) output for today.
 * @param {object} [ctx.tomorrowLoad] - computeCalendarLoad(...) output for tomorrow.
 * @param {string} [ctx.todayKey] - today's local date, 'YYYY-MM-DD'.
 * @param {string} [ctx.tomorrowKey] - tomorrow's local date, 'YYYY-MM-DD'.
 * @param {Array} [ctx.todayWorkBusy] - the raw work-busy blocks todayLoad was computed from.
 * @param {Array} [ctx.tomorrowWorkBusy] - same, for tomorrow.
 * @returns {null|{subjectType:'calendar_load', subjectLocalDate:string, blockIds:string[], ambiguous:boolean}}
 *   null when the question isn't (confidently) about calendar load at all —
 *   the safe default; the question then just behaves as a plain,
 *   non-subject-bound openQuestion, exactly like before this fix.
 */
function detectCalendarLoadSubject(questionText, {
  todayLoad = null, tomorrowLoad = null, todayKey = null, tomorrowKey = null,
  todayWorkBusy = [], tomorrowWorkBusy = [],
} = {}) {
  const text = String(questionText || '');
  if (!MEETING_KEYWORD_RE.test(text)) return null;
  const m = MEETING_HOURS_RE.exec(text);
  if (!m) return null;
  const extractedHours = Number(m[1]);
  if (!Number.isFinite(extractedHours)) return null;

  const matchesToday = usableLoad(todayLoad) && Math.abs(todayLoad.meetingHours - extractedHours) <= HOUR_TOLERANCE;
  const matchesTomorrow = usableLoad(tomorrowLoad) && Math.abs(tomorrowLoad.meetingHours - extractedHours) <= HOUR_TOLERANCE;

  let target = null;
  if (matchesToday && matchesTomorrow) {
    // Both days happen to be within tolerance of the stated figure — only
    // trust an explicit "today"/"tomorrow" in the question's own wording to
    // break the tie; otherwise this is genuinely ambiguous WHICH DAY, and
    // guessing the wrong one would misclassify a block on the wrong date.
    if (/\btomorrow\b/i.test(text)) target = 'tomorrow';
    else if (/\btoday\b/i.test(text)) target = 'today';
    else return null;
  } else if (matchesToday) {
    target = 'today';
  } else if (matchesTomorrow) {
    target = 'tomorrow';
  } else {
    return null;
  }

  const load = target === 'today' ? todayLoad : tomorrowLoad;
  const workBusy = target === 'today' ? todayWorkBusy : tomorrowWorkBusy;
  const subjectLocalDate = target === 'today' ? todayKey : tomorrowKey;
  if (!subjectLocalDate) return null;

  const candidates = contributingWorkBusyBlocks(load, workBusy);
  const { blockIds, ambiguous } = pickBlockBinding(candidates);
  if (!blockIds.length) return null; // nothing resolvable to bind — not identity-bearing after all

  return { subjectType: 'calendar_load', subjectLocalDate, blockIds, ambiguous };
}

module.exports = { detectCalendarLoadSubject, contributingWorkBusyBlocks };
