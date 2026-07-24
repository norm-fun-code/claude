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

module.exports = { calendarBlockId };
