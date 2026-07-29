// Wealth matched-pace hardening pass — explicit source coverage-interval
// tracking. `earliestMonarchDocumentDate() <= monthStart` (the old
// eligibility heuristic) is NOT proof a historical month's matched window
// is actually fully covered — a failed backfill, a partial sync, or a
// gap between two disjoint CSV exports can leave the account's EARLIEST
// document long before a month that itself has no real coverage. This
// module tracks the actual date ranges a sync run attested it covered, so
// eligibility can require genuine full-window coverage instead of a single
// "is there anything at all before this point" proxy.
//
// Intervals are [from, to] inclusive local YYYY-MM-DD strings, persisted in
// sources.config.coverageIntervals (store/sources.js's existing per-source
// JSONB config column — no new table needed) under the 'monarch' source,
// shared by every Monarch-writing connector (CSV, MCP sync, GraphQL).
'use strict';

function nextDay(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Merge a list of (possibly overlapping/adjacent/unordered) intervals into
 *  the minimal sorted set of disjoint intervals. Adjacent intervals (one
 *  ending the day before the next starts) are merged too — a sync ending
 *  2026-07-10 followed by one starting 2026-07-11 leaves no real gap. */
function normalize(intervals) {
  const sorted = (intervals || [])
    .filter((iv) => iv && iv.from && iv.to && iv.from <= iv.to)
    .slice()
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.from <= nextDay(last.to)) {
      if (iv.to > last.to) last.to = iv.to;
    } else {
      merged.push({ from: iv.from, to: iv.to });
    }
  }
  return merged;
}

/** Add one newly-covered [from, to] interval to an existing set, returning
 *  the re-normalized (merged, disjoint, sorted) result. */
function addInterval(existing, from, to) {
  if (!from || !to || from > to) return normalize(existing || []);
  return normalize([...(existing || []), { from, to }]);
}

/** True iff [fromYmd, toYmd] is ENTIRELY contained within a single merged
 *  covered interval — a window straddling a real gap (even one covered by
 *  two separate intervals that don't touch) is NOT considered covered,
 *  because the gap itself proves the account's data has a hole somewhere
 *  inside the window being asked about. */
function isFullyCovered(intervals, fromYmd, toYmd) {
  const merged = normalize(intervals || []);
  return merged.some((iv) => iv.from <= fromYmd && iv.to >= toYmd);
}

module.exports = { normalize, addInterval, isFullyCovered, nextDay };
