// Re-anchor relative time words in a PRIOR-DAY user context note.
//
// Production bug ("context timing has been consistently off"): a note the user
// types into "Add context for next brief" is stored verbatim and surfaced to
// the NEXT day's Chief Brief with its original wording. A note written last
// night — "25 hour fast starting tonight" — was handed to the model the next
// morning as literally "...starting tonight", with only a bracketed entry
// date next to it, and the model faithfully echoed "starting tonight" even
// though, read today, the fast started LAST night. The old design left the
// model to do the date arithmetic ("this note was entered Jul 20, today is
// Jul 21, so its 'tonight' means last night") — which it does unreliably.
//
// This module removes that burden: it deterministically rewrites the present/
// future relative-time words in a note to the phrasing that is correct when
// READ TODAY, using the note's own entry date as the anchor. "tonight" in a
// note entered yesterday becomes "last night"; "tomorrow" becomes "today";
// "today" becomes "yesterday". A note entered TODAY (or in the future) is left
// completely untouched — its relative words are still correct. Pure; never
// throws; returns the input unchanged on any missing/invalid input so a caller
// can wrap a raw label without guarding.
'use strict';

const { localDateStr } = require('../util/date');

// Noon-UTC anchored so whole-day arithmetic never crosses a boundary from a
// DST shift — this is pure calendar-day math, DST-safe by construction (same
// approach as intelligence/nightly-context-history.js).
function weekdayOf(localDateString) {
  return new Date(`${localDateString}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}
function monthDayOf(localDateString) {
  return new Date(`${localDateString}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
/** Whole calendar days between two YYYY-MM-DD local-date strings (b - a). */
function dayDiff(aStr, bStr) {
  const a = new Date(`${aStr}T12:00:00Z`).getTime();
  const b = new Date(`${bStr}T12:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}
/** A YYYY-MM-DD local-date string shifted by `n` whole days. */
function shiftDay(localDateString, n) {
  const d = new Date(`${localDateString}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Express `targetLocal` (a YYYY-MM-DD) relative to `todayLocal` as a bare day
 *  phrase — "yesterday" / "today" / "tomorrow" / a weekday / a Mon-Day date. */
function dayPhrase(targetLocal, todayLocal) {
  const diff = dayDiff(targetLocal, todayLocal); // today - target
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff === -1) return 'tomorrow';
  if (Math.abs(diff) <= 6) return weekdayOf(targetLocal);
  return monthDayOf(targetLocal);
}

/** Express the NIGHT of `targetLocal` relative to `todayLocal`. */
function nightPhrase(targetLocal, todayLocal) {
  const diff = dayDiff(targetLocal, todayLocal);
  if (diff === 1) return 'last night';
  if (diff === 0) return 'tonight';
  if (diff === -1) return 'tomorrow night';
  if (Math.abs(diff) <= 6) return `${weekdayOf(targetLocal)} night`;
  return `the night of ${monthDayOf(targetLocal)}`;
}

/** Express a part-of-day of `fromLocal` relative to `todayLocal`
 *  ("yesterday morning", "Sunday evening", ...). Only called when the note is
 *  from a prior day (dayDiff >= 1). */
function partOfDayPhrase(fromLocal, todayLocal, part) {
  const diff = dayDiff(fromLocal, todayLocal);
  if (diff === 1) return `yesterday ${part}`;
  if (diff <= 6) return `${weekdayOf(fromLocal)} ${part}`;
  return `${monthDayOf(fromLocal)} ${part}`;
}

function resolveToken(token, fromLocal, todayLocal) {
  switch (token) {
    case 'this morning': return partOfDayPhrase(fromLocal, todayLocal, 'morning');
    case 'this afternoon': return partOfDayPhrase(fromLocal, todayLocal, 'afternoon');
    case 'this evening': return partOfDayPhrase(fromLocal, todayLocal, 'evening');
    case 'tonight': return nightPhrase(fromLocal, todayLocal);
    case 'tomorrow': return dayPhrase(shiftDay(fromLocal, 1), todayLocal);
    case 'yesterday': return dayPhrase(shiftDay(fromLocal, -1), todayLocal);
    case 'today': return dayPhrase(fromLocal, todayLocal);
    default: return token;
  }
}

// One combined alternation, matched in a SINGLE pass with a replacer callback —
// so a replacement that itself contains a relative word (e.g. "tomorrow" ->
// "today" when the note is one day old) is never re-scanned and re-replaced.
// Multi-word phrases come first so "this morning" wins over a bare "morning".
const TOKEN_RE = /\bthis morning\b|\bthis afternoon\b|\bthis evening\b|\btonight\b|\btomorrow\b|\byesterday\b|\btoday\b/gi;

/**
 * @param {string} text - the raw note/label to re-anchor.
 * @param {object} opts
 * @param {Date|string} opts.fromDate - when the note was ENTERED (its "now").
 * @param {Date|string} [opts.now] - the current moment the brief is being read.
 * @param {string} [opts.tz]
 * @returns {string} the note with its relative time words re-anchored to today,
 *   or the input unchanged if the note is from today/the future or inputs are
 *   missing/invalid.
 */
function reanchorRelativeTime(text, { fromDate, now = new Date(), tz = process.env.TZ || 'America/New_York' } = {}) {
  if (typeof text !== 'string' || !text || !fromDate) return text;
  const fromD = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const nowD = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(fromD.getTime()) || Number.isNaN(nowD.getTime())) return text;
  const fromLocal = localDateStr(tz, fromD);
  const todayLocal = localDateStr(tz, nowD);
  // Entered today or in the future → every relative word is still correct.
  if (dayDiff(fromLocal, todayLocal) <= 0) return text;
  return text.replace(TOKEN_RE, (m) => resolveToken(m.toLowerCase(), fromLocal, todayLocal));
}

module.exports = { reanchorRelativeTime };
