// Is today a day off? Weekend + US federal holiday awareness so the brief stops
// framing a holiday/weekend as a packed workday with "meeting load" risk. Pure
// and tested — holiday/observed-date math is error-prone.

const pad = (n) => String(n).padStart(2, '0');

// nth weekday of a month, e.g. nthWeekday(2026, 11, 4, 4) = 4th Thursday of Nov.
// month is 1-12, weekday is 0=Sun..6=Sat.
function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (weekday - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}
function lastWeekday(year, month, weekday) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, daysInMonth)).getUTCDay();
  return daysInMonth - ((last - weekday + 7) % 7);
}

// Fixed-date federal holidays observe on the nearest weekday: Sat → Fri, Sun → Mon.
function observedShift(year, month, day) {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (dow === 6) return day - 1; // Saturday → observed Friday
  if (dow === 0) return day + 1; // Sunday → observed Monday
  return day;
}

/**
 * Federal-holiday name if (year, month 1-12, day) IS the OBSERVED holiday date,
 * else null. Covers the fixed-date holidays' observed shifts and the floating
 * Monday/Thursday ones.
 */
function usHolidayName(year, month, day) {
  const fixed = [
    [1, 1, "New Year's Day"],
    [6, 19, 'Juneteenth'],
    [7, 4, 'Independence Day'],
    [11, 11, 'Veterans Day'],
    [12, 25, 'Christmas Day'],
  ];
  for (const [m, d, name] of fixed) {
    if (month === m && day === observedShift(year, m, d)) return name;
  }
  const floating = [
    [1, nthWeekday(year, 1, 1, 3), 'MLK Day'],
    [2, nthWeekday(year, 2, 1, 3), "Presidents' Day"],
    [5, lastWeekday(year, 5, 1), 'Memorial Day'],
    [9, nthWeekday(year, 9, 1, 1), 'Labor Day'],
    [10, nthWeekday(year, 10, 1, 2), 'Columbus Day'],
    [11, nthWeekday(year, 11, 4, 4), 'Thanksgiving'],
  ];
  for (const [m, d, name] of floating) {
    if (month === m && day === d) return name;
  }
  return null;
}

/**
 * Pure. Given today's YYYY-MM-DD, returns a short "day off" context string for
 * the brief, or '' for a normal working weekday. Also flags the day *before* a
 * holiday so the brief can factor in a long weekend starting.
 */
function describeDayOff(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow];
  const holiday = usHolidayName(year, month, day);

  if (holiday) {
    const long = dow === 5 || dow === 1 ? ' — a long holiday weekend' : '';
    return `Today is ${dayName}, ${holiday} (a US federal holiday, observed today)${long}. This is a DAY OFF, not a workday — do not frame meeting load, a busy calendar, or work focus as a risk today; it's rest, family, and presence time.`;
  }
  if (dow === 0 || dow === 6) {
    return `Today is ${dayName} — the weekend. Not a workday; don't frame meeting load or a busy calendar as a risk.`;
  }
  // Weekday before a holiday → heads-up that a long weekend is starting.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const nextHoliday = usHolidayName(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  if (nextHoliday) return `Tomorrow is ${nextHoliday} (a US federal holiday) — a long weekend starts after today.`;
  return '';
}

/**
 * Pure. True if the given YYYY-MM-DD is a non-workday (weekend or an observed
 * US federal holiday), plus the holiday name if any. describeDayOff's copy is
 * hardcoded to first-person "Today is..." — this is for callers describing a
 * day OTHER than today (e.g. "is TOMORROW a day off?").
 */
function isDayOff(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { dayOff: false, holiday: null };
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const holiday = usHolidayName(year, month, day);
  return { dayOff: Boolean(holiday) || dow === 0 || dow === 6, holiday };
}

module.exports = { usHolidayName, describeDayOff, isDayOff, nthWeekday, lastWeekday, observedShift, pad };
