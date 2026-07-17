// Durable, server-side ledger of the chief brief's answered "one open
// question" — see intelligence/open-question-policy.js for the
// fingerprint/topic-key derivation and the suppression check that reads
// this. Replaces the prior approach of scanning recent 'brief_context'
// annotations for word overlap with a freshly-generated openQuestion, which
// only the full daily build ever did — the scoped chief-brief-only rebuild
// had no equivalent check, so the same question could resurface immediately
// after being answered (see routes/briefing.js's chief-brief/rebuild route).
const { query } = require('../db');

/** Record that `questionText` (asked on `localDate`, a YYYY-MM-DD string in
 *  the caller's local tz) was answered. `db` defaults to the pooled `query`
 *  but accepts an injected transaction client (see db/index.js's
 *  withTransaction) — POST /briefing/context writes this row, its
 *  explanatory annotation, and the cached-brief retirement atomically so a
 *  durable "answered, don't ask again" suppression state can never exist
 *  without the context that explains it. */
async function recordAnswered({ localDate, questionText, fingerprint, topicKey, answer }, db = query) {
  if (!localDate || !questionText) return;
  await db(
    `INSERT INTO answered_open_questions (local_date, question_text, fingerprint, topic_key, answer)
       VALUES ($1, $2, $3, $4, $5)`,
    [localDate, questionText, fingerprint ?? null, topicKey ?? null, answer ?? null]
  );
}

/** Every open question answered on `localDate` — {questionText, fingerprint,
 *  topicKey, answer}[]. Fail-safe: empty array on error, so a DB hiccup
 *  fails OPEN (asks the question again) rather than silently and
 *  permanently suppressing it. */
async function answeredOn(localDate) {
  if (!localDate) return [];
  try {
    const { rows } = await query(
      `SELECT question_text, fingerprint, topic_key, answer
         FROM answered_open_questions
        WHERE local_date = $1
        ORDER BY created_at ASC`,
      [localDate]
    );
    return rows.map((r) => ({
      questionText: r.question_text, fingerprint: r.fingerprint, topicKey: r.topic_key, answer: r.answer,
    }));
  } catch (err) {
    console.error('[openQuestions] answeredOn failed:', err.message);
    return [];
  }
}

module.exports = { recordAnswered, answeredOn };
