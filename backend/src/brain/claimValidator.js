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
function neutralizeClaimViolations(result, violations) {
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
    const rebuilt = kept.join(' ').trim();
    if (field === 'morningFocus') out.morningFocus = rebuilt;
    else cb[field] = rebuilt;
  }
  return out;
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
  // Exposed for focused unit tests:
  checkRecoveryBand, checkRecoveryScore, checkEffectiveWorkout,
  checkCompletion, checkExperiments, checkSpending, checkForecast, checkCurrentDate, briefFields,
};
