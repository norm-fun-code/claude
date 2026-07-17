// Durable server-side ledger of pre-brief signal answers — see migration 048
// for the rationale. Keyed by subject_key + local_date so semantically
// identical questions asked on different days about the SAME calendar date
// (e.g. yesterday's "tomorrow is heavily blocked" and today's "packed
// calendar today") suppress each other once either is answered.
const { query } = require('../db');

/** Upsert the answer for (subjectKey, localDate). `fingerprint` is a stable,
 *  caller-defined snapshot of "what the underlying signal looked like" at
 *  answer time (e.g. meeting-hours) — the next read compares against it to
 *  decide whether the schedule has materially changed since.
 *
 *  `db` defaults to the pooled `query` but accepts an injected transaction
 *  client (see db/index.js's withTransaction) — POST /briefing/context
 *  writes this row and its explanatory annotation atomically so a durable
 *  "answered, don't ask again" suppression state can never exist without
 *  the context that explains it (see routes/annotations.js). */
async function recordAnswer({ subjectKey, localDate, fingerprint, answer }, db = query) {
  if (!subjectKey || !localDate) return;
  await db(
    `INSERT INTO signal_answers (subject_key, local_date, fingerprint, answer)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (subject_key, local_date)
       DO UPDATE SET fingerprint = EXCLUDED.fingerprint, answer = EXCLUDED.answer, created_at = now()`,
    [subjectKey, localDate, fingerprint != null ? String(fingerprint) : null, answer ?? null]
  );
}

/** Answers for `subjectKey` within [fromDate, toDate] (inclusive, YYYY-MM-DD
 *  strings), as a Map<localDate, {fingerprint, answer}>. Fail-safe: empty map
 *  on error, so a DB hiccup fails OPEN (asks the question) rather than
 *  silently and permanently suppressing it. */
async function answersFor(subjectKey, { fromDate = null, toDate = null } = {}) {
  try {
    const { rows } = await query(
      `SELECT local_date::text AS local_date, fingerprint, answer
         FROM signal_answers
        WHERE subject_key = $1
          AND ($2::date IS NULL OR local_date >= $2::date)
          AND ($3::date IS NULL OR local_date <= $3::date)`,
      [subjectKey, fromDate, toDate]
    );
    const map = new Map();
    for (const r of rows) map.set(r.local_date, { fingerprint: r.fingerprint, answer: r.answer });
    return map;
  } catch {
    return new Map();
  }
}

module.exports = { recordAnswer, answersFor };
