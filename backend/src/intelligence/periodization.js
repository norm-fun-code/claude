// Multi-day training periodization — looks AHEAD at the rest of the week's
// scheduled sessions (not just today's grade) so back-to-back hard days can be
// flagged before they stack, the way a real coach plans a week rather than
// reacting one day at a time.
//
// Deliberately narrow: the weekly split has a fixed hard/easy rhythm (this plan's
// Wed→Thu is always Intervals→Push), so "hard days are adjacent" is true most
// weeks and would become another stale, always-the-same-thing observation if
// surfaced unconditionally. It's only genuinely news when training load is
// ALSO already elevated that week — so this only fires when both conditions
// hold, keeping it sparse and meaningful instead of a standing weekly notice.
const HARD_RE = /push|pull|interval/i;

/**
 * Pure. upcoming: [{day, type}] for the next few days (NOT including today),
 * chronologically ordered. acwrBand: 'low' | 'optimal' | 'high' | null.
 * Returns a ready-to-use note string, or null when there's nothing worth saying.
 */
function computePeriodizationNote({ upcoming = [], acwrBand = null } = {}) {
  if (acwrBand !== 'high' || upcoming.length < 2) return null;
  for (let i = 0; i < upcoming.length - 1; i++) {
    const a = upcoming[i], b = upcoming[i + 1];
    if (HARD_RE.test(a.type) && HARD_RE.test(b.type)) {
      return `Training load is already elevated (ACWR band: high), and ${a.day} (${a.type}) and ${b.day} (${b.type}) land back to back — worth trimming intensity on the first one so the second doesn't compound the load.`;
    }
  }
  return null;
}

module.exports = { computePeriodizationNote };
