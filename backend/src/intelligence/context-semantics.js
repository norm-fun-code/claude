// Shared context/annotation-eligibility semantics — the single place that
// decides whether a life-context annotation is safe to surface as EXPLAINED
// context (a possible cause of a metric deviation, or general acknowledged
// life context) versus something that must never leak into generated
// insights at all.
//
// Bug this exists to fix: the Health "What the data shows" card attached a
// user's explicit RETRACTION — "I didn't end up going for drinks with
// friends tonight. Please forget that context." — to an elevated resting-HR
// anomaly as a possible cause. The annotation's own text explicitly says the
// event did NOT happen and asks NormOS to forget it, and it still got
// narrated as "(Context: ... — may explain this deviation.)".
//
// Root cause: every consumer of annotations (analyze.js's anomaly labeling,
// the chief-brief prompt, the quick chief-brief, the self-model, Ask, the
// evening watcher's same-day nudge, the "From Your Library" highlight
// picker) either unconditionally accepted any annotation overlapping a
// broad time window, or ran its own ad-hoc filter with no notion of
// negation, retraction, planned-vs-occurred, or temporal alignment with the
// thing it's supposedly explaining.
//
// This module is the ONE place that classifies an annotation's text and
// decides eligibility — every consumer should route through it instead of
// re-deriving its own rules. It is deliberately pure/synchronous (regex +
// simple date math, no LLM call) so it can run on every anomaly render
// without cost, and is fully unit-testable without a database.
'use strict';

const EVENT_KIND = Object.freeze({
  OCCURRED: 'occurred',     // a real, completed event/state ("had 3 drinks last night")
  PLANNED: 'planned',       // a future/not-yet-happened plan ("drinks tonight")
  NEGATED: 'negated',       // explicitly says the event did NOT happen ("didn't drink")
  RETRACTION: 'retraction', // a correction asking to disregard prior context
  ONGOING: 'ongoing',       // a multi-day condition still in progress (illness, travel)
});

// ── Text classification ─────────────────────────────────────────────────────
// Apostrophes are optional throughout ("didnt" as well as "didn't") — mobile
// keyboards and voice transcription both drop them routinely.

// Checked FIRST — takes priority over any other cue even if the retracted
// text itself contains vivid event language ("forget I said I went out
// drinking"). "didn't end up" is included here (not just under NEGATED):
// grammatically it describes a PLAN that changed, a self-correction, not a
// flat factual report — different in kind from "I didn't drink last night".
const RETRACTION_RE =
  /\bforget (that|this|what i said)\b|\bplease forget\b|\b(ignore|disregard) (that|this|it)\b|\bnever ?mind\b|\b(that|this) (never happened|didn'?t happen)\b|\bactually,? no\b|\bno longer relevant\b|\bnot relevant anymore\b|\bcancel(l)?ed\b|\bdidn'?t end up\b|\bdid not end up\b|\bscratch that\b|\btake (that|it) back\b/i;

// A plain factual negation — distinct from a retraction: the user isn't
// asking to erase a prior statement, they're directly stating something did
// NOT happen ("I didn't drink last night"). Checked only after RETRACTION_RE.
const NEGATION_RE =
  /\b(didn'?t|did not|won'?t|isn'?t going to|wasn'?t|weren'?t|haven'?t|hadn'?t)\b/i;

// Multi-day states still in progress — illness, travel, recovery. Checked
// before FUTURE_RE ("day 3 of the flu" shouldn't be read as forward-looking).
const ONGOING_RE =
  /\bstill (sick|ill|down with|recovering|traveling|travelling|jet ?lagged|fighting)\b|\bongoing\b|\bday \d+ of\b|\bfor the (past|last) \d+ days?\b|\bbeen (sick|ill|traveling|travelling|down with|fighting)\b|\brecovering from\b|\bjet ?lag(ged)?\b/i;

// Forward-looking language — the event hasn't happened yet.
const FUTURE_RE =
  /\btonight\b|\btomorrow\b|\blater (today|tonight)\b|\bthis (evening|weekend)\b|\bnext (week|weekend|month)\b|\bgoing to\b|\bplan(ning)? to\b|\babout to\b|\bwill be\b|\bscheduled to\b|\bupcoming\b/i;

// Backward-looking language that wins over an accidental FUTURE_RE hit (a
// note mentioning both "last night" and "tonight" in passing) — also the
// signal used by isTemporallyAligned to accept a same-morning report.
const PAST_RE =
  /\blast night\b|\byesterday\b|\bovernight\b|\bearlier (today|this evening)\b|\balready (went|had|did|drank|ate)\b|\bended up\b|\blast evening\b|\bthe night before\b|\bprevious night\b/i;

// Category-based fallback: an 'illness'/'travel'-categorized annotation with
// no other overriding cue (retraction/negation/future) defaults to ONGOING
// rather than a one-off OCCURRED event — matches how those categories are
// actually used (see the migration's category comment: travel | illness |
// deadline | relationship | life | other).
const ONGOING_CATEGORIES = new Set(['illness', 'travel']);

/**
 * Pure: classify what an annotation's text is actually saying happened.
 * `category` is an optional secondary signal (see ONGOING_CATEGORIES) — it
 * only applies when nothing else in the text overrides it.
 */
function classifyEventKind(text, { category = null } = {}) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return EVENT_KIND.OCCURRED;

  if (RETRACTION_RE.test(t)) return EVENT_KIND.RETRACTION;
  if (NEGATION_RE.test(t)) return EVENT_KIND.NEGATED;
  if (ONGOING_RE.test(t)) return EVENT_KIND.ONGOING;
  if (FUTURE_RE.test(t) && !PAST_RE.test(t)) return EVENT_KIND.PLANNED;
  if (category && ONGOING_CATEGORIES.has(String(category).toLowerCase())) return EVENT_KIND.ONGOING;
  return EVENT_KIND.OCCURRED;
}

/** Convenience: is this text a retraction/correction? */
function isRetraction(text, opts) {
  return classifyEventKind(text, opts) === EVENT_KIND.RETRACTION;
}

// ── Topic/domain plausibility ───────────────────────────────────────────────

// Plausible, physiologically-grounded drivers of an overnight body-metric
// deviation (HRV, resting HR, sleep, respiratory rate), broken into CANONICAL
// CAUSE CONCEPTS rather than one flat alternation. Deliberately NOT "any life
// event" — accepting every annotation regardless of content was the root
// cause of the bug this module fixes. A real causal candidate names one of
// these tags — and, critically, the TAG (not raw word overlap) is what a
// downstream causal-attribution check (brain/claimValidator.js's
// checkRecoveryCause) matches a generated claim against: "drank wine last
// night" and "a late meal last night" share the words "last"/"night" but are
// DIFFERENT cause concepts (alcohol vs late_meal), and must never be treated
// as the same driver just because they're both time-anchored the same way.
const CAUSE_CONCEPTS = [
  { tag: 'alcohol', re: /\b(drinks?|drank|alcohol|wine|beer|cocktails?|shots?|hungover|hangover)\b/i },
  { tag: 'illness', re: /\b(sick|illness|ill|cold|flu|fever|nause(a|ous)|vomit(ed|ing)?|food poisoning)\b/i },
  { tag: 'travel', re: /\b(travel(l?ed|ling)?|flight|jet ?lag(ged)?|time ?zone|red-?eye)\b/i },
  { tag: 'room_conditions', re: /\b(hot|cold|noisy|loud) (room|bedroom)\b|\b(room|bedroom) (was |is )?(very |really |so )?(hot|cold|noisy|loud)\b|\bair ?conditioning\b|\bheat ?wave\b/i },
  { tag: 'late_meal', re: /\b(late|big|heavy) (meal|dinner)\b|\bate late\b|\bspicy\b/i },
  { tag: 'medication', re: /\b(medication|prescription|dosage|new med)\b/i },
  { tag: 'stress', re: /\bstress(ed|ful)?\b|\banxi(ous|ety)\b|\bargument\b|\bfight\b|\bdeadline\b/i },
  { tag: 'hard_training', re: /\b(intense|hard|unusual) (workout|training|session)\b|\bovertrain(ed|ing)?\b|\brace\b/i },
];

/** Pure: which canonical cause-concept tags does this text name (possibly
 *  several — "drank wine after a stressful day" is both alcohol and stress)?
 *  Empty array = names no recognized physiological cause at all. */
function causeConceptTags(text) {
  const t = String(text || '');
  return CAUSE_CONCEPTS.filter((c) => c.re.test(t)).map((c) => c.tag);
}

function isPlausibleHealthCause(text) {
  return causeConceptTags(text).length > 0;
}

// Word-boundary anchors matter here: an un-anchored `ill` matches "chill",
// "skill", "still", "will", "bill", "hill"; an un-anchored `loss` matches
// "floss"/"gloss"; `sad` anchored for consistency. Leading \b only (not
// trailing) so inflections still count — "illness", "sadness", "losses".
const MOOD_KEYWORDS_RE =
  /stress(ed|ful)?|anxi(ous|ety)|\bsad|upset|fight|argument|deadline|launch|presentation|worr(y|ied)|grief|\bloss|overwhelm|frustrat|angry|lonely|conflict|fired|lay ?off|break ?up|sick|\bill|funeral|hospital/i;

function isPlausibleWellbeingCause(text) {
  return MOOD_KEYWORDS_RE.test(String(text || ''));
}

// ── Financial annotations (never health/wellbeing causal context) ──────────

const FINANCIAL_RE = /spend|wealth|financ|budget|\$\d|money|bill/i;
function isFinancialAnnotation(a) {
  const category = String(a?.category || '').toLowerCase();
  if (category.includes('spend') || category.includes('wealth') || category.includes('financ')) return true;
  return FINANCIAL_RE.test(`${a?.label || ''} ${a?.note || ''}`);
}

// ── Retirement state ────────────────────────────────────────────────────────

function isRetired(a) {
  return Boolean(a?.retired_at);
}

// ── Temporal alignment (health purpose) ─────────────────────────────────────

/**
 * Pure: does this annotation's own timing plausibly explain a deviation
 * observed over `window` ({start, end} Dates — the metric's actual
 * observation window, e.g. previous-evening-to-wake for overnight Eight
 * Sleep data)? An OCCURRED event must have happened during the window, or
 * been logged the same morning with an explicit backward reference ("last
 * night"/"yesterday"/"overnight"). An ONGOING condition must have been
 * ACTIVE — its own start/end interval overlaps the window — a resolved
 * illness from a week ago does not qualify just because it's still "in the
 * lookback query". Same-day context with no backward reference describes
 * TODAY, not last night, and is rejected — this is what keeps "Planning
 * drinks tonight" (logged today, no PAST_RE) from ever explaining last
 * night's already-collected data.
 */
function isTemporallyAligned(annotation, window, kind) {
  if (!window || !window.start || !window.end) return true; // no window supplied — content checks only
  const text = `${annotation?.label || ''} ${annotation?.note || ''}`;
  const annStart = annotation?.start_ts ? new Date(annotation.start_ts) : null;
  if (!annStart || Number.isNaN(annStart.getTime())) return false;

  if (kind === EVENT_KIND.ONGOING) {
    const annEnd = annotation?.end_ts ? new Date(annotation.end_ts) : new Date();
    return annStart <= window.end && annEnd >= window.start;
  }

  // Logged during the window itself (the evening before, before the
  // metric's observation period ends).
  if (annStart >= window.start && annStart <= window.end) return true;

  // Logged the same morning — only counts with an explicit backward
  // reference; a generous 14h grace covers "logged right after waking" through
  // a late-morning brief rebuild.
  const graceEnd = new Date(window.end.getTime() + 14 * 60 * 60 * 1000);
  if (annStart > window.end && annStart <= graceEnd) return PAST_RE.test(text.toLowerCase());

  return false;
}

// ── "Describes the completed overnight sleep window" ────────────────────────
// Centralizes the temporal-parsing decision routes/annotations.js's POST
// /briefing/context uses to bind an answer's EFFECTIVE window to the actual
// night it describes (analyze.js's resolveNightWindow) instead of "now".
// Previously this lived as a narrower, duplicated regex directly in the
// route (only "last night"/"yesterday"/"overnight") — one canonical
// definition here instead, reusing PAST_RE so a new phrasing only needs to
// be taught once.

// Signal keys whose answer is, BY DEFINITION, about the completed overnight
// sleep window that produced the metric the question is even asking about —
// no wording check needed at all. recovery_low's entire premise is "your
// score is low TODAY — what from last night is driving it?"; an answer like
// "I had a drink and late meal" carries no date phrase whatsoever, but it is
// unambiguously describing last night because that is the only thing the
// question could be asking about. Binding on wording alone would silently
// miss exactly this case.
const NIGHT_BOUND_SIGNAL_KEYS = new Set(['recovery_low']);

/**
 * Pure: should this answer's effective annotation window be bound to the
 * night that produced today's already-collected data, rather than left at
 * "now" (which would default forward and could bleed into tomorrow)?
 * True when the SIGNAL itself is inherently about last night (see
 * NIGHT_BOUND_SIGNAL_KEYS), OR the question/answer text explicitly says so
 * ("last night", "yesterday", "overnight", "last evening", "the night
 * before", "previous night", ...).
 */
function describesCompletedNight({ signalKey, question, answer } = {}) {
  if (signalKey && NIGHT_BOUND_SIGNAL_KEYS.has(signalKey)) return true;
  return PAST_RE.test(`${question || ''} ${answer || ''}`);
}

// ── The main eligibility gate ───────────────────────────────────────────────

/**
 * The single eligibility check every consumer should use.
 *
 * @param {object} annotation - a row from the annotations table (label,
 *   note, category, start_ts, end_ts, retired_at).
 * @param {object} [opts]
 * @param {'health'|'wellbeing'|'forecast'|'general'} [opts.purpose='general']
 * @param {{start: Date, end: Date}} [opts.window] - the metric's actual
 *   observation window; only enforced for purpose 'health'. Omit to skip
 *   temporal-alignment checking (content-only).
 * @param {boolean} [opts.excludeFinancial=true] - drop spend/wealth notes
 *   even for 'general' consumers that otherwise accept a broad range.
 * @returns {{ eligible: boolean, reason: string, kind: string|null, confidence: 'high'|'low' }}
 */
function isEligibleContext(annotation, opts = {}) {
  const { purpose = 'general', window = null, excludeFinancial = true } = opts;
  if (!annotation) return { eligible: false, reason: 'missing', kind: null, confidence: 'low' };
  if (isRetired(annotation)) return { eligible: false, reason: 'retired', kind: null, confidence: 'low' };

  const text = `${annotation.label || ''} ${annotation.note || ''}`;
  const kind = classifyEventKind(text, { category: annotation.category });

  // A retraction is never active causal context, in ANY consumer, full stop.
  if (kind === EVENT_KIND.RETRACTION) {
    return { eligible: false, reason: 'retraction', kind, confidence: 'low' };
  }

  if (purpose === 'health') {
    if (isFinancialAnnotation(annotation)) return { eligible: false, reason: 'financial', kind, confidence: 'low' };
    if (kind === EVENT_KIND.PLANNED) return { eligible: false, reason: 'future-plan', kind, confidence: 'low' };
    if (kind === EVENT_KIND.NEGATED) return { eligible: false, reason: 'negated', kind, confidence: 'low' };
    if (!isPlausibleHealthCause(text)) return { eligible: false, reason: 'not-plausible-cause', kind, confidence: 'low' };
    if (!isTemporallyAligned(annotation, window, kind)) return { eligible: false, reason: 'not-temporally-aligned', kind, confidence: 'low' };
    return { eligible: true, reason: 'plausible-cause', kind, confidence: 'high' };
  }

  if (purpose === 'wellbeing') {
    if (isFinancialAnnotation(annotation)) return { eligible: false, reason: 'financial', kind, confidence: 'low' };
    if (kind === EVENT_KIND.PLANNED) return { eligible: false, reason: 'future-plan', kind, confidence: 'low' };
    if (kind === EVENT_KIND.NEGATED) return { eligible: false, reason: 'negated', kind, confidence: 'low' };
    if (!isPlausibleWellbeingCause(text)) return { eligible: false, reason: 'not-plausible-cause', kind, confidence: 'low' };
    return { eligible: true, reason: 'plausible-cause', kind, confidence: 'high' };
  }

  // 'forecast' — forward-looking recovery/capacity prediction (predict.js).
  // A PLANNED event ("stressful launch tomorrow", "traveling tomorrow",
  // "planned rest day") IS relevant and may adjust the lean; an OCCURRED or
  // ONGOING event (drinks last night, an active illness) can carry into
  // tomorrow too. But a NEGATED event ("I didn't drink") must never worsen a
  // forecast, and financial notes are irrelevant to recovery capacity —
  // exclude both, plus retraction/retired (already handled above). This is
  // deliberately stricter than 'general' (which keeps negated) because the
  // forecast's whole failure mode is a note that shouldn't move the number
  // moving it.
  if (purpose === 'forecast') {
    if (isFinancialAnnotation(annotation)) return { eligible: false, reason: 'financial', kind, confidence: 'low' };
    if (kind === EVENT_KIND.NEGATED) return { eligible: false, reason: 'negated', kind, confidence: 'low' };
    return { eligible: true, reason: 'forecast-context', kind, confidence: 'low' };
  }

  // 'general' — broad context surfaces (Ask, quick chief-brief, the
  // self-model, watch.js's same-day nudge, the library-highlight picker).
  // Retraction/retired are already excluded above unconditionally; planned/
  // negated/occurred/ongoing are all legitimate things to acknowledge as
  // context (a genuinely upcoming plan is useful to mention, just not as a
  // cause of already-collected data — that distinction is 'health' purpose's
  // job, not this one's).
  if (excludeFinancial && isFinancialAnnotation(annotation)) {
    return { eligible: false, reason: 'financial', kind, confidence: 'low' };
  }
  return { eligible: true, reason: 'general-context', kind, confidence: 'low' };
}

/** Convenience: filter a list of annotations down to eligible ones. */
function filterEligible(annotations, opts) {
  return (annotations || []).filter((a) => isEligibleContext(a, opts).eligible);
}

// ── Retraction-target matching ──────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'is', 'are', 'was', 'were', 'with',
  'on', 'in', 'at', 'that', 'this', 'it', 'be', 'has', 'have', 'been', 'your', 'my',
  'i', 'me', 'not', 'did', 'do', 'does', 'end', 'up', 'context', 'please',
]);

function significantWords(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function overlapScore(a, b) {
  const wa = new Set(significantWords(a));
  const wb = new Set(significantWords(b));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size);
}

const RETRACTION_MATCH_THRESHOLD = 0.34;
const RETRACTION_MATCH_MARGIN = 0.15;

/**
 * Pure: given a retraction's text and a list of candidate prior annotations
 * (already time/id-scoped by the caller — recent, non-retired, excluding the
 * retraction row itself), return the ONE annotation it's most plausibly
 * walking back, or null if nothing is a clear, unambiguous match.
 * Conservative by design (see the requirement this satisfies: "retire/
 * supersede the matching recent annotation if it can be identified
 * unambiguously") — never guesses when two candidates score closely, and
 * never matches below the overlap threshold, so an unrelated annotation is
 * never silently retired.
 */
function findRetractionTarget(retractionText, candidates) {
  const scored = (candidates || [])
    .map((c) => ({ c, score: overlapScore(retractionText, `${c.label || ''} ${c.note || ''}`) }))
    .filter((s) => s.score >= RETRACTION_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length === 1) return scored[0].c;
  if (scored[0].score - scored[1].score >= RETRACTION_MATCH_MARGIN) return scored[0].c;
  return null; // ambiguous — don't guess
}

module.exports = {
  EVENT_KIND,
  classifyEventKind,
  isRetraction,
  isPlausibleHealthCause,
  isPlausibleWellbeingCause,
  isFinancialAnnotation,
  isRetired,
  isTemporallyAligned,
  isEligibleContext,
  filterEligible,
  findRetractionTarget,
  describesCompletedNight,
  causeConceptTags,
};
