// Centralized policy for the chief brief's "one open question" — the single
// place every generation path (the full daily build, the scoped
// chief-brief-only rebuild, and any fallback/retry that can replace
// chiefBrief) must run before showing openQuestion to the user.
//
// Bug this exists to fix: a question, once answered, could resurface
// immediately after a scoped Chief Brief rebuild. Root causes:
//   1. The full build applied a deterministic dedup check (word-overlap
//      against recent 'brief_context' annotations) but POST
//      /briefing/chief-brief/rebuild never ran it at all — a rebuild re-runs
//      the LLM from scratch with no memory of what was just answered.
//   2. POST /briefing/context retired the question from cached builds via a
//      fire-and-forget call, so answering and immediately rebuilding could
//      race the retirement write.
//   3. The annotation-word-overlap check was an unreliable substitute for a
//      durable, purpose-built "this question was answered" ledger — it
//      shared a table (and its 30-row "top annotations" window) with every
//      other kind of life-context note.
//   4. Mobile's in-memory Set only covers the current app session; a fresh
//      fetch (remount, second device, app restart) has no client-side memory
//      at all and depends entirely on the server having actually retired it.
//
// This module is deliberately pure/synchronous where possible (fingerprint,
// topic key, and the same-topic comparison) so it's fully unit-testable
// without a database; only the top-level suppress function touches the
// store, and it degrades to "don't suppress" (fail open — see
// store/openQuestions.js's answeredOn) rather than ever accidentally hiding
// a genuinely new question.
'use strict';

const { significantWords, overlapScore } = require('./context-semantics');

// Same threshold the original per-build dedup check used (common words /
// smaller side's word count) — preserved exactly so existing suppression
// behavior for close paraphrases doesn't regress.
const SAME_TOPIC_THRESHOLD = 0.6;

/** Collapse whitespace/case for stable identity and storage. Not a crypto
 *  hash — like the rest of this codebase's "fingerprint" fields (e.g.
 *  signal_answers' meeting-hours fingerprint), it's a literal, readable
 *  normalized value, capped to a sane storage/payload length. */
function normalizeOpenQuestionText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** The fingerprint persisted with an answered question and echoed back to
 *  mobile in the briefing payload (see routes/briefing.js's chiefBrief
 *  shape) — mobile returns this verbatim when answering instead of relying
 *  on its own in-memory copy of the question text staying byte-identical. */
function openQuestionFingerprint(text) {
  const norm = normalizeOpenQuestionText(text);
  return norm ? norm.slice(0, 300) : null;
}

/** A best-effort, deterministic "topic" key: the question's significant
 *  words (stopwords/short words already stripped by context-semantics'
 *  significantWords), sorted so word order doesn't matter, joined into one
 *  string. Two questions about the same event/metric phrased in a different
 *  word order collapse to the same key; this is opportunistic (used for
 *  quick equality checks / debugging), NOT the authority for suppression —
 *  that's isSameOpenQuestionTopic's fuzzy overlap check below, which also
 *  catches paraphrases that don't share every word. */
function openQuestionTopicKey(text) {
  const words = [...new Set(significantWords(text))].sort();
  return words.length ? words.join(' ').slice(0, 300) : null;
}

/** Are `a` and `b` close paraphrases about the same unresolved event/metric?
 *  Symmetric word-overlap ratio (shared significant words / the SMALLER
 *  side's word count) at the same 0.6 threshold the original per-build
 *  check used. Two short questions sharing most of their meaningful words
 *  count as the same topic; two questions that happen to share only a
 *  couple of common terms do not. */
function isSameOpenQuestionTopic(a, b, threshold = SAME_TOPIC_THRESHOLD) {
  if (!a || !b) return false;
  return overlapScore(a, b) >= threshold;
}

/**
 * Pure: given `chiefBrief` (possibly null) and the list of questions already
 * answered today ({questionText, ...}[] — see store/openQuestions.js's
 * answeredOn), return a chiefBrief with openQuestion blanked if it's an
 * exact repeat or a close paraphrase of one of them.
 *
 * Also the ONE place that stamps `openQuestionFingerprint` onto a surviving
 * question — every generation path routes through this, so mobile always
 * gets a server-computed identity to echo back when answering (see
 * routes/annotations.js's POST /briefing/context) instead of depending on
 * its own in-memory copy of the question text staying byte-identical across
 * a rebuild.
 */
function stripAnsweredOpenQuestion(chiefBrief, answeredToday) {
  const q = chiefBrief?.openQuestion;
  if (!q || !String(q).trim()) return chiefBrief;
  const rows = answeredToday || [];
  const alreadyAnswered = rows.some((a) => isSameOpenQuestionTopic(q, a.questionText));
  if (alreadyAnswered) return { ...chiefBrief, openQuestion: '', openQuestionFingerprint: null };
  return { ...chiefBrief, openQuestionFingerprint: openQuestionFingerprint(q) };
}

/**
 * The async entrypoint every generation path calls right after producing a
 * chiefBrief (full build, scoped rebuild, any fallback/retry that can
 * replace chiefBrief) — fetches today's answered questions and applies
 * stripAnsweredOpenQuestion (which also stamps openQuestionFingerprint onto
 * a surviving question). `localDate` is a YYYY-MM-DD string in the caller's
 * tz (so a genuinely new occurrence of a similar question on a LATER day is
 * never suppressed — only rows recorded under the exact same local date are
 * considered). Never throws: a lookup failure degrades to "don't suppress"
 * (store/openQuestions.js's answeredOn already fails open), so a DB hiccup
 * can at worst let an already-answered question reappear once, never
 * silently and permanently hide a fresh one.
 */
async function suppressAnsweredOpenQuestion(chiefBrief, { localDate } = {}) {
  if (!chiefBrief?.openQuestion || !String(chiefBrief.openQuestion).trim()) return chiefBrief;
  if (!localDate) return chiefBrief;
  const openQuestionsStore = require('../store/openQuestions');
  const answeredToday = await openQuestionsStore.answeredOn(localDate);
  return stripAnsweredOpenQuestion(chiefBrief, answeredToday);
}

/** Plain-text block for the chief-brief prompt: today's already-answered
 *  questions and their answers, so the model (a) avoids re-asking them (the
 *  deterministic check above is the actual enforcement; this is a
 *  best-effort head start) and (b) can use the answer as live context for
 *  today's synthesis — the question should disappear, but its answer should
 *  still inform the rebuilt brief. Pure formatter — callers fetch the rows
 *  themselves (store/openQuestions.js's answeredOn) so this stays
 *  unit-testable without a database. */
function formatAnsweredQuestionsContext(answeredToday) {
  const rows = (answeredToday || []).filter((a) => a?.questionText && a?.answer);
  if (!rows.length) return '';
  return rows.map((a) => `- Asked: "${a.questionText}" -> Answered: "${a.answer}"`).join('\n');
}

module.exports = {
  SAME_TOPIC_THRESHOLD,
  normalizeOpenQuestionText,
  openQuestionFingerprint,
  openQuestionTopicKey,
  isSameOpenQuestionTopic,
  stripAnsweredOpenQuestion,
  suppressAnsweredOpenQuestion,
  formatAnsweredQuestionsContext,
};
