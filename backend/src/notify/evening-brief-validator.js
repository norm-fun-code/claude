// Deterministic post-generation guard for the evening brief's LLM prose pass —
// the evening-brief counterpart to brain/claimValidator.js. The LLM may choose
// emphasis and wording, but it may NOT violate the evening brief's hard rules
// (see notify/evening-brief.js's SYSTEM prompt): a rest day is not evidence of
// low steps, steps are never a hard workout, and a free tomorrow is never
// evidence that shortening sleep tonight is harmless.
//
// Same precision-first design as claimValidator.js: each check fires only on
// a specific, unambiguous violation — never a style preference. When a field
// violates a rule, it is replaced wholesale with the corresponding field from
// the deterministic fallback (composeFallback), which is built from the same
// canonical facts and is guaranteed to already satisfy these rules.
//
// EvidenceClaim v1 (audit recommendation): the 3 hard-rule checks above are
// evening-brief-specific and stay exactly as they were. ADDED on top: the
// SAME shared, cross-surface completion/resolved-context checks Chief Brief
// runs (brain/claimValidator.js's checkCompletion/checkResolvedContextConflicts)
// — so "plan" (which grades today's commitments/session against what was
// asked of it) can never describe a still-open commitment as done, or cite a
// context item the user has since retracted/corrected, using the exact same
// canonical evidence and the exact same deterministic rules Chief Brief and
// Ask are held to. See buildEveningEvidenceFacts below for how the evening
// brief's own `signals` object is projected into that shared fact shape.
'use strict';

const { checkCompletion, checkResolvedContextConflicts } = require('../brain/claimValidator');
const { buildEvidenceClaims } = require('../brain/evidenceClaim');

const LIGHT_WORDS_RE = /\blight(?:er)?\b|\blow(?:er)?\b|\bminimal(?:ly)?\b|\bbarely (?:any )?moved\b|\bnot much movement\b/i;
const RESTDAY_CONTEXT_RE = /\brest day\b/i;

/** true = steps confirmed below baseline (light language is accurate), false =
 *  at/above baseline, null = no baseline to judge against (never "low" then). */
function stepsAreLow(facts) {
  const steps = facts?.load?.steps;
  const baseline = facts?.load?.stepsBaseline;
  if (steps == null || baseline == null) return null;
  return steps < baseline;
}

/** Rule 1: a rest day means no planned hard TRAINING — it must never make
 *  substantial/at-or-above-baseline (or baseline-unknown) steps get described
 *  as light/low/lighter. */
function checkRestDayStepsMislabeled(fields, facts) {
  if (!facts?.isRestDay) return [];
  if (stepsAreLow(facts) === true) return []; // genuinely below baseline — accurate
  const violations = [];
  for (const [field, text] of fields) {
    if (!text) continue;
    if (RESTDAY_CONTEXT_RE.test(text) && LIGHT_WORDS_RE.test(text)) {
      violations.push({
        check: 'rest_day_steps_mislabeled', field, text,
        message: 'describes steps as light/low because of the rest day, without a baseline that supports it — a rest day means no planned training, not low steps',
      });
    }
  }
  return violations;
}

const HARD_WORKOUT_RE = /\b(hard workout|crushed (?:a |the )?(?:workout|session)|structured training session|intense (?:training session|workout)|smashed (?:a |the )?(?:workout|session)|killer (?:workout|session))\b/gi;
// A match preceded closely by a negation ("without adding structured training
// session", "no hard workout") is describing the ABSENCE of training — the
// desired, correct language on a rest day — not claiming one happened.
const NEGATION_BEFORE_RE = /\b(without|no|not|zero|isn'?t|wasn'?t)\b[^.!?]{0,25}$/i;

/** Rule 2: steps/general movement must never be described as if they were a
 *  completed hard/structured workout when no training session was logged. */
function checkStepsDescribedAsWorkout(fields, facts) {
  if (facts?.training?.completed) return []; // a real session happened — no violation possible
  const violations = [];
  for (const [field, text] of fields) {
    if (!text) continue;
    HARD_WORKOUT_RE.lastIndex = 0;
    let m;
    while ((m = HARD_WORKOUT_RE.exec(text))) {
      const before = text.slice(0, m.index);
      if (NEGATION_BEFORE_RE.test(before)) continue; // negated — not a violation
      violations.push({
        check: 'steps_described_as_workout', field, text,
        message: 'describes steps/movement as a hard or structured workout, but no training session was logged today',
      });
      break; // one violation per field is enough
    }
  }
  return violations;
}

const DAYOFF_MENTION_RE = /\bday off\b|\btomorrow'?s? (?:free|open)\b/i;
const PERMISSION_RE = /\bmore room\b|\bstay up\b|\bno rush\b|\bsleep in\b|\bloosen\b|\bdoesn'?t matter\b|\bno cost\b|\bslack tonight\b|\bcan afford\b/i;

/** Rule 3: a free/day-off tomorrow must never be cited as evidence that
 *  shortening sleep tonight is harmless. */
function checkDayOffUsedAsSleepPermission(fields) {
  const violations = [];
  for (const [field, text] of fields) {
    if (!text) continue;
    if (DAYOFF_MENTION_RE.test(text) && PERMISSION_RE.test(text)) {
      violations.push({
        check: 'dayoff_sleep_permission', field, text,
        message: 'treats a free/day-off tomorrow as a reason reduced sleep tonight is harmless',
      });
    }
  }
  return violations;
}

const CHECKED_FIELDS = ['today', 'plan', 'tomorrow', 'readiness'];

function fieldEntries(result) {
  return CHECKED_FIELDS.map((f) => [f, typeof result?.[f] === 'string' ? result[f] : '']);
}

/**
 * Project the evening brief's own `signals` object into the SAME canonical
 * facts shape brain/snapshot.js's canonicalFactsFrom produces for Chief
 * Brief/Ask — only the parts evening-brief prose can actually reference
 * (goals, commitments, resolvedContext; deliberately NOT recovery/spending/
 * forecast, which the evening brief never cites — see its own SYSTEM
 * prompt's "never call it recovery" rule). Every input here is itself
 * already canonical: `signals.evidenceGoals`/`signals.resolvedContext` are
 * fetched straight from store/goals and context-resolver.js by
 * runEveningHealthBrief (see notify/evening-brief.js), never derived from
 * this module. `signals.commitments` (todaySummary's {done, open, skipped}
 * shape) is flattened into the {title, status} list checkCompletion expects
 * — anything not literally 'done' counts as still-open, so a SKIPPED
 * commitment described as done is caught exactly like an open one.
 */
function buildEveningEvidenceFacts(signals) {
  const goals = (signals?.evidenceGoals || []).map((g) => ({ text: g.text, achieved: g.achieved === true }));
  const c = signals?.commitments || {};
  const commitments = [
    ...(c.done || []).map((x) => ({ title: x.title, status: 'done' })),
    ...(c.open || []).map((x) => ({ title: x.title, status: 'open' })),
    ...(c.skipped || []).map((x) => ({ title: x.title, status: 'skipped' })),
  ];
  const resolvedContext = signals?.resolvedContext || null;
  const facts = { goals, commitments, resolvedContext };
  facts.claims = buildEvidenceClaims(facts);
  return facts;
}

/**
 * Validate an evening-brief result against canonical facts (the same
 * `signals` object passed to composeFallback/buildPrompt). Returns an array
 * of violations (empty when clean). Pure.
 */
function validateEveningBriefClaims(result, facts) {
  const fields = fieldEntries(result);
  const evidenceFacts = buildEveningEvidenceFacts(facts);
  return [
    ...checkRestDayStepsMislabeled(fields, facts),
    ...checkStepsDescribedAsWorkout(fields, facts),
    ...checkDayOffUsedAsSleepPermission(fields),
    ...checkCompletion(fields, evidenceFacts),
    ...checkResolvedContextConflicts(fields, evidenceFacts),
  ];
}

/**
 * Replace each violated field wholesale with the corresponding field from the
 * deterministic fallback (already guaranteed to satisfy these rules — built
 * from the same canonical facts). Never mutates the input.
 */
function neutralizeEveningBriefViolations(result, violations, fallback) {
  if (!violations.length) return result;
  const out = { ...result };
  for (const v of violations) {
    out[v.field] = fallback?.[v.field] ?? '';
  }
  return out;
}

module.exports = {
  validateEveningBriefClaims,
  neutralizeEveningBriefViolations,
  buildEveningEvidenceFacts,
  // Exposed for focused unit tests:
  checkRestDayStepsMislabeled, checkStepsDescribedAsWorkout, checkDayOffUsedAsSleepPermission,
};
