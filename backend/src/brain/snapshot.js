// BrainSnapshot — the central, versioned composition layer above NormOS's
// domain authorities. Today, Health, Wealth, Ask, realtime voice, briefings,
// forecasts, and evening reviews should read canonical facts FROM here (or thin
// projections of it) instead of each independently re-deriving "current state"
// from raw stores — which is how the same fact ended up with contradictory
// values on different tabs (Health showing current recovery while Today showed
// a forecast built from an older score; realtime narrating a static workout the
// Health tab had already downgraded; a forecast moved by a retracted note).
//
// This is NOT another god file and it holds NO business logic of its own: every
// value comes from the existing authoritative selector (liveRecovery,
// getEffectiveWorkout, computeTodayForecast, buildWealthInsights, listFindings,
// currentIntention, commitments.listActive, listExperiments, filterEligible,
// …) named in registry.js. Its only job is to call each authority ONCE, tz-safe
// and deterministic under an injected `asOf`, and hand back one structured
// object — each fact wrapped with provenance (source selector, asOf, freshness,
// confidence) so a generated claim can be checked against it and a consumer can
// tell fresh from stale from unavailable.
'use strict';

const { authorityFor } = require('./registry');

const DEFAULT_TZ = process.env.TZ || 'America/New_York';
// Bump when the snapshot's SHAPE changes in a way consumers must notice. Pushes
// and briefs stamp this + snapshotId so an in-app view and a notification can be
// proven to reference the same cut of state.
const SNAPSHOT_VERSION = 1;

/** Wrap a value with provenance metadata. `source` is the authoritative
 *  selector (from the registry); `freshness` is 'fresh' | 'stale' |
 *  'unavailable'; `confidence` is included only when meaningful. */
function fact(value, { source, asOf, freshness, confidence = null } = {}) {
  const present = value !== null && value !== undefined
    && !(Array.isArray(value) && value.length === 0);
  return {
    value: value ?? null,
    source: source ?? null,
    asOf: asOf ?? null,
    freshness: freshness ?? (present ? 'fresh' : 'unavailable'),
    ...(confidence != null ? { confidence } : {}),
  };
}

/** Run a lazy authority call, degrading to `fallback` (default null) on any
 *  error so one failing domain never sinks the whole snapshot. */
async function safe(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

/** The canonical month-to-date discretionary spend: sum of the
 *  spending_discretionary metric from the LOCAL month start, excluding seeded
 *  baseline rows. This is the SAME rule consolidate.js's `spendingMtd` uses —
 *  named once here so the claim validator and every surface reference an
 *  identical number, not a figure re-scraped from an insight card. Returns null
 *  when there's no discretionary spend recorded yet this month. */
async function canonicalSpendingMtd(asOf, tz) {
  const { localMonthStartUtc } = require('../util/date');
  const monthStart = localMonthStartUtc(tz, asOf);
  const rows = await require('../store/metrics').dailyAggregate({
    domain: 'wealth', metric: 'spending_discretionary',
    from: monthStart, to: asOf, agg: 'sum', excludeSource: 'seed', tz,
  });
  if (!rows || !rows.length) return null;
  return rows.reduce((a, r) => a + Number(r.value || 0), 0);
}

/**
 * Compose a BrainSnapshot at `asOf` in `tz`. Deterministic under an injected
 * `asOf` (every date boundary derives from it, never `new Date()`). Pass
 * `recovery` to reuse an already-computed liveRecovery result and avoid a
 * redundant lookup; pass `include` to skip expensive/network sections
 * (calendar) in contexts that don't need them.
 *
 * @param {object} [opts]
 * @param {Date}   [opts.asOf]
 * @param {string} [opts.tz]
 * @param {object|null|undefined} [opts.recovery] - reuse a liveRecovery result;
 *   `undefined` means "look it up", explicit `null` means "known absent".
 * @param {{ calendar?: boolean }} [opts.include]
 * @returns {Promise<object>} the snapshot.
 */
async function buildBrainSnapshot({ asOf = new Date(), tz = DEFAULT_TZ, recovery, include = {} } = {}) {
  const crypto = require('crypto');
  const snapshotAt = asOf.toISOString();
  const localDate = asOf.toLocaleDateString('en-CA', { timeZone: tz });
  const snapshotId = `snap_${localDate}_${crypto.randomUUID().slice(0, 8)}`;

  // ── Recovery (authority: liveRecovery) — the anchor most other facts depend on.
  const recoveryVal = recovery !== undefined
    ? recovery
    : await safe(() => require('../intelligence/recovery').liveRecovery());

  // ── Effective workout (authority: getEffectiveWorkout) — pass the band we
  // already have so it doesn't re-fetch recovery; this is what makes the
  // realtime tool, the brief, and the Health tab describe the SAME session.
  const effectiveWorkout = await safe(() =>
    require('../services/workout').getEffectiveWorkout({ asOf, tz, band: recoveryVal?.band ?? null })
  );

  // ── Today forecast (authority: computeTodayForecast) — recovery + effective
  // workout + eligible context, all deterministic under asOf.
  const forecast = await safe(() =>
    require('../intelligence/predict').computeTodayForecast({ recovery: recoveryVal, asOf })
  );

  // ── Goals & weekly intention (completion authority for the claim validator).
  const goals = await safe(() => require('../store/goals').listGoals({ status: 'active' }), []);
  const weeklyIntention = await safe(() => require('../store/intentions').currentIntention());

  // ── Commitments (open + completion state).
  const commitments = await safe(() => require('../store/commitments').listActive({ limit: 20 }), []);

  // ── Wealth / spending. `insights` are the display cards (buildWealthInsights);
  // `spendingMtd` is the canonical month-to-date discretionary total, computed
  // from the SAME authoritative rule consolidate.js uses (sum of the
  // spending_discretionary metric from the local month start) — NOT scraped out
  // of an insight card's prose, so the claim validator has a real number to
  // check a generated "$X spent this month" against.
  const wealthInsights = await safe(() => require('../services/wealth-insights').buildWealthInsights(), []);
  const spendingMtd = await safe(() => canonicalSpendingMtd(asOf, tz), null);
  const wealth = { insights: wealthInsights, spendingMtd };

  // ── Findings / trends (authority: listFindings).
  const findings = await safe(() => require('../store/findings').listFindings({ status: 'open', limit: 40 }), []);

  // ── Experiments.
  const experiments = await safe(() => require('../store/experiments').listExperiments(), []);

  // ── Eligible current context — annotations routed through the SHARED
  // eligibility layer so a retracted/retired/financial note never enters any
  // projection. 'general' purpose: keeps planned/occurred/negated, drops the
  // rest.
  const eligibleContext = await safe(async () => {
    const { localDayBoundsUtc } = require('../util/date');
    const { filterEligible } = require('../intelligence/context-semantics');
    const { start } = localDayBoundsUtc(tz, asOf);
    const active = await require('../store/annotations').overlapping(start, asOf);
    return filterEligible(active, { purpose: 'general' });
  }, []);

  // ── Calendar availability (best-effort, network — skipped unless requested).
  const calendarAvailability = include.calendar
    ? await safe(() => require('../services/calendar').fetchWorkBusyBlocks(), null)
    : null;

  // ── Source / data health.
  const sourceHealth = await safe(async () => {
    const { describeDataGaps } = require('../intelligence/source-health');
    const sources = await require('../store/sources').listSources();
    return describeDataGaps(sources);
  }, []);

  // Recovery freshness: a `proxy` (self-reported, no Pod data) score is real
  // state but lower-confidence; an absent score is unavailable.
  const recoveryFreshness = recoveryVal?.score != null ? 'fresh' : 'unavailable';
  const recoveryConfidence = recoveryVal?.score == null ? null : (recoveryVal.proxy ? 'low' : 'high');

  return {
    snapshotId,
    version: SNAPSHOT_VERSION,
    asOf: snapshotAt,
    localDate,
    timezone: tz,

    recovery: fact(recoveryVal, {
      source: authorityFor('recovery'), asOf: snapshotAt,
      freshness: recoveryFreshness, confidence: recoveryConfidence,
    }),
    effectiveWorkout: fact(effectiveWorkout, {
      source: authorityFor('effectiveWorkout'), asOf: snapshotAt,
      // Provenance the whole layer exists for: WHY today's plan is what it is.
      confidence: effectiveWorkout ? 'high' : null,
    }),
    forecast: fact(forecast?.capacity ? forecast : (forecast ?? null), {
      source: authorityFor('todayForecast'), asOf: snapshotAt,
      confidence: forecast?.capacity?.proxy ? 'low' : (forecast?.capacity ? 'high' : null),
    }),
    goals: fact(goals, { source: authorityFor('goals'), asOf: snapshotAt }),
    weeklyIntention: fact(weeklyIntention, { source: authorityFor('weeklyIntention'), asOf: snapshotAt }),
    commitments: fact(commitments, { source: authorityFor('commitments'), asOf: snapshotAt }),
    wealth: fact(wealth, {
      source: authorityFor('wealth'), asOf: snapshotAt,
      // The composite object is always non-null; base freshness on real content.
      freshness: (wealthInsights?.length || wealth.spendingMtd != null) ? 'fresh' : 'unavailable',
    }),
    findings: fact(findings, { source: authorityFor('findings'), asOf: snapshotAt }),
    experiments: fact(experiments, { source: authorityFor('experiments'), asOf: snapshotAt }),
    eligibleContext: fact(eligibleContext, { source: authorityFor('eligibleContext'), asOf: snapshotAt }),
    calendarAvailability: fact(calendarAvailability, {
      source: authorityFor('calendarAvailability'), asOf: snapshotAt,
      freshness: include.calendar ? undefined : 'unavailable',
    }),
    sourceHealth: fact(sourceHealth, { source: authorityFor('sourceHealth'), asOf: snapshotAt }),
  };
}

// ── Thin projections ────────────────────────────────────────────────────────
// Surfaces should read these instead of re-deriving. Each returns plain values
// (unwrapped) shaped for that consumer, but sourced from ONE snapshot so every
// surface agrees.

/** Realtime `get_today_context` projection: the morning brief's
 *  synthesis/action/risk (only if the brief is from the snapshot's local date),
 *  the canonical effective workout, and the current recovery band. */
function realtimeTodayContext(snapshot, briefing) {
  const briefLocalDate = briefing?.generated_at
    ? new Date(briefing.generated_at).toLocaleDateString('en-CA', { timeZone: snapshot.timezone })
    : (briefing?.content?.localDate ?? null);
  const briefIsToday = briefLocalDate === snapshot.localDate;
  const cb = briefIsToday ? briefing?.content?.chiefBrief : null;
  const w = snapshot.effectiveWorkout.value;
  const r = snapshot.recovery.value;
  return {
    synthesis: cb?.synthesis ?? null,
    action: cb?.action ?? null,
    risk: cb?.risk ?? null,
    briefIsCurrent: briefIsToday,
    workout: w ? { type: w.label, source: w.source, isHard: w.isHard } : null,
    recovery: r ? { score: r.score ?? null, band: r.band ?? null } : null,
  };
}

/** Compact facts object for the claim validator — the canonical values a
 *  generated brief is allowed to reference — built from raw domain parts. The
 *  ONE fact-shaping function: both canonicalFacts(snapshot) and the briefing
 *  hot path (which already has these parts in scope) call THIS, so a brief is
 *  always validated against the identical fact shape the snapshot exposes. */
function canonicalFactsFrom({ recovery, effectiveWorkout, forecast, goals, commitments, experiments, wealth, localDate } = {}) {
  const r = recovery, w = effectiveWorkout, f = forecast;
  return {
    localDate: localDate ?? null,
    recoveryScore: r?.score ?? null,
    recoveryBand: r?.band ?? null,
    recoveryProxy: r?.proxy ?? false,
    effectiveWorkoutLabel: w?.label ?? null,
    effectiveWorkoutId: w?.workoutId ?? null,
    effectiveWorkoutSource: w?.source ?? null,       // override | auto_downgrade | scheduled
    scheduledWorkoutLabel: w?.scheduledLabel ?? null,
    forecastGrade: f?.capacity?.grade ?? null,
    forecastBand: f?.capacity?.band ?? null,
    tomorrowBand: f?.tomorrow?.band ?? null,
    goals: (goals || []).map((g) => ({ text: g.title ?? g.text, achieved: g.achieved ?? false })),
    commitments: (commitments || []).map((c) => ({ title: c.title, status: c.status ?? 'open' })),
    experiments: (experiments || []).map((e) => ({ hypothesis: e.hypothesis, status: e.status, verdict: e.verdict ?? null })),
    // Canonical month-to-date discretionary spend. `spendingMtd` is the value the
    // snapshot computes from the ONE authoritative rule (sum of the
    // spending_discretionary metric from month start — same rule consolidate.js
    // uses); the legacy shapes are accepted so a caller that already has a
    // structured wealth object still lines up.
    spendingTotalMonth: wealth?.spendingMtd ?? wealth?.monthToDate?.total ?? wealth?.spendMTD ?? null,
  };
}

/** Compact facts object for the claim validator, projected from a snapshot. */
function canonicalFacts(snapshot) {
  return canonicalFactsFrom({
    recovery: snapshot.recovery.value,
    effectiveWorkout: snapshot.effectiveWorkout.value,
    forecast: snapshot.forecast.value,
    goals: snapshot.goals.value,
    commitments: snapshot.commitments.value,
    experiments: snapshot.experiments.value,
    wealth: snapshot.wealth.value,
    localDate: snapshot.localDate,
  });
}

module.exports = {
  buildBrainSnapshot, realtimeTodayContext, canonicalFacts, canonicalFactsFrom, fact,
  canonicalSpendingMtd, SNAPSHOT_VERSION, DEFAULT_TZ,
};
