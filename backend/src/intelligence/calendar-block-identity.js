// Stable identity for a calendar/work-busy block — the mechanism that lets a
// classification correction ("that's a Sabbath block, not meetings") attach
// to the EXACT block it was about, durably, without depending on a title
// (work-busy blocks from Google's freebusy API carry none) or a clock range
// restated in the answer text (the user reclassifying a block rarely repeats
// its exact times back).
//
// Built from source + the block's DESCRIBED LOCAL DATE + its normalized
// start/end — never from title or prose overlap. A block at the identical
// clock time on a DIFFERENT date gets a DIFFERENT id by construction, which
// is what stops a classification from silently carrying over to "the same
// meeting next week" (see context-resolver.js's matchCalendarClassifications
// date-scoping).
'use strict';

const { toMinutesSinceMidnight } = require('../util/date');

/**
 * @param {object} opts
 * @param {string} opts.source - 'work_busy' | 'calendar' | any future source
 * @param {string} opts.date - the block's own local date, 'YYYY-MM-DD' (the
 *   day it was FETCHED for — see services/calendar.js — never re-derived
 *   from a clock string, which carries no date of its own).
 * @param {string} opts.start - a clock string ('9:00 AM') or ISO datetime —
 *   anything util/date's toMinutesSinceMidnight accepts.
 * @param {string} opts.end
 * @returns {string|null} a stable, readable identity string, or null when
 *   the inputs don't resolve to a real interval (never a placeholder id that
 *   could collide with a real one).
 */
function calendarBlockId({ source, date, start, end }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const startMin = toMinutesSinceMidnight(start);
  const endMin = toMinutesSinceMidnight(end);
  if (startMin == null || endMin == null) return null;
  const src = String(source || 'block').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'block';
  return `${src}_${date}_${String(startMin).padStart(4, '0')}-${String(endMin).padStart(4, '0')}`;
}

/** A block's duration in minutes from its clock start/end, or null when
 *  either doesn't resolve to a real interval. */
function blockDurationMinutes(b) {
  const s = toMinutesSinceMidnight(b?.start);
  const e = toMinutesSinceMidnight(b?.end);
  return (s == null || e == null || e <= s) ? null : e - s;
}

/** Deterministically decide which block(s) an identity-bearing calendar
 *  classification answer should bind to — the shared "never guess" rule
 *  behind both compileUserContext's question-time-provenance override
 *  (context-compiler.js) and the Chief Brief's openQuestion subject
 *  detector (open-question-subject.js).
 *
 *  - Zero blocks: nothing to bind.
 *  - Exactly one: bind to it directly, unambiguous.
 *  - More than one: bind ONLY if a single block clearly DOMINATES the
 *    combined duration (>= DOMINANCE_RATIO of the total) — e.g. one long
 *    titleless block plus a few-minute sliver. Otherwise this is genuinely
 *    ambiguous (several comparably-sized candidates); the caller must
 *    require a targeted clarification rather than guess which one the
 *    answer meant.
 *
 * @param {Array<{id:string,start?:string,end?:string}>} blocks - each MUST
 *   carry a resolvable `.id`; blocks without one are dropped first.
 * @returns {{blockIds: string[], ambiguous: boolean}} `blockIds` is a
 *   single-element array when unambiguous (or empty when nothing to bind);
 *   the FULL candidate list when `ambiguous` is true, for the caller to
 *   surface in a clarification prompt.
 */
const DOMINANCE_RATIO = 0.6;
function pickBlockBinding(blocks) {
  const withId = (blocks || []).filter((b) => b && b.id);
  if (!withId.length) return { blockIds: [], ambiguous: false };
  if (withId.length === 1) return { blockIds: [withId[0].id], ambiguous: false };

  const durations = withId.map((b) => ({ id: b.id, minutes: blockDurationMinutes(b) || 0 }));
  const total = durations.reduce((sum, d) => sum + d.minutes, 0);
  if (total > 0) {
    const dominant = durations.reduce((a, b) => (b.minutes > a.minutes ? b : a));
    if (dominant.minutes / total >= DOMINANCE_RATIO) {
      return { blockIds: [dominant.id], ambiguous: false };
    }
  }
  return { blockIds: durations.map((d) => d.id), ambiguous: true };
}

module.exports = { calendarBlockId, blockDurationMinutes, pickBlockBinding };
