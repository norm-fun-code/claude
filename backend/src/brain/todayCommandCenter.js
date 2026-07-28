// Today Command Center — the single server-owned projection the redesigned
// Today tab renders. This is NOT a second truth engine: every field here is
// SELECTED from data the caller (routes/briefing.js) already assembled for
// this exact response (chiefBrief, forecasts, todayForecast, healthInsights,
// wealthInsights, weeklyReview, wealth) plus one cheap extra read of the
// existing attention ledger (store/attention.js's pendingForBrief) for
// "Since This Morning." No new LLM call, no new canonical facts, no mobile-
// side derivation — mobile renders exactly what's returned here.
//
// Callable from all three response-construction sites (full build, cache-hit
// serve, scoped chief-brief rebuild) so the SAME selection logic runs
// regardless of which path produced the surrounding response — a stale
// cache-hit serve gets a freshly recomputed command center (cheap: one query,
// no rebuild) rather than a stored, possibly-stale one.

/** Domain destinations recognized by the mobile app's navigation. Keeping
 *  this list narrow (not one-per-attention-domain) is deliberate — the Today
 *  redesign's contract is "at most one compact preview per domain" for
 *  exactly Health/Wealth/Review; anything else routes back to Today itself
 *  rather than inventing a new destination the client doesn't have. */
function domainToDestination(domain) {
  if (domain === 'wealth') return 'wealth';
  if (domain === 'health' || domain === 'wellbeing') return 'health';
  return 'today';
}

/**
 * Find the ONE piece of evidence (if any) that would justify showing a RISK
 * section. Deliberately does NOT trust the chief-brief's own `risk` prose as
 * the gate — `risk` is a required field in the chief-brief's structured
 * output schema (services/briefing-ai.js), so the model always writes
 * SOMETHING there, including reassurance filler on a day with nothing wrong.
 * Gating on independently-computed, already-truth-contract-gated evidence
 * (an at-risk/off-track goal forecast, a red capacity day, or a health/
 * wellbeing anomaly that already survived the signal-vs-noise gate from the
 * universal truth-and-evidence contract) means a generic "nothing acute, stay
 * the course" sentence can never manufacture a RISK section — only a real,
 * independently-flagged signal can.
 */
function findRiskEvidence({ forecasts, todayForecast, healthInsights }) {
  const atRiskForecast = (forecasts || []).find(
    (f) => f.status === 'at_risk' || f.status === 'off_track'
  );
  if (atRiskForecast) {
    return {
      kind: 'forecast',
      title: atRiskForecast.title,
      detail: atRiskForecast.detail,
      severity: atRiskForecast.status === 'off_track' ? 'high' : 'watch',
    };
  }
  if (todayForecast?.capacity?.band === 'red') {
    return {
      kind: 'capacity',
      title: todayForecast.capacity.headline,
      detail: todayForecast.capacity.detail,
      severity: 'high',
    };
  }
  // healthInsights' 'anomaly' findings already passed computeAnomalies'
  // signal-vs-noise gate (audit priority #1, bug 6) — a wellbeing anomaly
  // only reaches this list, tagged "worth attention", when the ABSOLUTE
  // level is also unhealthy, not merely a dip against a high personal
  // baseline. Reusing that gate here (rather than re-deriving one) is what
  // keeps a 4/5 check-in against a 4.8 baseline from ever becoming a risk.
  const anomaly = (healthInsights || []).find(
    (i) => i.type === 'anomaly' && /worth attention/i.test(i.title || '')
  );
  if (anomaly) {
    return { kind: 'anomaly', title: anomaly.title, detail: anomaly.detail, severity: 'watch' };
  }
  return null;
}

/** "Since This Morning" — reuses store/attention.js's existing durable
 *  ledger (the Attention Policy's attention_log table), filtered to rows
 *  strictly AFTER snapshotAt. Nothing here is a new event/derivation system:
 *  every row was already judged add_to_brief/ask_question-worthy by the
 *  existing judge()/dispatch() pipeline; this just reads the ones that
 *  postdate the snapshot this response is otherwise built from, so a
 *  same-day mutation the snapshot ALREADY reflects is never re-shown as new.
 *
 *  Reads store/attention.js's sinceMorningForUser() — a DEDICATED, narrowly
 *  scoped query distinct from pendingForBrief() (which still feeds the
 *  chief-brief LLM prompt, unchanged) — never the internal `reason` field.
 *  A row with no approved user-facing content (see insertRow's
 *  approvedUserFacing in store/attention.js) is excluded by that query
 *  entirely, not papered over with the internal decision explanation: an
 *  event the Attention Policy judged worth deferring to the brief but that
 *  never got real user copy simply has nothing to show on Today. */
async function buildSinceMorning({ snapshotAt }) {
  if (!snapshotAt) return [];
  try {
    const attentionStore = require('../store/attention');
    const rows = await attentionStore.sinceMorningForUser({ since: snapshotAt, limit: 8 });
    return rows.map((r) => ({
      stableId: r.event_key,
      occurredAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      summary: r.user_title,
      detail: r.user_detail,
      destination: domainToDestination(r.domain),
    }));
  } catch (err) {
    console.error('[todayCommandCenter] sinceMorning failed:', err.message);
    return [];
  }
}

/**
 * Build the Today command-center projection. Pure aside from the one
 * `sinceMorning` ledger read. `input` fields are all things the caller
 * already has in hand for this exact response — see routes/briefing.js's
 * three call sites (full build, cache-hit serve, scoped chief-brief
 * rebuild).
 *
 * @param {object} input
 * @param {string|null} input.snapshotId
 * @param {number|null} input.snapshotVersion
 * @param {string|null} input.snapshotAt
 * @param {string|null} input.builtAt
 * @param {string} input.tz
 * @param {object|null} input.chiefBrief
 * @param {boolean} input.chiefBriefStale
 * @param {boolean} input.chiefBriefPending
 * @param {{status?: string}|null} input.chiefBriefQuality
 * @param {string|null} input.goalsWeekStart
 * @param {boolean} input.chiefBriefGoalsStale
 * @param {Array} input.forecasts
 * @param {object|null} input.todayForecast
 * @param {Array} input.healthInsights
 * @param {Array} input.wealthInsights
 * @param {object|null} input.weeklyReview
 * @param {object|null} input.wealth
 * @param {object|null} input.recovery
 * @param {object|null} input.effectiveWorkout the SAME shape services/workout.js's
 *   getEffectiveWorkout() returns — used ONLY by the plan-conflict guard below,
 *   never re-derived here.
 * @param {Set<string>} [input.dismissed] dismissed-insight keys (see
 *   store/dismissedInsights.js) — reused for the "On My Radar" dismiss
 *   filter, the SAME set the caller already fetched for its other insight
 *   arrays this response, never a second query.
 * @returns {Promise<object>} the todayCommandCenter object.
 */
async function buildTodayCommandCenter(input) {
  const {
    snapshotId = null, snapshotVersion = null, snapshotAt = null, builtAt = null,
    tz = process.env.TZ || 'America/New_York',
    chiefBrief = null, chiefBriefStale = false, chiefBriefPending = false, chiefBriefQuality = null,
    goalsWeekStart = null, chiefBriefGoalsStale = false,
    forecasts = [], todayForecast = null, healthInsights = [], wealthInsights = [],
    weeklyReview = null, wealth = null, recovery = null, effectiveWorkout = null,
    dismissed = null,
  } = input || {};

  // Pre-render semantic guard (Part 1): the authoritative trainingDayState —
  // the SAME canonical fact/state object brain/trainingDayState.js's
  // resolveTrainingDayState() computes from effectiveWorkout — is resolved
  // ONCE here and is what BOTH the headline and the action below are
  // validated against, never independently. This re-runs the SAME broadened
  // checks claimValidator.js applies at generation time against whatever is
  // actually about to be SERVED — catches an older stored brief that
  // predates the check, or a correction-retry paraphrase a narrower phrase
  // list let through. Today must never present two incompatible
  // interpretations of the plan (a "rest day" headline next to a hard-
  // workout action, or vice versa): when detected, BOTH the headline and
  // the action are replaced with a compact, factual resolution — a
  // self-contradictory headline sitting next to a suppressed action is
  // still a contradiction, not a fix.
  const { resolveTrainingDayState, validateTrainingDayContent } = require('./trainingDayState');
  const trainingDayState = resolveTrainingDayState({ effectiveWorkout, snapshotId, snapshotVersion });
  let planConflict = null;
  if (!chiefBriefPending && chiefBrief) {
    const { valid } = validateTrainingDayContent(trainingDayState, {
      synthesis: chiefBrief.synthesis, action: chiefBrief.action, risk: chiefBrief.risk, move: chiefBrief.move,
    });
    if (!valid) {
      const label = trainingDayState.effectiveWorkout?.label;
      const scheduledLabel = trainingDayState.plannedWorkout?.label;
      planConflict = trainingDayState.state === 'REST'
        ? {
            direction: 'workout_vs_rest',
            question: `Today is marked as a rest day, but the brief also recommends ${scheduledLabel}. Which should govern?`,
            effectiveWorkoutLabel: label, scheduledWorkoutLabel: scheduledLabel,
            options: [
              { id: 'keep_rest', label: 'Keep rest day', workoutId: 'rest' },
              { id: 'do_planned', label: `Do ${scheduledLabel}`, workoutId: trainingDayState.plannedWorkout?.workoutId ?? null },
            ],
          }
        : {
            direction: 'rest_vs_workout',
            question: `Your training plan has ${label}, but today is also described as a rest day. Which should govern?`,
            effectiveWorkoutLabel: label, scheduledWorkoutLabel: null,
            options: [
              { id: 'keep_rest', label: 'Keep rest day', workoutId: 'rest' },
              { id: 'do_planned', label: `Do ${label}`, workoutId: trainingDayState.effectiveWorkout?.workoutId ?? null },
            ],
          };
    }
  }

  // A conflict makes the RAW chief-brief synthesis untrustworthy as a
  // headline (it's the field carrying the contradiction in the observed
  // production case) — replace it with a deterministic, factual line built
  // from the SAME resolved trainingDayState, never a second guess at wording.
  const conflictHeadline = planConflict
    ? (planConflict.direction === 'workout_vs_rest'
        ? `Today is marked as a rest day, but the plan also lists ${planConflict.scheduledWorkoutLabel}. Resolve below to continue.`
        : `Your plan has ${planConflict.effectiveWorkoutLabel} today, but the brief also called it a rest day. Resolve below to continue.`)
    : null;

  const now = {
    stableId: `now:${snapshotId ?? 'none'}`,
    // Chief Brief's `synthesis` is ALREADY the single 20-35-word cross-domain
    // headline the product contract wants for NOW — reused verbatim, never
    // re-synthesized on the client. Pending/stale states get their own calm
    // copy rather than null (never render nothing where a state exists); an
    // unresolved plan conflict gets the same treatment — a deterministic,
    // factual line, never the raw self-contradictory text.
    headline: chiefBriefPending
      ? 'Finishing today\'s brief…'
      : (conflictHeadline ?? chiefBrief?.synthesis ?? null),
    detail: null,
    evidence: {
      chiefBriefQuality: chiefBriefQuality?.status ?? null,
      chiefBriefStale: Boolean(chiefBriefStale),
      chiefBriefPending: Boolean(chiefBriefPending),
      goalsWeekStart,
      chiefBriefGoalsStale: Boolean(chiefBriefGoalsStale),
      planConflict: Boolean(planConflict),
      trainingDayState: trainingDayState.state,
    },
  };

  // No action until a real chiefBrief exists — never invent one, never show
  // a stale action alongside a "finishing" NOW state. A detected plan
  // conflict also suppresses the action: a contradictory "Pull day is on
  // deck" (or "keep resting") must not render as THE single next action
  // while the plan itself is unresolved.
  const action = (!chiefBriefPending && !planConflict && chiefBrief?.action)
    ? {
        stableId: `action:${snapshotId ?? 'none'}`,
        title: chiefBrief.action,
        rationale: null,
        // Executable-allowlist mapping is intentionally NOT attempted here —
        // chiefBrief.action is free-text chief-of-staff prose, not a
        // structured action/lever the chat/executeAction.js allowlist can
        // safely auto-execute. The existing "Commit to this" flow (POST
        // /briefing/action/commit, already wired in BriefCard) is the
        // supported path; this payload is what that flow needs.
        commitmentPayload: { text: chiefBrief.action },
      }
    : null;

  const riskEvidence = findRiskEvidence({ forecasts, todayForecast, healthInsights });
  const risk = riskEvidence
    ? {
        stableId: `risk:${snapshotId ?? 'none'}:${riskEvidence.kind}`,
        title: riskEvidence.title,
        rationale: chiefBrief?.risk || riskEvidence.detail || riskEvidence.title,
        severity: riskEvidence.severity,
        evidence: { kind: riskEvidence.kind },
      }
    : null;

  const sinceMorning = await buildSinceMorning({ snapshotAt });
  // "On My Radar" — server-ranked replacement for the old fixed three-tile
  // preview row (see brain/radar.js). Never computed from wealth/recovery/
  // weeklyReview alone; always dedup'd against the risk ALREADY built above
  // so the same signal can't show up twice on one screen.
  const radar = require('./radar').buildRadarCards({
    wealthInsights, wealth, weeklyReview, recovery, chiefBrief, risk, snapshotId, dismissed,
  });

  return {
    snapshotId, snapshotVersion, snapshotAt, builtAt,
    now, action,
    planConflict: planConflict ? { stableId: `planConflict:${snapshotId ?? 'none'}`, ...planConflict } : null,
    risk, sinceMorning, radar,
  };
}

module.exports = { buildTodayCommandCenter, findRiskEvidence, domainToDestination };
