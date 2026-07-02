// Derived, auto-advancing phrasing for life chapters — the difference between
// an assistant that knows your metrics and one that knows your life. A
// pregnancy chapter carries only a due date in the DB; every morning this
// derives "week 14 of 40, due Jan 6 (187 days out)" fresh, so the brief is
// never working from a stale, hand-typed "week 13".

const DAY = 86400000;

function toDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(String(d).slice(0, 10) + 'T12:00:00Z');
  return isNaN(dt.getTime()) ? null : dt;
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** One line for one chapter, or null if it can't be phrased. Pure. */
function describeChapter(ch, asOf = new Date()) {
  const label = String(ch.label || '').trim();
  if (!label) return null;
  const key = toDate(ch.key_date);
  const daysOut = key ? Math.round((key.getTime() - asOf.getTime()) / DAY) : null;

  if (ch.kind === 'pregnancy' && key) {
    // Weeks along, derived from a 40-week term ending at the due date.
    const week = Math.min(42, Math.max(1, Math.ceil((280 - daysOut) / 7)));
    const dueStr = `${ch.key_date_label || 'due'} ${fmtDate(key)}`;
    if (daysOut < -14) return `${label} — arrived (was ${dueStr})`;
    if (daysOut < 0) return `${label} — past the due date (${dueStr})`;
    return `${label} — week ${week} of 40, ${dueStr} (${daysOut} days out)`;
  }

  if (key && daysOut != null) {
    const when = `${ch.key_date_label || 'on'} ${fmtDate(key)}`;
    if (daysOut < 0) return `${label} — ${Math.abs(daysOut)} days ago (${when})`;
    if (daysOut === 0) return `${label} — TODAY (${when})`;
    return `${label} — ${daysOut} days out (${when})`;
  }

  return ch.notes ? `${label} — ${String(ch.notes).slice(0, 120)}` : label;
}

/**
 * Pure. Compose the standing-context block from active chapters, soonest
 * anchor first. Returns '' when there's nothing to say.
 */
function composeChapterContext(chapters = [], asOf = new Date()) {
  const lines = chapters
    .map((ch) => describeChapter(ch, asOf))
    .filter(Boolean)
    .slice(0, 5);
  return lines.join('\n');
}

module.exports = { describeChapter, composeChapterContext };
