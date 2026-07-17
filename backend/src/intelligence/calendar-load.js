// Canonical calendar-load projection — the ONE place "how packed is today"
// gets computed. Shared by pre-brief-signals.js's packed_calendar/tomorrow_
// long_block questions and briefing-ai.js's Chief Brief prompt, which
// previously each summed the same two raw arrays independently and could
// disagree — and both summed a personal event (e.g. a Sabbath block)
// mirrored onto the work calendar's free/busy feed as a SEPARATE meeting on
// top of the personal-calendar entry, reproducing "8.0h of meetings" for a
// day that was actually ~3h of real meetings plus a protected block.
//
// Rules (all deterministic, no LLM involved):
//  - Only WORK-BUSY intervals ever count as meeting load. Personal-calendar
//    events never contribute minutes, no matter what the caller does with
//    the returned annotations.
//  - Work-busy intervals are merged into their UNION before summing, so an
//    overlapping/double-booked block counts once, not twice.
//  - A work-busy interval that overlaps a NAMED personal-calendar event
//    (an observance, family time, an appointment — anything with a title
//    and a start/end time on the personal calendar) has that overlapping
//    portion subtracted from meeting load — the free/busy feed carries no
//    titles, so without this the SAME commitment mirrored onto both feeds
//    reads as two separate facts.
//  - A work-busy block spanning (approximately) the whole workday is
//    treated as OOO/protected time (PTO, holiday, travel day) — not
//    meeting load at all.
const { toMinutesSinceMidnight } = require('../util/date');

const WORKDAY_START_MIN = 9 * 60;
const WORKDAY_END_MIN = 18 * 60;
// A busy block covering (approximately) the entire workday reads as an
// out-of-office/all-day event mirrored onto the titleless free/busy feed,
// not a wall of back-to-back meetings — matches the existing allDayBlock
// heuristic in briefing-ai.js prior to this module's extraction.
const ALL_DAY_START_MIN = 8 * 60;
const ALL_DAY_END_MIN = 18 * 60;

function minutesToClock(min) {
  const h24 = Math.floor(min / 60);
  const mm = min % 60;
  const mer = h24 >= 12 ? 'PM' : 'AM';
  const h = h24 % 12 || 12;
  return `${h}:${String(mm).padStart(2, '0')} ${mer}`;
}

function toInterval(block, startKey, endKey) {
  const s = toMinutesSinceMidnight(block[startKey]);
  const e = toMinutesSinceMidnight(block[endKey]);
  if (s == null || e == null || e <= s) return null;
  return [s, e];
}

/** Merge overlapping/adjacent [start,end] minute intervals into their union. */
function mergeIntervals(intervals) {
  const sorted = intervals.map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

/** Subtract interval list `cuts` from interval list `base`; each base piece
 *  may split into 0-2 remaining pieces per overlapping cut. */
function subtractIntervals(base, cuts) {
  let pieces = base.map(([s, e]) => [s, e]);
  for (const [cutS, cutE] of cuts) {
    const next = [];
    for (const [s, e] of pieces) {
      if (cutE <= s || cutS >= e) { next.push([s, e]); continue; }
      if (cutS > s) next.push([s, cutS]);
      if (cutE < e) next.push([cutE, e]);
    }
    pieces = next;
  }
  return pieces;
}

const sumMinutes = (intervals) => intervals.reduce((acc, [s, e]) => acc + (e - s), 0);

/**
 * @param {Array<{start:string,end:string}>} workBusy - work-calendar free/busy blocks
 * @param {Array<{title:string,startTime:string,endTime:string,allDay:boolean}>} calendar - personal-calendar events
 * @param {{workBusy?: boolean, calendar?: boolean}} [sourcesAvailable] - did each
 *   source's fetch actually SUCCEED? Defaults to both true (an empty array
 *   from a caller that doesn't track availability is trusted as a genuinely
 *   empty calendar, matching every existing caller's prior behavior). Pass
 *   `false` explicitly when a fetch failed/threw — an empty array alone is
 *   indistinguishable from "genuinely no events", and treating a FAILED
 *   personal-calendar fetch as "no events" reproduces the exact
 *   mirrored-Sabbath double-counting bug this module exists to prevent
 *   (nothing left to net a mirrored work-busy block against).
 * @returns {{
 *   meetingMinutes: number|null, meetingHours: number|null, isAllDayBlocked: boolean,
 *   busyIntervals: number[][], openWindows: string[],
 *   overlapTitleFor: (block: {start:string,end:string}) => string|null,
 *   degraded: boolean, degradedReason: string|null,
 * }}
 *   `meetingMinutes`/`meetingHours` are `null` (never `0` — a false "zero
 *   meetings" claim is just as wrong as a false nonzero one) whenever
 *   `degraded` is true. Callers MUST check `degraded` and suppress any
 *   question or claim built from the numeric fields when it's true.
 */
function computeCalendarLoad({ workBusy = [], calendar = [], sourcesAvailable = {} } = {}) {
  const workBusyAvailable = sourcesAvailable.workBusy !== false;
  const calendarAvailable = sourcesAvailable.calendar !== false;

  const rawIntervals = workBusyAvailable
    ? workBusy.map((b) => toInterval(b, 'start', 'end')).filter(Boolean)
    : [];

  // isAllDayBlocked never depends on the personal calendar, so it's still
  // safe to report whenever workBusy itself is available — even if the
  // personal-calendar fetch failed.
  const isAllDayBlocked = workBusyAvailable && rawIntervals.some(
    ([s, e]) => s <= ALL_DAY_START_MIN && e >= ALL_DAY_END_MIN
  );

  const namedEvents = calendarAvailable
    ? calendar
        .filter((e) => !e.allDay && e.startTime && e.endTime)
        .map((e) => ({ title: e.title, interval: toInterval(e, 'startTime', 'endTime') }))
        .filter((e) => e.interval)
    : [];

  const overlapTitleFor = (block) => {
    if (!calendarAvailable) return null;
    const iv = toInterval(block, 'start', 'end');
    if (!iv) return null;
    const hit = namedEvents.find(
      (e) => Math.min(iv[1], e.interval[1]) - Math.max(iv[0], e.interval[0]) > 0
    );
    return hit ? hit.title : null;
  };

  // A required source failed — fail closed. Whichever side failed, ANY
  // numeric meeting-load figure computed from what's left risks presenting
  // a false claim (work-busy alone can't be deduped against a mirrored
  // personal event; a personal calendar alone has no busy blocks to sum in
  // the first place). Report degraded instead of guessing.
  if (!workBusyAvailable || !calendarAvailable) {
    return {
      meetingMinutes: null,
      meetingHours: null,
      isAllDayBlocked,
      busyIntervals: [],
      openWindows: [],
      overlapTitleFor,
      degraded: true,
      degradedReason: !workBusyAvailable ? 'workBusy_unavailable' : 'calendar_unavailable',
    };
  }

  if (isAllDayBlocked) {
    return {
      meetingMinutes: 0,
      meetingHours: 0,
      isAllDayBlocked: true,
      busyIntervals: [],
      openWindows: [],
      overlapTitleFor,
      degraded: false,
      degradedReason: null,
    };
  }

  const merged = mergeIntervals(rawIntervals);
  const personalIntervals = namedEvents.map((e) => e.interval);
  const net = subtractIntervals(merged, personalIntervals);
  const meetingMinutes = sumMinutes(net);

  // Open focus windows: gaps in the UNION of work-busy blocks during the
  // workday. Uses `merged` (not net-of-personal) because a Sabbath-mirrored
  // block still occupies the calendar slot — it's just not counted as
  // meeting LOAD — so it should still read as unavailable for focus work.
  const openWindows = [];
  let cursor = WORKDAY_START_MIN;
  for (const [s, e] of merged) {
    if (s > cursor + 29) openWindows.push(`${minutesToClock(cursor)}–${minutesToClock(s)}`);
    cursor = Math.max(cursor, e);
  }
  if (cursor < WORKDAY_END_MIN - 29) {
    openWindows.push(`${minutesToClock(cursor)}–${minutesToClock(WORKDAY_END_MIN)}`);
  }

  return {
    meetingMinutes,
    meetingHours: meetingMinutes / 60,
    isAllDayBlocked: false,
    busyIntervals: merged,
    openWindows,
    overlapTitleFor,
    degraded: false,
    degradedReason: null,
  };
}

module.exports = { computeCalendarLoad, minutesToClock };
