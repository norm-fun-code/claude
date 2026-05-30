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

module.exports = { formatDate, daysBetween, addDays };
