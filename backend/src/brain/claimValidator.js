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

function checkRecoveryBand(fields, facts) {
  const band = facts.recoveryBand;
  if (!band || !BAND_SYNONYMS[band]) return [];
  const violations = [];
  for (const [field, text] of fields) {
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
function checkRecoveryScore(fields, facts) {
  const score = facts.recoveryScore;
  if (score == null || !Number.isFinite(score)) return [];
  const violations = [];
  for (const [field, text] of fields) {
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

// The hazard this check exists for is inventing a cause for a recovery that
// came in LOW/reduced ("recovery dipped because of X" with no eligible X). A
// benign causal attribution for a GOOD recovery — "recovery is green at 90 on
// the back of a solid night's sleep" — is not a fabricated health claim:
// recovery is computed FROM sleep/HRV, so tying a strong number to a good
// night restates the reading rather than guessing an external driver. The old
// check fired on BOTH, so on a normal good-recovery morning the whole
// synthesis got neutralized to the bare grounded fallback ("Recovery is green
// at 90 today."), which (a) read as "just the recovery score" and (b) marked
// the brief DEGRADED, withholding the morning "ready" push and forcing a
// manual rebuild every day. Gate the check on an impaired-recovery framing so
// it still catches the invented-negative-cause case (every existing test) but
// no longer nukes a benign positive one. Every recovery_cause regression
// fixture uses "dipped"/"down"/"driven by" a decline, so this narrows nothing
// they cover.
const RECOVERY_IMPAIRMENT_RE = /\b(dip(?:s|ped|ping)?|drop(?:s|ped|ping)?|down|lower(?:ed)?|low\b|reduc(?:e|ed|es|tion)|suppress(?:ed|es)?|tank(?:ed|ing)?|slump(?:ed|ing)?|sagg?(?:ed|ing)?|under-?recover(?:ed|y)?|in the red|red band|yellow band|\byellow\b|took (?:a|the) hit|\bhit\b|weigh(?:ed|ing|s)?|soft(?:er)?|worse|poor(?:er)?|rough|strain(?:ed)?|elevated (?:resting|rhr|rest))/i;

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

function checkRecoveryCause(fields, facts) {
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
  for (const [field, text] of fields) {
    for (const sentence of splitIntoSentences(text)) {
      if (!RECOVERY_CONTEXT_RE.test(sentence)) continue;
      if (!CAUSAL_RE.test(sentence)) continue;
      // Only police a cause that's attached to an IMPAIRED recovery framing —
      // a benign positive attribution for a good number ("green at 90 thanks
      // to a solid night") is not a fabricated driver claim and must not be
      // neutralized to the bare grounded fallback (see RECOVERY_IMPAIRMENT_RE
      // above for the full rationale).
      if (!RECOVERY_IMPAIRMENT_RE.test(sentence)) continue;
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
function checkEffectiveWorkout(fields, facts) {
  const source = facts.effectiveWorkoutSource;
  const scheduled = facts.scheduledWorkoutLabel;
  const effective = facts.effectiveWorkoutLabel;
  // Only meaningful when the effective plan diverges from the schedule.
  if (!source || source === 'scheduled' || !scheduled || !effective) return [];
  if (String(scheduled).toLowerCase() === String(effective).toLowerCase()) return [];
  const violations = [];
  for (const [field, text] of fields) {
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

// ── Workout completion overclaim ────────────────────────────────────────────
// The prose-layer half of the "walk logged on an Intervals day" production
// bug: a sentence claiming the scheduled/effective workout was DONE when the
// canonical trainingOutcome (services/workout.js's resolveTrainingOutcome,
// via facts.plannedWorkoutCompleted) says it was NOT explicitly completed.
// Fires only when facts.plannedWorkoutCompleted is explicitly `false` — an
// absent/unknown fact (null/undefined, a caller without a trainingOutcome
// reading) never manufactures a violation, same backward-compatible pattern
// as every other check here — and only when the sentence is substantially
// about the effective workout (overlapRatio, same threshold as
// checkEffectiveWorkout) AND uses completion language not itself negated
// ("not done", "wasn't completed" must never be flagged — those are the
// CORRECT wording this check exists to make sure ships).
const WORKOUT_COMPLETION_VERB_RE = /\bdone\b|\bcompleted\b|\bfinished\b|\bcrushed\b|\bknocked out\b|\bwrapped up\b/i;
const WORKOUT_COMPLETION_NEGATION_BEFORE_RE = /\b(without|no|not|zero|isn'?t|wasn'?t|hasn'?t|haven'?t|didn'?t|wouldn'?t|never)\b[^.!?]{0,30}$/i;

function checkWorkoutCompletionOverclaim(fields, facts) {
  if (facts.plannedWorkoutCompleted !== false) return []; // only an explicit "not completed" fact licenses this check
  const label = facts.effectiveWorkoutLabel;
  if (!label || String(label).toLowerCase() === 'rest') return [];
  const violations = [];
  for (const [field, text] of fields) {
    for (const sentence of splitIntoSentences(text)) {
      if (overlapRatio(sentence, label) < 0.5) continue; // sentence isn't substantially about this workout
      const re = new RegExp(WORKOUT_COMPLETION_VERB_RE.source, 'gi');
      let m;
      while ((m = re.exec(sentence))) {
        const before = sentence.slice(0, m.index);
        if (WORKOUT_COMPLETION_NEGATION_BEFORE_RE.test(before)) continue; // negated — correct wording, not a violation
        violations.push({
          check: 'workout_completion_overclaim', field, sentence, severity: 'high',
          expected: `${label} not explicitly completed`, actual: 'described as done/completed',
          message: `describes "${label}" as done/completed, but it was not explicitly completed today (canonical trainingOutcome says plannedWorkoutCompleted=false)`,
        });
        break; // one violation per field is enough
      }
    }
  }
  return violations;
}

// ── Goal & commitment completion ─────────────────────────────────────────────
const COMPLETION_VERB_RE =
  /\b(?:is|are|was|were|has been|have been)\s+(?:done|complete|completed|finished|closed(?:\s+out)?|delivered|wrapped(?:\s+up)?|shipped)\b|\bchecked (?:it |that |this )?off\b|\bcrossed (?:it |that |this )?off\b|\bclosed (?:it|that|this) out\b/i;
const COMPLETION_OVERLAP_THRESHOLD = 0.6;

function checkCompletion(fields, facts) {
  const openGoals = (facts.goals || []).filter((g) => g && (g.text) && !g.achieved);
  const openCommitments = (facts.commitments || []).filter((c) => c && c.title && c.status !== 'completed' && c.status !== 'done');
  const targets = [
    ...openGoals.map((g) => ({ kind: 'goal', text: g.text })),
    ...openCommitments.map((c) => ({ kind: 'commitment', text: c.title })),
  ];
  if (!targets.length) return [];
  const violations = [];
  for (const [field, text] of fields) {
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

// ── Context Understanding Layer: ResolvedContext conflicts ──────────────────
// A single consolidated check, gated entirely on `facts.resolvedContext`
// being present (see brain/snapshot.js's canonicalFactsFrom) — absent means
// skip, same backward-compatible pattern as every other check here. Covers
// the general classes of ResolvedContext contradiction the design brief
// requires: negated/retracted events cited as if they happened, a
// completion state the user explicitly corrected, and a causal recovery
// claim naming a driver OTHER than the one the resolver's driver engine
// actually ranks (or asserting one at all when the resolver says unknown).
// Deliberately does NOT replace checkCompletion/checkRecoveryCause above —
// both keep running unconditionally on the legacy store-backed facts, so a
// caller with no resolvedContext (rollout fallback) keeps today's coverage
// unchanged; this check ADDS the resolver's stronger, corrected view on top.
const MEETING_LOAD_RE = /\bmeetings?\b|\bpacked\b|\bbusy\b|\bback-to-back\b/i;

function checkResolvedContextConflicts(fields, facts) {
  const resolved = facts?.resolvedContext;
  if (!resolved || !Array.isArray(resolved.assertions)) return [];
  const { getCompletionState, getDriversFor, getCalendarClassification } = require('../intelligence/context-resolver');
  const violations = [];

  // 1. Negated/retracted events cited as if they occurred — the resolver's
  // own record of what the user explicitly said did NOT happen or was
  // withdrawn, independent of (and stronger than) any lexical driver check.
  const negated = resolved.assertions.filter((a) => ['negated', 'retracted'].includes(a.eventStatus));
  for (const [field, text] of fields) {
    for (const sentence of splitIntoSentences(text)) {
      for (const a of negated) {
        const probe = a.predicate ? `${a.predicate} ${a.objectValue || ''}`.trim() : a.rawText;
        if (!probe || overlapRatio(sentence, probe) < 0.6) continue;
        violations.push({
          check: 'negated_event_cited', field, sentence, severity: 'high',
          expected: `${a.eventStatus} — did not occur`, actual: 'cited as if it happened',
          message: `cites "${probe}" as if it happened, but the user explicitly said this was ${a.eventStatus}`,
        });
      }
    }
  }

  // 2. Completion state the user explicitly corrected — a stronger, general
  // version of checkCompletion's store-only check: the resolver's most
  // recent user correction wins even when the underlying goal/commitment
  // store hasn't caught up yet (e.g. a correction just given seconds ago).
  const completionTargets = [
    ...(facts.goals || []).map((g) => ({ kind: 'goal', text: g.text })),
    ...(facts.commitments || []).map((c) => ({ kind: 'commitment', text: c.title })),
  ];
  if (completionTargets.length) {
    const { normalizeTargetId } = require('../intelligence/context-compiler');
    for (const t of completionTargets) {
      const state = getCompletionState(resolved, t.kind === 'goal' ? 'goal' : 'commitment', normalizeTargetId(t.text));
      if (!state || state.completed !== false) continue; // only an explicit "not completed" correction matters here
      for (const [field, text] of fields) {
        for (const sentence of splitIntoSentences(text)) {
          if (!COMPLETION_VERB_RE.test(sentence)) continue;
          if (overlapRatio(sentence, t.text) < COMPLETION_OVERLAP_THRESHOLD) continue;
          violations.push({
            check: 'completion_state_resolved', field, sentence, severity: 'high',
            expected: 'not completed (user correction)', actual: 'described as done', goalText: t.text,
            message: `describes "${t.text}" as completed, but the user explicitly said they did not complete it`,
          });
        }
      }
    }
  }

  // 3. Causal recovery claim naming a driver the resolver does NOT rank as
  // the top candidate — including the "resolver says unknown" case (a
  // driver claim with zero resolver-tracked candidates for
  // health:recovery_autonomic is unsupported, same principle as
  // checkRecoveryCause's empty-drivers branch, but sourced from the
  // resolver's evidence-tiered ranking rather than raw eligible annotations).
  const driverResult = getDriversFor(resolved, 'health:recovery_autonomic');
  for (const [field, text] of fields) {
    for (const sentence of splitIntoSentences(text)) {
      if (!RECOVERY_CONTEXT_RE.test(sentence) || !CAUSAL_RE.test(sentence)) continue;
      const claimedTags = causeConceptTags(sentence);
      if (!claimedTags.length) continue; // no recognized concept to compare — leave to checkRecoveryCause's lexical fallback
      const driverTags = driverResult.driver ? causeConceptTags(driverResult.driver) : [];
      const matchesTopDriver = driverTags.length > 0 && claimedTags.some((t) => driverTags.includes(t));
      if (matchesTopDriver) continue;
      violations.push({
        check: 'resolved_driver_conflict', field, sentence, severity: 'high',
        expected: driverResult.driver ? `${driverResult.driver} (${driverResult.evidenceBasis})` : 'unknown — no eligible driver in the resolver',
        actual: 'a different or unsupported cause',
        message: driverResult.driver
          ? `attributes recovery to a cause the resolver does not rank as the top driver (resolver: "${driverResult.driver}", ${driverResult.evidenceBasis})`
          : 'attributes a cause to recovery but the resolver has no eligible driver — should say the cause is unknown instead of guessing',
      });
    }
  }

  // 4. Calendar classification the user corrected — a block reclassified as
  // NOT a meeting (e.g. a Sabbath observance) still described in
  // meeting-load language.
  for (const a of resolved.assertions.filter((x) => x.assertionType === 'classification')) {
    const cls = getCalendarClassification(resolved, a.subject || a.objectValue);
    if (!cls || !cls.classification) continue;
    const saysNotMeeting = /not meetings?|isn'?t a meeting|not a meeting/i.test(cls.classification);
    if (!saysNotMeeting) continue;
    for (const [field, text] of fields) {
      for (const sentence of splitIntoSentences(text)) {
        if (!MEETING_LOAD_RE.test(sentence)) continue;
        if (overlapRatio(sentence, a.subject || a.objectValue || '') < 0.4) continue;
        violations.push({
          check: 'calendar_classification', field, sentence, severity: 'high',
          expected: cls.classification, actual: 'described as meeting load',
          message: `describes "${a.subject || a.objectValue}" as meeting load, but the user reclassified it: "${cls.classification}"`,
        });
      }
    }
  }

  return violations;
}

// ── Experiment verdict ───────────────────────────────────────────────────────
const CONFIRM_VERB_RE = /\b(?:confirm(?:ed|s)?|prov(?:ed|en|es)|validated|worked|is working|paid off)\b/i;
function checkExperiments(fields, facts) {
  const experiments = (facts.experiments || []).filter((e) => e && e.hypothesis);
  if (!experiments.length) return [];
  const violations = [];
  for (const [field, text] of fields) {
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
function checkSpending(fields, facts) {
  const total = facts.spendingTotalMonth;
  if (total == null || !Number.isFinite(total) || total <= 0) return [];
  const allowed = Math.max(SPEND_TOLERANCE_ABS, total * SPEND_TOLERANCE_FRAC);
  const violations = [];
  for (const [field, text] of fields) {
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
function checkForecast(fields, facts) {
  const grade = facts.forecastGrade;    // e.g. 'B-'
  const tomorrowBand = facts.tomorrowBand;
  if (!grade && !tomorrowBand) return [];
  const gradeLetter = grade ? String(grade).trim().charAt(0).toUpperCase() : null;
  const violations = [];
  for (const [field, text] of fields) {
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
function checkCurrentDate(fields, facts) {
  if (!facts.localDate) return [];
  // Canonical weekday of the snapshot's local date (parse as a plain date; noon
  // UTC avoids any tz rollover on the YYYY-MM-DD string).
  const d = new Date(`${facts.localDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return [];
  const canonical = WEEKDAYS[d.getUTCDay()];
  const violations = [];
  for (const [field, text] of fields) {
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

// ── EvidenceClaim overclaim (generic, cross-surface) ─────────────────────────
// The general form of checkExperiments' "described as confirmed" rule,
// driven by facts.claims (see brain/evidenceClaim.js's buildEvidenceClaims)
// instead of facts.experiments directly — so it also catches an OBSERVATION
// or ASSOCIATION claim (a self-model pattern, a knowledge-registry-backed
// recovery driver) being asserted as settled/proven, not just an
// experiment. Absent facts.claims (a caller that hasn't adopted the
// EvidenceClaim packet yet), this is silently a no-op — same
// backward-compatible pattern as every other check here. Only claims whose
// allowedLanguage is NOT already 'assertive' can be overclaimed — an
// association/observation is ALWAYS non-assertive by construction (see
// DEFAULT_LANGUAGE_FOR_TYPE), so this never double-flags what
// checkExperiments already covers for a confirmed experiment (its
// allowedLanguage IS 'assertive', so it's correctly excluded here).
const OVERCLAIM_VERB_RE = /\b(?:confirm(?:ed|s)?|prov(?:ed|en|es)|validated|is a proven|guarantee[sd]?)\b/i;
const OVERCLAIM_OVERLAP_THRESHOLD = 0.4;

function checkAssociationOverclaim(fields, facts) {
  const claims = Array.isArray(facts?.claims) ? facts.claims : null;
  if (!claims || !claims.length) return [];
  const weakClaims = claims.filter(
    (c) => (c.claimType === 'association' || c.claimType === 'observation') && c.allowedLanguage !== 'assertive'
  );
  if (!weakClaims.length) return [];
  const violations = [];
  for (const [field, text] of fields) {
    for (const sentence of splitIntoSentences(text)) {
      if (!OVERCLAIM_VERB_RE.test(sentence)) continue;
      for (const c of weakClaims) {
        const probe = typeof c.value === 'string' ? c.value : String(c.subject || '').replace(/^[a-z]+:/, '');
        if (!probe || overlapRatio(sentence, probe) < OVERCLAIM_OVERLAP_THRESHOLD) continue;
        violations.push({
          check: 'association_overclaim', field, sentence, severity: 'high',
          expected: `${c.claimType} (${c.evidenceTier}) — observational only`, actual: 'described as confirmed/proven',
          message: `describes "${probe}" as confirmed/proven, but it's only a ${c.claimType} (${c.evidenceTier}) — label it as observed/associated, not proof`,
        });
      }
    }
  }
  return violations;
}

// ── Weekly event count / episode date ────────────────────────────────────
// Generalization of the "two nights of alcohol + late meals (Wed/Thu)"
// production bug: a surface citing a night/occasion COUNT, or naming two or
// more distinct weekdays for what reads as one recurring event, must match
// intelligence/weeklyLedger.js's canonical episode ledger — never a count
// the LLM derived itself from reading raw per-row prose. Gated entirely on
// facts.weeklyLedger being present (only Weekly Review passes this), same
// backward-compatible no-op pattern as every other check here. Fully
// general: driven by causeConceptTags (the SAME concept vocabulary
// checkRecoveryCause already uses) and the ledger's own concept sets —
// nothing here is specific to any one concept.
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const NIGHT_COUNT_RE = /\b(one|two|three|four|five|six|seven|\d+)\s+(?:separate\s+|different\s+)?(nights?|times?|occasions?|evenings?)\b/i;
const WEEKDAY_RE = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;

function checkWeeklyEventCounts(fields, facts) {
  const ledger = facts?.weeklyLedger;
  if (!ledger || !Array.isArray(ledger.episodes)) return [];
  const violations = [];
  for (const [field, text] of fields) {
    for (const sentence of splitIntoSentences(text)) {
      const claimedTags = causeConceptTags(sentence);
      if (!claimedTags.length) continue; // no recognized concept named — nothing to check against the ledger
      const weekdaysNamed = new Set((sentence.match(WEEKDAY_RE) || []).map((w) => w.toLowerCase()));
      const nm = sentence.match(NIGHT_COUNT_RE);
      const claimedCount = nm
        ? (NUMBER_WORDS[nm[1].toLowerCase()] ?? Number(nm[1]))
        : (weekdaysNamed.size >= 2 ? weekdaysNamed.size : null);
      if (claimedCount == null || !Number.isFinite(claimedCount)) continue;
      const matchingEpisodes = ledger.episodes.filter((ep) => claimedTags.every((t) => ep.concepts.includes(t)));
      if (claimedCount !== matchingEpisodes.length) {
        violations.push({
          check: 'weekly_event_count', field, sentence, severity: 'high',
          expected: matchingEpisodes.length, actual: claimedCount,
          message: `claims ${claimedCount} night(s)/occasion(s) of ${claimedTags.join(' + ')} but the canonical weekly ledger supports ${matchingEpisodes.length} (dates: ${matchingEpisodes.map((ep) => ep.nightOf).join(', ') || 'none'})`,
        });
      }
    }
  }
  return violations;
}

// ── Temporal grounding: a historical observation is never a current/future plan ─
// Production bug: a late_meal context tag logged TWO NIGHTS AGO ("occurred on 1
// of the last 3 completed nights") got restated by the Chief Brief as "the
// late-meal flag tonight can dent sleep" and "with a late meal on deck tonight"
// — a completed-night OBSERVATION rewritten as an invented FUTURE plan.
// Generic by design (works for ANY concept intelligence/context-semantics.js's
// causeConceptTags recognizes — alcohol, travel, stress, etc. — not just
// late_meal): fires only when a sentence BOTH (a) names a recognized cause
// concept AND (b) frames it with current/future language, AND (c) is not
// itself advisory/conditional/negated ("avoid a late meal tonight", "if you
// eat late tonight…", "no late meal planned tonight" are all fine) — and even
// then, is a violation only when no CANONICAL planned evidence licenses the
// claim. A historical nightlyContextHistory occurrence — no matter how recent
// ("last night" included) — can NEVER supply that license on its own; only a
// genuine compiled ContextAssertion (facts.resolvedContext.assertions) with
// eventStatus 'planned', a matching concept, and an effective window
// overlapping TODAY can.
//
// Reuses context-semantics.js's own forward-looking vocabulary (FUTURE_RE)
// so "what counts as future framing" means the same thing everywhere in the
// codebase, rather than a second, possibly-drifting definition here.
const TEMPORAL_FUTURE_FRAME_RE =
  /\btonight\b|\btomorrow\b|\blater (today|tonight)\b|\bthis (evening|weekend)\b|\bnext (week|weekend|month)\b|\bgoing to\b|\bplan(?:ning)? to\b|\babout to\b|\bwill be\b|\bscheduled to\b|\bupcoming\b|\bon deck\b/i;
// Non-assertive framing that must NOT be flagged even alongside a concept +
// future marker: advice/caution, conditionals, and explicit negation. A false
// negative here (missing a real violation) is far safer than a false
// positive on legitimate advice — same precision-first philosophy as every
// other check in this file (see the module header).
const TEMPORAL_NON_ASSERTIVE_RE =
  /\b(?:avoid|skip|watch (?:out )?for|be careful|steer clear of|don'?t|do not|try not to|limit|reduce|cut back on|resist|if you|if there'?s|should you|in case|no|not planning|isn'?t planning|aren'?t planning|won'?t be|didn'?t|did not|wasn'?t|weren'?t)\b/i;

/** Pure: does a compiled, PLANNED ContextAssertion naming one of `conceptTags`
 *  cover TODAY (facts.localDate)? Only this — never a historical
 *  nightlyContextHistory occurrence — can license an affirmative
 *  current/future claim. */
function hasCanonicalFutureEvidence(facts, conceptTags) {
  const assertions = facts?.resolvedContext?.assertions;
  if (!Array.isArray(assertions) || !assertions.length) return false;
  const today = facts?.localDate || null;
  const dayOf = (iso) => {
    const t = iso ? new Date(iso).getTime() : NaN;
    return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
  };
  return assertions.some((a) => {
    if (!a || a.eventStatus !== 'planned') return false;
    const aConcepts = Array.isArray(a.concepts) ? a.concepts : [];
    if (!conceptTags.some((t) => aConcepts.includes(t))) return false;
    if (!today) return true; // no local date to compare against — don't over-reject genuine evidence
    return dayOf(a.effectiveStart) === today || dayOf(a.effectiveEnd) === today;
  });
}

function checkTemporalFraming(fields, facts) {
  if (!facts) return [];
  const violations = [];
  for (const [field, text] of fields) {
    for (const sentence of splitIntoSentences(text)) {
      if (!TEMPORAL_FUTURE_FRAME_RE.test(sentence)) continue;
      const concepts = causeConceptTags(sentence);
      if (!concepts.length) continue;
      if (TEMPORAL_NON_ASSERTIVE_RE.test(sentence)) continue;
      if (hasCanonicalFutureEvidence(facts, concepts)) continue;
      const marker = TEMPORAL_FUTURE_FRAME_RE.exec(sentence)?.[0] ?? 'a future marker';
      violations.push({
        check: 'temporal_framing', field, sentence, severity: 'high',
        expected: 'a historical observation, or genuine planned-event evidence',
        actual: 'an unsupported current/future claim',
        message: `frames a historical ${concepts.join('/')} observation as a current/future plan ("${marker}") with no canonical planned-event evidence to support it`,
      });
    }
  }
  return violations;
}

/**
 * Run every claim check against an arbitrary set of generated text fields.
 * `fields` is an array of [fieldName, text] pairs — the shared shape every
 * surface (Chief Brief via briefFields(), Evening Brief, Ask) normalizes its
 * own output into before validating. Pure. `facts` absent/null returns no
 * violations (every check below independently no-ops on a missing fact, so
 * this is redundant safety, not load-bearing).
 */
function validateClaims(fields, facts) {
  if (!fields || !facts) return [];
  return [
    ...checkRecoveryBand(fields, facts),
    ...checkRecoveryScore(fields, facts),
    ...checkRecoveryCause(fields, facts),
    ...checkEffectiveWorkout(fields, facts),
    ...checkWorkoutCompletionOverclaim(fields, facts),
    ...checkCompletion(fields, facts),
    ...checkExperiments(fields, facts),
    ...checkSpending(fields, facts),
    ...checkForecast(fields, facts),
    ...checkCurrentDate(fields, facts),
    ...checkResolvedContextConflicts(fields, facts),
    ...checkAssociationOverclaim(fields, facts),
    ...checkWeeklyEventCounts(fields, facts),
    ...checkTemporalFraming(fields, facts),
  ];
}

/**
 * Validate a chief-brief result against canonical facts (from
 * brain/snapshot.js's canonicalFacts). Returns { violations, hasHighSeverity }.
 * Pure. When `facts` is null/empty, returns no violations (backward compatible —
 * callers without a snapshot still work, they just don't get the extra checks).
 * A thin wrapper over validateClaims(briefFields(result), facts) — kept as
 * its own function (rather than inlined at every Chief Brief call site) so
 * this module's existing public API and behavior are 100% unchanged by the
 * EvidenceClaim generalization.
 */
function validateChiefBriefClaims(result, facts) {
  if (!result || !facts) return { violations: [], hasHighSeverity: false };
  const violations = validateClaims(briefFields(result), facts);
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
      // Bare score, never "NN/100": the headline states the number itself
      // ("Recovery is green at 90 today."), not a fraction — the "/100" reads
      // as clutter in a headline and is what the daily brief must never show.
      if (band) return `Recovery is ${band}${score != null ? ` at ${score}` : ''} today.`;
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
 * Same sentence-level neutralization as neutralizeClaimViolations, but for a
 * FLAT `{ fieldName: string }` object — Evening Brief's composed result and
 * Ask's single `answer` field (wrapped as `{ answer: text }`) instead of the
 * Chief Brief's nested `{ chiefBrief: {...}, morningFocus }` shape. Strips
 * exactly the offending sentence(s) out of each violated field; never
 * mutates the input. `requiredFields` names fields that must never end up
 * blank (default: none — Ask/Evening Brief have no Chief-Brief-style "the
 * card breaks if this is empty" requirement for every field); `fallbackFor`
 * supplies the grounded replacement text for a required field that would
 * otherwise go blank.
 */
function neutralizeClaimsGeneric(fieldsObj, violations, { requiredFields = new Set(), fallbackFor = () => '' } = {}) {
  if (!violations.length) return fieldsObj;
  const out = { ...fieldsObj };
  const bySentenceField = new Map();
  for (const v of violations) {
    if (!v.field || !v.sentence) continue;
    if (!bySentenceField.has(v.field)) bySentenceField.set(v.field, new Set());
    bySentenceField.get(v.field).add(v.sentence.trim());
  }
  for (const [field, sentences] of bySentenceField) {
    const src = out[field];
    if (typeof src !== 'string' || !src.trim()) continue;
    const kept = splitIntoSentences(src).filter((s) => !sentences.has(s.trim()));
    let rebuilt = kept.join(' ').trim();
    if (!rebuilt && requiredFields.has(field)) rebuilt = fallbackFor(field);
    out[field] = rebuilt;
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

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/** True iff `text` is EXACTLY the deterministic grounded-fallback sentence for
 *  `field` (the sentence neutralizeClaimViolations/ensureRequiredFieldsPresent
 *  ship when a field would otherwise go blank) — the authoritative signal that
 *  this field's content was NOT actually generated fresh this build. */
function isGroundedFallbackText(field, text, facts) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed === groundedFallbackSentence(field, facts).trim();
}

// Meaningful LOWER bounds, not exact-length requirements — a synthesis
// prompted for "20-35 words" that comes back at 3-4 words is underfilled even
// though it's technically non-empty and not a byte-for-byte fallback match;
// these thresholds sit comfortably below the prompt's own target so normal
// stylistic variance never trips them, while still catching a degenerately
// short response. synthesis's floor is set well above the shortest grounded
// fallback ("Recovery is green at 100 today." = 6 words) specifically so
// a near-fallback-length synthesis is still flagged even on the rare occasion
// it isn't a byte-for-byte match.
const REQUIRED_FIELD_MIN_WORDS = { synthesis: 12, action: 4, risk: 4, move: 4 };
const OPTIONAL_FIELD_MIN_WORDS = { affirmation: 5, morningFocus: 15 };

/**
 * THE authoritative Chief Brief quality contract — one pure function every
 * producer and consumer of a chief brief runs through: generateChiefBrief,
 * the full briefing build, the scoped Chief Brief rebuild, persistence,
 * "was today's brief actually built", and automatic morning push eligibility.
 * A brief is not "fresh" merely because every field is a non-empty string —
 * this also rejects the exact grounded-fallback sentences, enforces sensible
 * minimum completeness per field, and refuses to call anything fresh that
 * still contradicts canonical facts. Pure; never throws; never logs or
 * returns generated prose — only safe, decision-shaped metadata.
 *
 * @param {Object} result  a chief-brief result, `{ chiefBrief: {...}, morningFocus }`
 * @param {Object} facts   canonical facts (brain/snapshot.js's canonicalFacts), or null
 * @returns {{status: 'fresh'|'degraded'|'failed', reasonCodes: string[],
 *            fieldWordCounts: Object<string,number>, fallbackFields: string[],
 *            violatedChecks: string[]}}
 */
function assessChiefBriefQuality(result, facts = null) {
  const cb = result?.chiefBrief;
  if (!cb || typeof cb !== 'object') {
    return { status: 'failed', reasonCodes: ['no_chief_brief'], fieldWordCounts: {}, fallbackFields: [], violatedChecks: [] };
  }

  const reasonCodes = [];
  const fallbackFields = [];
  const fieldWordCounts = {};

  let missingRequired = false;
  for (const field of REQUIRED_BRIEF_FIELDS) {
    const text = cb[field];
    if (typeof text !== 'string' || !text.trim()) {
      reasonCodes.push(`${field}_missing`);
      missingRequired = true;
      continue;
    }
    fieldWordCounts[field] = wordCount(text);
    if (isGroundedFallbackText(field, text, facts)) fallbackFields.push(field);
  }
  for (const field of Object.keys(OPTIONAL_FIELD_MIN_WORDS)) {
    const text = field === 'morningFocus' ? result?.morningFocus : cb[field];
    if (typeof text === 'string' && text.trim()) fieldWordCounts[field] = wordCount(text);
  }

  if (missingRequired) {
    return { status: 'failed', reasonCodes, fieldWordCounts, fallbackFields, violatedChecks: [] };
  }

  if (fallbackFields.length) reasonCodes.push('grounded_fallback_used');

  for (const [field, min] of Object.entries(REQUIRED_FIELD_MIN_WORDS)) {
    if ((fieldWordCounts[field] ?? 0) < min) reasonCodes.push(`${field}_underfilled`);
  }
  for (const [field, min] of Object.entries(OPTIONAL_FIELD_MIN_WORDS)) {
    if (fieldWordCounts[field] != null && fieldWordCounts[field] < min) reasonCodes.push(`${field}_underfilled`);
  }

  // Claim correctness — never call a contradiction "fresh" merely because it's
  // long enough. High-severity survivors mean neutralizeClaimViolations either
  // wasn't run or the retry loop is being bypassed by a caller; treat exactly
  // like a fallback would be treated (degraded, not fresh).
  const { violations, hasHighSeverity } = validateChiefBriefClaims(result, facts);
  const violatedChecks = hasHighSeverity ? violations.filter((v) => v.severity === 'high').map((v) => v.check) : [];
  if (hasHighSeverity) reasonCodes.push('unresolved_claim_violation');

  const degraded = fallbackFields.length > 0
    || hasHighSeverity
    || reasonCodes.some((r) => r.endsWith('_underfilled'));

  return { status: degraded ? 'degraded' : 'fresh', reasonCodes, fieldWordCounts, fallbackFields, violatedChecks };
}

/** Build a targeted retry prompt asking specifically for fuller content on the
 *  fields the quality contract flagged as underfilled/fallback — used for the
 *  ONE bounded quality retry (never an unbounded watcher loop). Deliberately
 *  does not restate any generated prose, only which fields and why. */
function buildQualityRetryPrompt(basePrompt, quality) {
  const lines = quality.reasonCodes
    .filter((r) => r.endsWith('_underfilled') || r === 'grounded_fallback_used')
    .map((r) => {
      if (r === 'grounded_fallback_used') {
        return `- ${quality.fallbackFields.join(', ')}: came back as a minimal placeholder sentence, not real generated content — write full, specific content grounded in the context above.`;
      }
      const field = r.replace(/_underfilled$/, '');
      return `- ${field}: too short/thin for what was asked — follow the field's word-count guidance above and give it real substance.`;
    });
  return `${basePrompt}\n\nQUALITY RETRY — your previous attempt was schema-valid but under-filled:\n${lines.join('\n')}\nRegenerate the FULL JSON response with these fields properly filled out. Every other fact must remain exactly as accurate as before.`;
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
  // Chief Brief quality contract — fresh/degraded/failed, the authoritative
  // "was this actually a good build" check (see brief-quality docs at its
  // definition above).
  assessChiefBriefQuality, buildQualityRetryPrompt, isGroundedFallbackText,
  // EvidenceClaim v1 — the shared, surface-agnostic entrypoints Evening Brief
  // and Ask use (see notify/evening-brief-validator.js, chat/ask.js).
  validateClaims, neutralizeClaimsGeneric, checkAssociationOverclaim,
  // Exposed for focused unit tests:
  checkRecoveryBand, checkRecoveryScore, checkRecoveryCause, checkEffectiveWorkout,
  checkWorkoutCompletionOverclaim,
  checkCompletion, checkExperiments, checkSpending, checkForecast, checkCurrentDate, briefFields,
  checkResolvedContextConflicts, checkWeeklyEventCounts, splitIntoSentences,
  checkTemporalFraming,
};
