// Best-effort, deterministic reconstruction of an episodic assertion's
// effectiveEnd from its already-persisted rawText + recordedAt — used ONLY
// by the one-time repair script (scripts/repair-unbounded-episodic-
// assertions.js) for rows compiled before the episodic-lifecycle fix
// existed (context-compiler.js's resolveTemporalWindow /
// context-resolver.js's isForwardEpisodic). Mirrors that fix's own
// duration/end-date extraction, but re-derives the duration/end signal from
// raw_text directly — the original LLM-extracted durationHours/
// explicitEndDate were never persisted as their own columns, only the
// effective_start/end they produced, which for these exact rows is the bug:
// effective_end is null.
//
// "Where the original text clearly provides a duration or endpoint,
// reconstruct it from recorded_at. Otherwise exclude the assertion from
// current projections rather than guessing that it is still active." — the
// EXCLUSION half of that requirement is already satisfied at READ time by
// isTemporallyEligible/isForwardEpisodic (a forward-episodic assertion with
// no effectiveEnd never reads as current) with NO migration needed; this
// module is only the RECONSTRUCTION half — recovering a real bound for the
// rows that clearly support one, so they don't stay excluded forever when
// the text plainly said, e.g., "25 hour fast."
'use strict';

const { localDayBoundsUtc, localDateStr } = require('../util/date');

const MAX_DURATION_HOURS = 24 * 14; // two weeks — same generous ceiling as the live compiler path

/** Best-effort EXTRACT (not just validate, unlike the live compiler's
 *  textStatesDurationHours) a stated duration from free text — "25 hour
 *  fast", "3 days", "48-hour". Returns hours, or null when nothing
 *  matches or the match is out of sane bounds. */
function extractDurationHours(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*-?\s*(hour|hr|day)s?\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const hours = m[2].toLowerCase().startsWith('day') ? n * 24 : n;
  return Number.isFinite(hours) && hours > 0 && hours <= MAX_DURATION_HOURS ? hours : null;
}

/** Best-effort EXTRACT an explicit end bound from free text, anchored to
 *  recordedAt's own local date — deliberately only the CLEAR, unambiguous
 *  cases: "through/until/ending tomorrow" -> the day after recordedAt;
 *  "through/until/ending today" (a same-day bound restated) -> recordedAt's
 *  own day. Anything less explicit (a bare weekday name, "next week") is
 *  NOT reconstructed — a wrong guess here would be worse than leaving the
 *  row excluded, which is always the safe fallback (see the module header).
 *  Returns a 'YYYY-MM-DD' string, or null. */
function extractEndDateStr({ text, recordedAt, tz }) {
  const t = String(text || '');
  if (!/\b(through|until|till|'til|ending)\b/i.test(t)) return null;
  const recordedLocal = localDateStr(tz, recordedAt);
  if (/\b(through|until|till|'til|ending)\s+tomorrow\b/i.test(t)) {
    const next = new Date(`${recordedLocal}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString().slice(0, 10);
  }
  if (/\b(through|until|till|'til|ending)\s+today\b/i.test(t)) {
    return recordedLocal;
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.rawText - the assertion's persisted raw_text.
 * @param {Date|string} opts.effectiveStart - the assertion's persisted
 *   effective_start (required — nothing to extend without a known start).
 * @param {Date|string} opts.recordedAt - the assertion's persisted
 *   recorded_at (the anchor for resolving "tomorrow"/"today").
 * @param {string} [opts.tz]
 * @returns {Date|null} a reconstructed effectiveEnd, or null when nothing in
 *   the text clearly supports one — the caller must NOT guess further; leave
 *   the row as-is (still correctly excluded from current-state projections
 *   at read time, per context-resolver.js's isTemporallyEligible).
 */
function reconstructEffectiveEnd({ rawText, effectiveStart, recordedAt, tz = process.env.TZ || 'America/New_York' }) {
  if (!effectiveStart || !recordedAt) return null;
  const start = effectiveStart instanceof Date ? effectiveStart : new Date(effectiveStart);
  const recorded = recordedAt instanceof Date ? recordedAt : new Date(recordedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(recorded.getTime())) return null;

  const durationHours = extractDurationHours(rawText);
  if (durationHours != null) {
    const candidate = new Date(start.getTime() + durationHours * 3600 * 1000);
    if (candidate.getTime() > start.getTime()) return candidate;
  }
  const endDateStr = extractEndDateStr({ text: rawText, recordedAt: recorded, tz });
  if (endDateStr) {
    const d = new Date(`${endDateStr}T12:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      const candidate = localDayBoundsUtc(tz, d).end;
      const spanMs = candidate.getTime() - start.getTime();
      if (spanMs > 0 && spanMs <= MAX_DURATION_HOURS * 3600 * 1000) return candidate;
    }
  }
  return null;
}

module.exports = { extractDurationHours, extractEndDateStr, reconstructEffectiveEnd };
