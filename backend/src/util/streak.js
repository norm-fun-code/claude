// Pure consecutive-day streak counter for the habit dots/badges. Extracted from
// the /api/habits/streaks handler so the day-walk logic is unit-testable (it
// had two bugs: a Date-vs-string key mismatch, and a walk-back that round-tripped
// through local time and could drift across months/DST).

const pad = (n) => String(n).padStart(2, '0');

/** The day before a 'YYYY-MM-DD' string, as 'YYYY-MM-DD' (UTC math, DST-safe). */
function prevDay(dayStr) {
  const d = new Date(`${dayStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * @param {{day:string,val:number}[]} dayRowsDesc  rows for ONE habit, newest
 *   first, `day` as 'YYYY-MM-DD', `val` the day's average (>=0.5 = done).
 * @param {{today:string, yesterday:string}} anchor  'YYYY-MM-DD' today/yesterday.
 * @returns {number} consecutive done-days ending today or yesterday (0 if the
 *   streak isn't currently live).
 */
function computeStreak(dayRowsDesc, { today, yesterday }) {
  if (!dayRowsDesc || dayRowsDesc.length === 0) return 0;
  const mostRecent = dayRowsDesc[0].day;
  // A streak only counts if it reaches up to today (or yesterday — you may not
  // have logged yet today).
  if (mostRecent !== today && mostRecent !== yesterday) return 0;
  let streak = 0;
  let expected = mostRecent;
  for (const { day, val } of dayRowsDesc) {
    if (day !== expected || Number(val) < 0.5) break;
    streak++;
    expected = prevDay(expected);
  }
  return streak;
}

module.exports = { computeStreak, prevDay };
