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

/**
 * Render a date as a short "month day" label ("July 16") in a GIVEN local
 * timezone — unlike formatDate (always UTC, includes year), this is for
 * inline anchors like "applied to the night ending July 16" where the
 * caller needs the user's OWN local calendar day, not a UTC-shifted one
 * (an evening instant near UTC midnight must show the night it actually
 * was for the user, not the next UTC day). Returns null for empty/invalid
 * input so callers can omit the clause entirely.
 */
function formatMonthDay(value, tz = 'UTC') {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: tz || 'UTC' });
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

/**
 * UTC instants for the start/end of "today" in a given timezone — the
 * canonical replacement for `new Date(now.getFullYear(), now.getMonth(),
 * now.getDate(), 0,0,0)`, which builds the boundary from the server
 * PROCESS's local time (Node's Date getters honor the OS-level TZ env var,
 * not necessarily the user's actual timezone) rather than the timezone
 * explicitly passed in. Used anywhere a "today's window" needs to be
 * correct regardless of what TZ the server process happens to be running
 * with — e.g. calendar/free-busy queries, annotation lookback windows.
 */
function localDayBoundsUtc(tz = 'UTC', now = new Date()) {
  const ymd = now.toLocaleDateString('en-CA', { timeZone: tz });
  // Anchor the whole second, then add .999ms after conversion —
  // naiveToUtcIso's offset math loses sub-second precision when
  // milliseconds are baked into the input string.
  return {
    start: new Date(naiveToUtcIso(`${ymd}T00:00:00`, tz)),
    end: new Date(new Date(naiveToUtcIso(`${ymd}T23:59:59`, tz)).getTime() + 999),
  };
}

/**
 * UTC instant for the START of the current calendar MONTH in a given
 * timezone — the month analog of localDayBoundsUtc. Bug bash finding:
 * consolidate.js's gatherWealth() used to compute "MTD" via
 * `Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)`, which uses the
 * UTC calendar month, not the user's LOCAL (America/New_York) one — near a
 * month boundary (e.g. the first few hours of a new UTC day that are still
 * the previous day in ET), this silently shifts which days count as
 * "this month" by up to several hours' worth of transactions.
 */
function localMonthStartUtc(tz = 'UTC', now = new Date()) {
  const ymd = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const monthFirst = `${ymd.slice(0, 7)}-01`;
  return new Date(naiveToUtcIso(`${monthFirst}T00:00:00`, tz));
}

/**
 * UTC-midnight of the first day of the current LOCAL calendar month — the
 * boundary that matches how WEALTH FLOW METRICS are keyed. Those are stored at
 * `new Date(`${localDayString}T00:00:00Z`)` (see monarch.js's `dayTs`): a metric
 * for local July 1 lands at `2026-07-01T00:00:00Z`, NOT at true local midnight
 * (`2026-07-01T04:00:00Z` in EDT). So to select "this local month" you need the
 * UTC-midnight of the local month-first-day STRING — `localMonthStartUtc`
 * (true local midnight, 04:00Z) would exclude the 1st-of-month's metric.
 *
 * Use this for the day-keyed wealth flow metrics; use `localMonthStartUtc` /
 * `localDayBoundsUtc` for metrics stored at real wall-clock timestamps (health).
 */
function localMonthKeyStartUtc(tz = 'UTC', now = new Date()) {
  const ymd = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD (local)
  return new Date(`${ymd.slice(0, 7)}-01T00:00:00Z`);
}

/**
 * The local calendar-date string (YYYY-MM-DD) for `now` in `tz` — the
 * canonical way to turn a moment into "which local day is this," used as the
 * date component of durable per-day subject keys (e.g. `calendar_load:
 * 2026-07-17`) and journal entry dates. Centralizes the `toLocaleDateString
 * ('en-CA', {timeZone})` idiom that was previously copy-pasted at each call
 * site.
 */
function localDateStr(tz = 'UTC', now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: tz });
}

module.exports = {
  formatDate, formatMonthDay, daysBetween, addDays, dayAnchorTs, safeDate, toMinutesSinceMidnight,
  naiveToUtcIso, localDayBoundsUtc, localMonthStartUtc, localMonthKeyStartUtc, localDateStr,
};
