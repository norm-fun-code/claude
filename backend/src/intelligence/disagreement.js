// DISAGREEMENT — the part of a chief of staff that tells you what you don't
// want to hear.
//
// Everything else in NormOS is on your side in the easy way: it summarizes,
// it explains, it encourages. Nothing in it has ever held you to something you
// said. A real chief of staff notices when you have written the same goal on
// the whiteboard for six weeks and crossed it off none of them, and says so —
// not as nagging, but because at that point one of two things is true and it
// matters which: either the goal isn't actually what you want, or the plan for
// reaching it is broken. Both are fixable. Quietly re-writing it a seventh
// time is not.
//
// WHY THIS SOURCE, AND NO OTHER. The evidence is `weekly_intentions`: the
// goals you wrote yourself, and the achieved/missed verdict you gave them
// yourself in the Sunday review. That is the entire input. This module never
// infers your behavior from a proxy metric, never scores you against a
// standard you didn't set, and never second-guesses a verdict you recorded.
// It only ever says: here is what you wrote, here is how you graded it, N
// times. That makes the claim genuinely uncontestable — the one property that
// separates a useful confrontation from an app being rude to you.
//
// THE ANTI-NAG CONTRACT. A confrontation that fires too easily is worse than
// none: it teaches you to ignore the surface. So every gate below is a reason
// to STAY SILENT, and the module's normal output is nothing at all.
//
//   * A one-off miss is not a pattern. A goal must be repeated.
//   * A goal you're currently succeeding at is never raised, no matter how
//     bad its history — the pattern has broken, and that is the outcome
//     wanted, not a debt to keep collecting on.
//   * Weeks you never graded are excluded from the verdict entirely rather
//     than counted as failures. Not reviewing a week isn't a confession.
//   * Every instance names its real week, so you can check it.
//   * The output ends in a question with real options, never a judgement.
//     "Change the plan or change the goal?" is the whole point; "you keep
//     failing at this" is the failure mode.
'use strict';

const { overlapScore } = require('./context-semantics');

// --- Gates. Each one is a reason to say nothing. --------------------------

/** Weeks of history considered. Long enough that a genuine multi-month
 *  pattern is visible, short enough that a goal abandoned last spring isn't
 *  dredged up. */
const WINDOW_WEEKS = 16;
/** How alike two weeks' goal text must be to count as the same intention.
 *  Uses the SAME overlapScore the retraction matcher uses — one text-similarity
 *  rule in this codebase, not a second one tuned by hand here. */
const SAME_GOAL_THRESHOLD = 0.6;
/** Below this many statements it is a plan that changed, not a pattern. */
const MIN_STATEMENTS = 3;
/** Weeks that were actually GRADED (achieved recorded either way). Without
 *  enough of these there is no verdict to report, only silence to interpret. */
const MIN_GRADED = 3;
/** Share of graded weeks missed before the gap is worth raising at all. */
const MIN_MISS_RATE = 0.6;
/** Recent graded weeks examined for a break in the pattern. A goal being hit
 *  again is the point of the whole exercise — never confront a comeback. */
const RECOVERY_LOOKBACK = 2;
/** After you resolve a disagreement, how many NEW statements of the same goal
 *  it takes before it may be raised again.
 *
 *  Both halves of this matter. Without suppression the surface would repeat
 *  itself weekly and get muted. Without re-activation it could be permanently
 *  escaped by tapping a button once, which would make the whole thing
 *  decorative. Reusing dismissed_insights.context — added for exactly this
 *  "suppressed until materially new evidence appears" rule (migration 065) —
 *  rather than inventing a second suppression mechanism. */
const RESTATEMENTS_BEFORE_RERAISE = 3;

// --- Pure core -----------------------------------------------------------

/**
 * Normalize a week key to YYYY-MM-DD.
 *
 * Not cosmetic. `weekly_intentions.week_start` is a Postgres `date`, which
 * node-pg parses into a JS Date at LOCAL midnight — so a naive
 * String(value).slice(0, 10) yields "Sun Sep 06". That would render as
 * nonsense on the card, and far worse, the newest-first ordering below is a
 * plain string compare: sorting "Sun Sep 06" against "Sun Aug 30" orders by
 * WEEKDAY NAME, which silently breaks the comeback check that depends on
 * knowing which weeks are the recent ones.
 *
 * Local date components, not toISOString, because the value is local midnight:
 * converting to UTC would roll it to the previous day anywhere east of
 * Greenwich.
 */
function toDayKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * Flatten intentions into one row per (week, goal), newest first.
 * `achieved` stays tri-state on purpose: true, false, or null for a week that
 * was never reviewed. Collapsing null into false would turn "you didn't do
 * your Sunday review" into "you failed", which is a different and unfair claim.
 *
 * @param {Array<{weekStart: string, goals: Array<{text: string, achieved?: boolean}>}>} intentions
 */
function flattenGoalStatements(intentions) {
  const out = [];
  for (const wk of intentions || []) {
    const weekStart = toDayKey(wk?.weekStart);
    if (!weekStart) continue;
    for (const g of wk.goals || []) {
      const text = String(g?.text || '').trim();
      if (!text) continue;
      out.push({
        weekStart,
        text,
        achieved: g.achieved === true ? true : g.achieved === false ? false : null,
      });
    }
  }
  return out.sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));
}

/**
 * Group statements that are the same intention worded differently ("morning
 * training", "train in the AM", "AM workouts").
 *
 * Greedy single-link grouping against each group's FIRST (most recent)
 * member, which keeps the label the user's most current phrasing — the wording
 * they'll recognise. Statements are pre-sorted newest-first by
 * flattenGoalStatements, so this is deterministic.
 */
function groupByIntent(statements, threshold = SAME_GOAL_THRESHOLD) {
  const groups = [];
  for (const s of statements || []) {
    const hit = groups.find((g) => overlapScore(g.label, s.text) >= threshold);
    if (hit) hit.statements.push(s);
    else groups.push({ label: s.text, statements: [s] });
  }
  return groups;
}

/**
 * Score one grouped intention, and decide whether it is worth raising.
 *
 * Returns null — the normal answer — whenever any gate fails. The `reason`
 * on a rejection is deliberately not surfaced to the user; it exists so the
 * diagnostic endpoint can explain a silence.
 *
 * @returns {{label, statements, graded, missed, achieved, unreviewed, missRate,
 *            weeksStated, weeksMissed, recentAchieved}|null}
 */
function assessIntent(group, {
  minStatements = MIN_STATEMENTS,
  minGraded = MIN_GRADED,
  minMissRate = MIN_MISS_RATE,
  recoveryLookback = RECOVERY_LOOKBACK,
} = {}) {
  const statements = group?.statements || [];
  if (statements.length < minStatements) return null;

  const graded = statements.filter((s) => s.achieved !== null);
  if (graded.length < minGraded) return null;

  const missed = graded.filter((s) => s.achieved === false);
  const missRate = missed.length / graded.length;
  if (missRate < minMissRate) return null;

  // A comeback ends the matter. If the most recent graded weeks were hits,
  // the pattern has broken and raising its history would be collecting on a
  // debt already paid — the single fastest way to make this surface feel
  // punitive rather than useful.
  const recent = graded.slice(0, recoveryLookback);
  if (recent.length && recent.every((s) => s.achieved === true)) return null;

  return {
    label: group.label,
    weeksStated: statements.map((s) => s.weekStart),
    weeksMissed: missed.map((s) => s.weekStart),
    statements: statements.length,
    graded: graded.length,
    missed: missed.length,
    achieved: graded.length - missed.length,
    unreviewed: statements.length - graded.length,
    missRate: Math.round(missRate * 100) / 100,
    recentAchieved: recent.filter((s) => s.achieved === true).length,
  };
}

/**
 * The confrontation itself, as structured fields — never a rendered
 * paragraph. Presentation belongs to the client (and the Ask prompt), and
 * keeping it structured is what stops the wording drifting into a verdict.
 *
 * `question` is the entire product thesis in one line: this surface exists to
 * force a choice between two honest options, not to record a failure.
 */
/** Stable, wording-tolerant key for one intention's resolution state. Derived
 *  from the goal's significant words (sorted), so re-phrasing "morning
 *  training" as "training in the morning" does NOT silently reset a
 *  suppression the user already made a decision about. */
function resolutionKey(label) {
  const { significantWords } = require('./context-semantics');
  return `disagreement:${[...new Set(significantWords(label))].sort().join('-') || 'unlabelled'}`;
}

function composeDisagreement(assessment, { snapshotId = null } = {}) {
  if (!assessment) return null;
  const { label, statements, graded, missed, achieved, unreviewed, weeksStated, weeksMissed } = assessment;
  return {
    stableId: `disagreement:${snapshotId ?? 'none'}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`,
    // The durable identity across days and re-phrasings — what a resolution is
    // recorded against, and what re-activation is measured from.
    resolutionKey: resolutionKey(label),
    kind: 'weekly_intention',
    label,
    // Deliberately flat, countable statements. No adjectives, no "you keep
    // failing" — the numbers carry it, and anything editorial on top reads as
    // contempt rather than candour.
    headline: `You've set “${label}” ${statements} weeks running.`,
    detail: `You marked it missed ${missed} of the ${graded} weeks you reviewed${achieved ? `, and hit it ${achieved}` : ''}.`,
    weeksStated,
    weeksMissed,
    counts: { statements, graded, missed, achieved, unreviewed },
    // The fork. Both branches are legitimate; the surface takes no side on
    // which one is right, because it genuinely cannot know.
    question: 'Is the goal wrong, or the plan?',
    options: [
      { id: 'revise', label: 'Rewrite the goal', detail: 'Make it something you would actually do next week.' },
      { id: 'keep', label: 'Keep it — fix the plan', detail: 'The goal is right; what has to change is how the week is built around it.' },
      { id: 'retire', label: 'Drop it', detail: 'It mattered once. It doesn’t now, and carrying it costs attention.' },
    ],
    evidence: {
      source: 'weekly_intentions',
      // The claim rests entirely on the user's own words and their own
      // grading. Saying so on the record is what makes it uncontestable.
      basis: 'your own weekly goals and your own review of them',
      windowWeeks: WINDOW_WEEKS,
      unreviewedExcluded: unreviewed,
    },
  };
}

/**
 * Pure: has a resolved disagreement earned the right to be raised again?
 *
 * `priorContext` is what was stored when the user resolved it — the statement
 * count at that moment. Silence holds until the goal has been set several more
 * times since; at that point the situation genuinely is new information, not
 * the same fact restated.
 */
function eligibleAfterResolution(assessment, priorContext, { restatements = RESTATEMENTS_BEFORE_RERAISE } = {}) {
  if (!priorContext) return true; // never resolved — nothing suppressing it
  const at = Number(priorContext.statements);
  if (!Number.isFinite(at)) return true; // unreadable context can't justify silence
  return assessment.statements - at >= restatements;
}

/**
 * Read one resolution record, accepting either a Map or a plain object.
 *
 * store/dismissedInsights.dismissedContextByKey() returns a Map, and bracket
 * access on a Map silently yields undefined rather than throwing — so getting
 * this wrong doesn't fail loudly, it just means every resolution is ignored
 * and the card returns immediately after being answered. Accepting both shapes
 * keeps the pure core drivable from tests with plain objects while production
 * passes the Map.
 */
function readResolution(resolvedContext, key) {
  if (!resolvedContext) return null;
  if (typeof resolvedContext.get === 'function') return resolvedContext.get(key) ?? null;
  return resolvedContext[key] ?? null;
}

/**
 * Build at most ONE disagreement from a window of intentions.
 *
 * One, not a list, and that is a product decision rather than a technical
 * limit: three simultaneous confrontations is an intervention, and it would
 * get the whole surface muted. The most-repeated intention wins — the thing
 * said most often and done least is the one worth the single slot.
 */
function buildDisagreement(intentions, { snapshotId = null, resolvedContext = null, ...gates } = {}) {
  const groups = groupByIntent(flattenGoalStatements(intentions));
  const assessed = groups
    .map((g) => assessIntent(g, gates))
    .filter(Boolean)
    .filter((a) => eligibleAfterResolution(a, readResolution(resolvedContext, resolutionKey(a.label)), gates))
    // Most-repeated first; ties broken by the higher miss rate.
    .sort((a, b) => (b.statements - a.statements) || (b.missRate - a.missRate));
  return composeDisagreement(assessed[0] ?? null, { snapshotId });
}

// --- IO wrapper ----------------------------------------------------------

/**
 * Read the intention history and build today's disagreement, or null.
 * The only read is store/intentions.js's existing recentIntentions — no new
 * query, no new table.
 */
async function computeDisagreement({ weeks = WINDOW_WEEKS, snapshotId = null } = {}) {
  const intentionsStore = require('../store/intentions');
  const dismissedStore = require('../store/dismissedInsights');
  const [intentions, resolvedContext] = await Promise.all([
    intentionsStore.recentIntentions({ days: weeks * 7 }),
    // Best-effort: a failure to read resolutions must not silence the engine,
    // but it must also not resurrect something the user just resolved — an
    // empty map is the safe direction only because re-raising is visible and
    // correctable, whereas wrongly staying silent is invisible.
    dismissedStore.dismissedContextByKey().catch(() => ({})),
  ]);
  return buildDisagreement(intentions, { snapshotId, resolvedContext });
}

module.exports = {
  computeDisagreement,
  buildDisagreement,
  flattenGoalStatements,
  toDayKey,
  groupByIntent,
  assessIntent,
  composeDisagreement,
  eligibleAfterResolution,
  readResolution,
  resolutionKey,
  WINDOW_WEEKS,
  RESTATEMENTS_BEFORE_RERAISE,
  MIN_STATEMENTS,
  MIN_GRADED,
  MIN_MISS_RATE,
  SAME_GOAL_THRESHOLD,
};
