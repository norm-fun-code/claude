// Small date helpers shared across the intelligence layer.

/**
 * Render a date as a clean human label like "May 30, 2026".
 *
 * Accepts a JS Date (e.g. a Postgres DATE column hydrated by node-postgres) or
 * an ISO string. Returns null for empty/invalid input so callers can omit the
 * clause entirely. Formats in UTC so a date-only value doesn't slip to the
 * previous day in negative-offset zones.
 */
function formatDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Whole days between two dates (b - a), rounded toward zero. */
function daysBetween(a, b) {
  const ms = (b instanceof Date ? b : new Date(b)) - (a instanceof Date ? a : new Date(a));
  return Math.trunc(ms / (24 * 60 * 60 * 1000));
}

/** A new Date `n` days after `from`. */
function addDays(from, n) {
  const d = new Date(from instanceof Date ? from.getTime() : new Date(from).getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

/**
 * A stable per-day timestamp anchor for a given timezone — noon UTC on today's
 * local calendar date. Used so repeated same-day saves (e.g. tapping mood, then
 * energy, then re-tapping mood) upsert the SAME metrics row instead of piling up
 * a dozen noisy readings: one clean value per metric per day that updates as you
 * go, and a fresh row the next day. `(ts AT TIME ZONE tz)::date` resolves to the
 * local date, so the daily-rollover queries line up exactly.
 */
function dayAnchorTs(tz = 'UTC', now = new Date()) {
  // en-CA renders as YYYY-MM-DD; take the local date in `tz`, anchor at noon UTC.
  const ymd = now.toLocaleDateString('en-CA', { timeZone: tz });
  return new Date(`${ymd}T12:00:00Z`);
}

/** Parse to a valid Date, or null if the input is missing/unparseable. Guards
 *  against a bad client-supplied ?ts= reaching the DB as an Invalid Date. */
function safeDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse a bare 12-hour clock string ("2:00 PM", "9:30") to minutes since
 * midnight, or null if unparseable — `new Date(...)` can't parse a bare time,
 * and callers (calendar/free-busy blocks) need to compare and sort these
 * directly. Returns null (not 0) on no-match so callers can distinguish "no
 * time" from midnight; guard with `!= null` before using the result.
 */
function toMinutesSinceMidnight(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
  if (!m) return null;
  let h = Number(m[1]);
  const mer = m[3] ? m[3].toUpperCase() : null;
  if (mer === 'PM' && h !== 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  return h * 60 + Number(m[2]);
}

/**
 * Convert a naive datetime string (no Z / no offset) from a named timezone to
 * UTC ISO. A mobile client sending "2026-06-17T00:00:00" means midnight in
 * ITS timezone; PostgreSQL would otherwise treat that as UTC midnight, which
 * is wrong for ET/PT/etc.
 */
function naiveToUtcIso(naiveStr, tz) {
  if (!naiveStr || naiveStr.includes('Z') || naiveStr.match(/[+-]\d{2}:/)) return naiveStr;
  // Trick: pretend the naive string is UTC, then measure how much local time in `tz`
  // differs from UTC at that moment, and apply the inverse offset.
  const asUtc = new Date(naiveStr + 'Z');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(asUtc);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  const localStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
  const offsetMs = new Date(localStr + 'Z').getTime() - asUtc.getTime();
  return new Date(asUtc.getTime() - offsetMs).toISOString();
}

module.exports = { formatDate, daysBetween, addDays, dayAnchorTs, safeDate, toMinutesSinceMidnight, naiveToUtcIso };
