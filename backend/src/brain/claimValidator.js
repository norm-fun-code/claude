// Semantic claim validator — the generalization of the chief-brief's
// goal-completion guard. The LLM may choose emphasis and wording, but it may
// NOT create or recalculate canonical facts: recovery score/band, which workout
// is effective and whether it's planned vs completed, goal/commitment
// completion, spending totals, experiment verdicts, forecast leans, and the
// current date all have authoritative values (from the BrainSnapshot). This
// module deterministically scans generated chief-brief text for statements that
// CONTRADICT those values and reports them, so a contradiction can be corrected
// (a retry) or, at worst, logged — never silently shipped.
//
// Design mirrors the existing goal-completion guard (briefing-ai.js): high
// PRECISION over recall. Each check fires only on a specific, unambiguous
// contradiction pattern — a band-color word asserted against a known band, a
// scheduled hard session prescribed when it's been downgraded away, a dollar
// total that disagrees with the canonical spend by a wide margin. A validator
// that false-positives on valid briefs is worse than none (it would corrupt
// good output), so when in doubt it stays silent.
'use strict';

const { causeConceptTags } = require('../intelligence/context-semantics');

function splitIntoSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'is', 'are', 'was', 'were', 'with',
  'on', 'in', 'at', 'that', 'this', 'it', 'be', 'has', 'have', 'been', 'your', 'my',
]);
function sigWords(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}
function overlapRatio(sentence, phrase) {
  const pw = sigWords(phrase);
  if (!pw.size) return 0;
  const sw = sigWords(sentence);
  let common = 0;
  for (const w of pw) if (sw.has(w)) common++;
  return common / pw.size;
}

const BRIEF_FIELDS = ['synthesis', 'action', 'risk', 'move', 'affirmation', 'openQuestion'];
/** Iterate [fieldName, text] over a brief result's checkable fields. */
function briefFields(result) {
  const cb = result?.chiefBrief || {};
  const out = BRIEF_FIELDS.map((f) => [f, cb[f]]);
  out.push(['morningFocus', result?.morningFocus]);
  return out.filter(([, t]) => typeof t === 'string' && t.trim());
}

// ── Recovery band ────────────────────────────────────────────────────────────
// A band-color assertion tied to recovery. Only fires when a color/quality word
// appears in a recovery context AND contradicts the known band.
const BAND_SYNONYMS = {
  green: /\bgreen\b|\bfully recovered\b|\bfull send\b|\bfully rested\b/i,
  yellow: /\byellow\b|\bmoderate(?:ly)? recover/i,
  red: /\bred\b|\bunder-?recovered\b|\blow recovery\b|\bin the red\b/i,
};
const RECOVERY_CONTEXT_RE = /\brecover|\bhrv\b|\bband\b|\brested\b|\breadiness\b/i;

function checkRecoveryBand(result, facts) {
  const band = facts.recoveryBand;
  if (!band || !BAND_SYNONYMS[band]) return [];
  const violations = [];
  for (const [field, text] of briefFields(result)) {
    for (const sentence of splitIntoSentences(text)) {
      if (!RECOVERY_CONTEXT_RE.test(sentence)) continue;
      for (const [claimedBand, re] of Object.entries(BAND_SYNONYMS)) {
        if (claimedBand === band) continue;
        if (re.test(sentence)) {
          violations.push({
            check: 'recovery_band', field, sentence, severity: 'high',
            expected: band, actual: claimedBand,
            message: `states recovery is "${claimedBand}" but the recovery band is ${band}`,
          });
        }
      }
    }
  }
  return violations;
}

// ── Recovery score ───────────────────────────────────────────────────────────
// A cited "recovery score of NN" / "NN/100" that's materially off the real one.
const SCORE_TOLERANCE = 6;
function checkRecoveryScore(result, facts) {
  const score = facts.recoveryScore;
  if (score == null || !Number.isFinite(score)) return [];
  const violations = [];
  for (const [field, text] of briefFields(result)) {
    for (const sentence of splitIntoSentences(text)) {
      if (!RECOVERY_CONTEXT_RE.test(sentence) && !/\bscore\b/i.test(sentence)) continue;
      // "recovery score of 72", "recovery at 72", "72/100", "score is 72"
      const m = sentence.match(/\b(?:recovery|score)\b[^.\d]{0,20}(\d{1,3})\b(?!\s*(?:%|percent|bpm|ms|am|pm|:))/i)
        || sentence.match(/\b(\d{1,3})\s*\/\s*100\b/);
      if (!m) continue;
      const cited = Number(m[1]);
      if (!Number.isFinite(cited) || cited > 100) continue;
      if (Math.abs(cited - score) > SCORE_TOLERANCE) {
        violations.push({
          check: 'recovery_score', field, sentence, severity: 'high',
          expected: score, actual: cited,
          message: `cites recovery score ${cited} but the real score is ${score}`,
        });
      }
    }
  }
  return violations;
}

// ── Recovery causation ───────────────────────────────────────────────────────
// A causal recovery sentence ("recovery dipped because of the wine last
// night") must name a driver present in facts.recoveryDrivers — annotations
// that are BOTH topically health-plausible AND fall inside the EXACT
// overnight window that produced today's reading (see
// intelligence/recovery-drivers.js). General life context (a same-day
// meeting, a habit trend, an invented guess) never qualifies, no matter how
// health-plausible it sounds — and when no eligible driver exists at all,
// asserting ANY cause is a violation: the brief should say the cause is
// unknown, not guess.
const CAUSAL_RE = /\b(because|due to|thanks to|caused by|driven by|driving|drove|drives|explains?|behind (?:the|this|today'?s)|from (?:the|last night'?s|yesterday'?s))\b/i;

// Generic time-anchoring words that appear in almost EVERY causal recovery
// sentence regardless of what the actual cause is ("last night", "the night
// before", "this morning"...). The bug this fixes: the old lexical-overlap
// check counted these as shared vocabulary between an eligible driver
// ("drank wine last night") and an UNRELATED generated claim ("a late meal
// last night") — "last"/"night" alone cleared the overlap threshold even
// though the two describe different causes entirely. Stripped from the
// FALLBACK lexical check below; the PRIMARY check is canonical cause-concept
// tag matching (context-semantics.js's causeConceptTags), which never had
// this problem in the first place since "last"/"night" don't map to any tag.
const TEMPORAL_STOPWORDS = new Set([
  'last', 'night', 'nights', 'yesterday', 'overnight', 'evening', 'evenings',
  'morning', 'mornings', 'today', 'tonight', 'before', 'previous', 'day', 'days',
]);
function causalSigWords(s) {
  const words = String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  return new Set(words.filter((w) => w.length > 2 && !STOPWORDS.has(w) && !TEMPORAL_STOPWORDS.has(w)));
}
function causalOverlapRatio(sentence, phrase) {
  const pw = causalSigWords(phrase);
  if (!pw.size) return 0;
  const sw = causalSigWords(sentence);
  let common = 0;
  for (const w of pw) if (sw.has(w)) common++;
  return common / pw.size;
}
const CAUSE_OVERLAP_THRESHOLD = 0.3;

function checkRecoveryCause(result, facts) {
  // Only meaningful once the caller has actually computed eligible drivers —
  // absent facts.recoveryDrivers (an older/partial facts object), stay silent
  // rather than false-positive on every causal recovery sentence.
  if (!facts || !Array.isArray(facts.recoveryDrivers)) return [];
  const drivers = facts.recoveryDrivers;
  // Canonical concept tags named by the eligible drivers (e.g. "drank wine
  // last night" -> ['alcohol']). Every eligible driver already passed
  // context-semantics.js's isPlausibleHealthCause to BECOME eligible, so it
  // is guaranteed to name at least one tag.
  const eligibleTags = new Set(drivers.flatMap((d) => causeConceptTags(d)));
  const violations = [];
  for (const [field, text] of briefFields(result)) {
    for (const sentence of splitIntoSentences(text)) {
      if (!RECOVERY_CONTEXT_RE.test(sentence)) continue;
      if (!CAUSAL_RE.test(sentence)) continue;
      // Grounded if the claim names a RECOGNIZED cause concept — compared
      // concept-to-concept ONLY, never overridden by lexical overlap. Every
      // eligible driver already has >=1 recognized tag (guaranteed by
      // isPlausibleHealthCause), so whenever the CLAIM also names a
      // recognized concept, both sides have real concept representations:
      // a mismatch between them is a confident, deterministic conflict, and
      // falling back to lexical overlap here was the bug — an eligible
      // "stressful day at work" driver (tag: stress) could wrongly ground an
      // unrelated "hard training work session" claim (tag: hard_training)
      // just because both happen to mention "work".
      //
      // Lexical fallback is reserved for when the CLAIM's cause wording maps
      // to NO recognized concept at all (a paraphrase the fixed list doesn't
      // cover) — concept representation is genuinely unavailable for that
      // side, so a fuzzy vocabulary-overlap check against each driver is the
      // best available signal, not a bypass of a concept check that already
      // ran and disagreed.
      const claimedTags = causeConceptTags(sentence);
      const groundedInDriver = claimedTags.length > 0
        ? claimedTags.some((t) => eligibleTags.has(t))
        : drivers.some((d) => causalOverlapRatio(sentence, d) >= CAUSE_OVERLAP_THRESHOLD);
      if (!groundedInDriver) {
        violations.push({
          check: 'recovery_cause', field, sentence, severity: 'high',
          expected: drivers.length ? drivers.join('; ') : 'unknown — no eligible recovery driver',
          actual: 'an unsupported cause',
          message: drivers.length
            ? `attributes a cause to recovery that isn't among the eligible recovery drivers (${drivers.join('; ')})`
            : 'attributes a cause to recovery with no eligible recovery driver available — should say the cause is unknown instead of guessing',
        });
      }
    }
  }
  return violations;
}

// ── Effective workout ────────────────────────────────────────────────────────
// The production bug this whole layer chases: the brief prescribing the ORIGINAL
// scheduled hard session ("scale back today's Push", "crush your Pull") when
// recovery already downgraded it to something else. Fires only when the
// effective source is NOT the plain schedule and a sentence binds an action verb
// to the scheduled label.
const WORKOUT_ACTION_RE = /\b(scale back|ease off|crush|hit|do|tackle|power through|go hard on|push through|send)\b/i;
function checkEffectiveWorkout(result, facts) {
  const source = facts.effectiveWorkoutSource;
  const scheduled = facts.scheduledWorkoutLabel;
  const effective = facts.effectiveWorkoutLabel;
  // Only meaningful when the effective plan diverges from the schedule.
  if (!source || source === 'scheduled' || !scheduled || !effective) return [];
  if (String(scheduled).toLowerCase() === String(effective).toLowerCase()) return [];
  const violations = [];
  for (const [field, text] of briefFields(result)) {
    for (const sentence of splitIntoSentences(text)) {
      if (!WORKOUT_ACTION_RE.test(sentence)) continue;
      // Sentence is substantially about the SCHEDULED session and does NOT
      // acknowledge the swap (no mention of the effective session).
      const aboutScheduled = overlapRatio(sentence, scheduled) >= 0.5;
      const acknowledgesEffective = new RegExp(`\\b${String(effective).split(/\s+/)[0]}\\b`, 'i').test(sentence)
        || /\bswap|\bdowngrad|\bswitched|\breplaced|\beased/i.test(sentence);
      if (aboutScheduled && !acknowledgesEffective) {
        violations.push({
          check: 'effective_workout', field, sentence, severity: 'high',
          expected: `${effective} (${source})`, actual: scheduled,
          message: `prescribes the scheduled "${scheduled}" but today's effective session is "${effective}" (${source})`,
        });
      }
    }
  }
  return violations;
}

// ── Goal & commitment completion ─────────────────────────────────────────────
const COMPLETION_VERB_RE =
  /\b(?:is|are|was|were|has been|have been)\s+(?:done|complete|completed|finished|closed(?:\s+out)?|delivered|wrapped(?:\s+up)?|shipped)\b|\bchecked (?:it |that |this )?off\b|\bcrossed (?:it |that |this )?off\b|\bclosed (?:it|that|this) out\b/i;
const COMPLETION_OVERLAP_THRESHOLD = 0.6;

function checkCompletion(result, facts) {
  const openGoals = (facts.goals || []).filter((g) => g && (g.text) && !g.achieved);
  const openCommitments = (facts.commitments || []).filter((c) => c && c.title && c.status !== 'completed' && c.status !== 'done');
  const targets = [
    ...openGoals.map((g) => ({ kind: 'goal', text: g.text })),
    ...openCommitments.map((c) => ({ kind: 'commitment', text: c.title })),
  ];
  if (!targets.length) return [];
  const violations = [];
  for (const [field, text] of briefFields(result)) {
    for (const sentence of splitIntoSentences(text)) {
      if (!COMPLETION_VERB_RE.test(sentence)) continue;
      for (const t of targets) {
        if (overlapRatio(sentence, t.text) >= COMPLETION_OVERLAP_THRESHOLD) {
          violations.push({
            check: `${t.kind}_completion`, field, sentence, severity: 'high',
            expected: 'open', actual: 'described as done', goalText: t.text,
            message: `describes the still-open ${t.kind} "${t.text}" as completed`,
          });
        }
      }
    }
  }
  return violations;
}

// ── Experiment verdict ───────────────────────────────────────────────────────
const CONFIRM_VERB_RE = /\b(?:confirm(?:ed|s)?|prov(?:ed|en|es)|validated|worked|is working|paid off)\b/i;
function checkExperiments(result, facts) {
  const experiments = (facts.experiments || []).filter((e) => e && e.hypothesis);
  if (!experiments.length) return [];
  const violations = [];
  for (const [field, text] of briefFields(result)) {
    for (const sentence of splitIntoSentences(text)) {
      if (!CONFIRM_VERB_RE.test(sentence)) continue;
      for (const e of experiments) {
        // Only flag when the sentence is about THIS experiment AND its verdict
        // is not 'confirmed' (refuted / inconclusive / still running / none).
        if (overlapRatio(sentence, e.hypothesis) < 0.5) continue;
        if (e.verdict === 'confirmed') continue;
        violations.push({
          check: 'experiment_verdict', field, sentence, severity: 'low',
          expected: e.verdict ?? e.status ?? 'unproven', actual: 'described as confirmed',
          message: `describes experiment "${e.hypothesis}" as confirmed but its verdict is ${e.verdict ?? e.status ?? 'not yet decided'}`,
        });
      }
    }
  }
  return violations;
}

// ── Spending total ───────────────────────────────────────────────────────────
const SPEND_CONTEXT_RE = /\bspen[dt]|\bspending\b|\bthis month\b|\bmonth-to-date\b|\bmtd\b|\bbudget\b/i;
// An explicit month-to-date total must AGREE with the canonical rounded value —
// not merely land within a loose band. Allow only display rounding (2%, min $10);
// the old 20% tolerance would wave through a "$2,900" when the truth was $2,450.
const SPEND_TOLERANCE_FRAC = 0.02;
const SPEND_TOLERANCE_ABS = 10;
function checkSpending(result, facts) {
  const total = facts.spendingTotalMonth;
  if (total == null || !Number.isFinite(total) || total <= 0) return [];
  const allowed = Math.max(SPEND_TOLERANCE_ABS, total * SPEND_TOLERANCE_FRAC);
  const violations = [];
  for (const [field, text] of briefFields(result)) {
    for (const sentence of splitIntoSentences(text)) {
      if (!SPEND_CONTEXT_RE.test(sentence)) continue;
      const m = sentence.match(/\$\s?([\d,]+(?:\.\d+)?)/);
      if (!m) continue;
      const cited = Number(m[1].replace(/,/g, ''));
      if (!Number.isFinite(cited) || cited <= 0) continue;
      // Only flag a "total"/"spent" figure, not an arbitrary dollar amount
      // (a $12 coffee mention isn't a claim about the monthly total).
      if (!/\btotal|\bspen[dt]|\bmonth\b|\bmtd\b/i.test(sentence)) continue;
      if (Math.abs(cited - total) > allowed) {
        violations.push({
          check: 'spending_total', field, sentence, severity: 'high',
          expected: Math.round(total), actual: cited,
          message: `cites $${cited} spending but the canonical month-to-date total is $${Math.round(total)}`,
        });
      }
    }
  }
  return violations;
}

// ── Forecast grade / band ────────────────────────────────────────────────────
// The brief may not invent a different day-grade or tomorrow-lean than the
// forecast authority computed. Fires only when the brief states a grade/band in
// a forecast context that contradicts the canonical value.
const FORECAST_CONTEXT_RE = /\bforecast|\btoday'?s? (?:a |an )?(?:grade|[abcdf][+-]? day)|\btomorrow\b|\bday ahead\b|\bcapacity\b/i;
const GRADE_CLAIM_RE = /\b(?:grade\s+)?([ABCDF])[+-]?\s+day\b|\btoday'?s?\s+(?:an?\s+)?([ABCDF])[+-]?\b/i;
const BAND_WORD = { green: /\bgreen\b/i, yellow: /\byellow\b/i, red: /\bred\b/i };
function checkForecast(result, facts) {
  const grade = facts.forecastGrade;    // e.g. 'B-'
  const tomorrowBand = facts.tomorrowBand;
  if (!grade && !tomorrowBand) return [];
  const gradeLetter = grade ? String(grade).trim().charAt(0).toUpperCase() : null;
  const violations = [];
  for (const [field, text] of briefFields(result)) {
    for (const sentence of splitIntoSentences(text)) {
      if (!FORECAST_CONTEXT_RE.test(sentence)) continue;
      // Day-grade contradiction.
      if (gradeLetter) {
        const gm = sentence.match(GRADE_CLAIM_RE);
        const cited = gm ? (gm[1] || gm[2] || '').toUpperCase() : null;
        if (cited && cited !== gradeLetter) {
          violations.push({
            check: 'forecast_grade', field, sentence, severity: 'high',
            expected: grade, actual: cited,
            message: `calls today a "${cited}" day but the forecast grade is ${grade}`,
          });
        }
      }
      // Tomorrow-lean contradiction (only when the sentence is about tomorrow).
      if (tomorrowBand && /\btomorrow\b/i.test(sentence)) {
        for (const [band, re] of Object.entries(BAND_WORD)) {
          if (band !== tomorrowBand && re.test(sentence)) {
            violations.push({
              check: 'forecast_tomorrow', field, sentence, severity: 'high',
              expected: tomorrowBand, actual: band,
              message: `says tomorrow looks "${band}" but the forecast leans ${tomorrowBand}`,
            });
          }
        }
      }
    }
  }
  return violations;
}

// ── Current date / weekday ───────────────────────────────────────────────────
// A brief must not assert the wrong day. Narrow by design: only an explicit
// "today is <Weekday>" / "happy <Weekday>" / "it's <Weekday> morning" that
// contradicts the snapshot's local date is flagged — never an incidental "by
// Friday" reference to another day.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const TODAY_IS_RE = /\b(?:today is|it'?s|happy|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
function checkCurrentDate(result, facts) {
  if (!facts.localDate) return [];
  // Canonical weekday of the snapshot's local date (parse as a plain date; noon
  // UTC avoids any tz rollover on the YYYY-MM-DD string).
  const d = new Date(`${facts.localDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return [];
  const canonical = WEEKDAYS[d.getUTCDay()];
  const violations = [];
  for (const [field, text] of briefFields(result)) {
    for (const sentence of splitIntoSentences(text)) {
      const m = sentence.match(TODAY_IS_RE);
      if (!m) continue;
      const cited = m[1].toLowerCase();
      if (cited !== canonical) {
        violations.push({
          check: 'current_date', field, sentence, severity: 'high',
          expected: canonical, actual: cited,
          message: `says it's ${cited} but today (${facts.localDate}) is ${canonical}`,
        });
      }
    }
  }
  return violations;
}

/**
 * Validate a chief-brief result against canonical facts (from
 * brain/snapshot.js's canonicalFacts). Returns { violations, hasHighSeverity }.
 * Pure. When `facts` is null/empty, returns no violations (backward compatible —
 * callers without a snapshot still work, they just don't get the extra checks).
 */
function validateChiefBriefClaims(result, facts) {
  if (!result || !facts) return { violations: [], hasHighSeverity: false };
  const violations = [
    ...checkRecoveryBand(result, facts),
    ...checkRecoveryScore(result, facts),
    ...checkRecoveryCause(result, facts),
    ...checkEffectiveWorkout(result, facts),
    ...checkCompletion(result, facts),
    ...checkExperiments(result, facts),
    ...checkSpending(result, facts),
    ...checkForecast(result, facts),
    ...checkCurrentDate(result, facts),
  ];
  return { violations, hasHighSeverity: violations.some((v) => v.severity === 'high') };
}

/**
 * Deterministic last resort: when a correction retry STILL contradicts canonical
 * state, we must not ship the contradiction. Strip each offending sentence out of
 * the field it appears in (the safe neutralization — removing a false claim never
 * introduces a new one). Returns a NEW result; never mutates the input. Goal
 * completions are handled by the existing rewriteFalseGoalCompletions instead
 * (which rephrases rather than deletes), so this is only used for the other
 * claim classes.
 */
// Fields the Chief Brief card cannot render meaningfully without — shipping a
// blank string here is a worse user-facing failure than the false claim
// neutralization exists to remove (an empty card reads as broken, not just
// unhelpful). morningFocus/affirmation/openQuestion may legitimately end up
// empty (the UI already handles an absent optional field).
const REQUIRED_BRIEF_FIELDS = new Set(['synthesis', 'action', 'risk', 'move']);

/** A minimal, always-true, GROUNDED sentence for `field`, built ONLY from
 *  canonical facts (never invents anything they don't support). Last resort
 *  for neutralizeClaimViolations when stripping every offending sentence
 *  would otherwise leave a REQUIRED field blank. Deliberately plain — the
 *  goal is "never wrong", not "still compelling copy". */
function groundedFallbackSentence(field, facts) {
  const band = facts?.recoveryBand;
  const score = facts?.recoveryScore;
  const workout = facts?.effectiveWorkoutLabel;
  switch (field) {
    case 'synthesis':
      if (band) return `Recovery is ${band}${score != null ? ` at ${score}/100` : ''} today.`;
      return "Today's numbers are in — check the Health tab for the full picture.";
    case 'action':
      if (workout) return `Today's plan: ${workout}.`;
      return "Follow today's plan as scheduled.";
    case 'risk':
      return 'No specific risk flagged right now — stay attentive to how you feel today.';
    case 'move':
      return 'Keep it simple: work the plan and check back this evening.';
    default:
      return '';
  }
}

/**
 * Deterministically strip the exact offending sentence(s) out of each
 * violated field, so a false claim is removed without touching anything else
 * in that field. `facts` (canonical facts, same shape checks are run
 * against) is optional but required for the blank-field fallback below to
 * produce anything more than an empty string — pass it whenever available.
 */
function neutralizeClaimViolations(result, violations, facts = null) {
  if (!violations.length) return result;
  const cb = { ...(result?.chiefBrief || {}) };
  const out = { ...result, chiefBrief: cb };
  // Group offending sentences by field.
  const bySentenceField = new Map();
  for (const v of violations) {
    if (!v.field || !v.sentence) continue;
    if (!bySentenceField.has(v.field)) bySentenceField.set(v.field, new Set());
    bySentenceField.get(v.field).add(v.sentence.trim());
  }
  for (const [field, sentences] of bySentenceField) {
    const src = field === 'morningFocus' ? out.morningFocus : cb[field];
    if (typeof src !== 'string' || !src.trim()) continue;
    const kept = splitIntoSentences(src).filter((s) => !sentences.has(s.trim()));
    let rebuilt = kept.join(' ').trim();
    // Stripping every sentence in a REQUIRED field would ship a blank card —
    // strictly worse than the false claim it replaced (a broken-looking UI
    // instead of a wrong-but-plausible one). Fall back to a grounded,
    // deterministic, always-true statement instead of an empty string.
    if (!rebuilt && REQUIRED_BRIEF_FIELDS.has(field)) {
      rebuilt = groundedFallbackSentence(field, facts);
    }
    if (field === 'morningFocus') out.morningFocus = rebuilt;
    else cb[field] = rebuilt;
  }
  return out;
}

/**
 * Final backstop: guarantee every REQUIRED_BRIEF_FIELDS entry is a non-empty
 * string, no matter what upstream correction/neutralization did. Called after
 * finalizeSafe() so a blank field can never reach the client regardless of
 * WHY it went blank (every sentence violated, the LLM itself returned an
 * empty string, a malformed retry, etc.) — this is deliberately unconditional,
 * not keyed to a specific violation, since "is this field populated" is a
 * shape check, not a claim check.
 */
function ensureRequiredFieldsPresent(result, facts = null) {
  const cb = { ...(result?.chiefBrief || {}) };
  let changed = false;
  for (const field of REQUIRED_BRIEF_FIELDS) {
    if (typeof cb[field] !== 'string' || !cb[field].trim()) {
      cb[field] = groundedFallbackSentence(field, facts);
      changed = true;
    }
  }
  return changed ? { ...result, chiefBrief: cb } : result;
}

/** Build a targeted correction prompt describing the contradictions found, for
 *  the one-shot semantic-retry (same pattern as the goal-completion guard). */
function buildClaimCorrectionPrompt(basePrompt, violations) {
  const lines = violations.map(
    (v) => `- In "${v.field}" you wrote: "${v.sentence}" — this ${v.message}. Correct it to match the authoritative value (${JSON.stringify(v.expected)}); do not restate the false claim.`
  );
  return `${basePrompt}\n\nCORRECTION REQUIRED — your previous attempt contradicted authoritative NormOS state:\n${lines.join('\n')}\nRegenerate the FULL JSON response with these corrected. Every other fact must remain exactly as accurate as before; do not introduce any new error while fixing these.`;
}

module.exports = {
  validateChiefBriefClaims, buildClaimCorrectionPrompt, neutralizeClaimViolations,
  REQUIRED_BRIEF_FIELDS, groundedFallbackSentence, ensureRequiredFieldsPresent,
  // Exposed for focused unit tests:
  checkRecoveryBand, checkRecoveryScore, checkRecoveryCause, checkEffectiveWorkout,
  checkCompletion, checkExperiments, checkSpending, checkForecast, checkCurrentDate, briefFields,
};
