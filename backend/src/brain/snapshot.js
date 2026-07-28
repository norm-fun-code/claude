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

const { authorityFor, FIELDS } = require('./registry');

const DEFAULT_TZ = process.env.TZ || 'America/New_York';
// Bump when the snapshot's SHAPE changes in a way consumers must notice. Pushes
// and briefs stamp this + snapshotId so an in-app view and a notification can be
// proven to reference the same cut of state.
//
// v2 (temporal-grounding fix): added nightlyContextHistory + the
// checkTemporalFraming claim check — a briefing row built under v1 may carry
// a false "tonight" claim generated from a historical context tag with no
// validator to catch it. routes/briefing.js's buildFreshBriefing() compares
// this against a cached row's OWN stamped snapshotVersion and forces a fresh
// rebuild (never serves the cache-hit fast path) when the cached row
// predates the current version — see that file's cacheContractCurrent.
//
// v3 (workout-identity fix): added trainingOutcome + the
// checkWorkoutCompletionOverclaim claim check — a briefing row built under
// v2 may carry a false "done" claim about a scheduled hard workout that was
// actually completed by an unrelated logged activity (the "walk on an
// Intervals day" bug), with no validator able to catch it (the fact this
// check depends on, plannedWorkoutCompleted, didn't exist yet). Same
// cacheContractCurrent forced-rebuild mechanism as v2.
const SNAPSHOT_VERSION = 3;

/** Wrap a value with provenance metadata. `source` is the authoritative
 *  selector (from the registry); `freshness` is 'fresh' | 'stale' |
 *  'unavailable'; `confidence` is included only when meaningful. */
function fact(value, meta = {}) {
  const { source = null, asOf = null, freshness, ...rest } = meta;
  const present = value !== null && value !== undefined
    && !(Array.isArray(value) && value.length === 0);
  return {
    value: value ?? null,
    source,
    asOf,
    freshness: freshness ?? (present ? 'fresh' : 'unavailable'),
    // Carry through any extra provenance the caller computed (confidence,
    // degraded, error, reason) so a failure is never flattened into a bare value.
    ...rest,
  };
}

/** The canonical month-to-date discretionary spend: sum of the
 *  spending_discretionary metric from the LOCAL month start, excluding seeded
 *  baseline rows. This is the SAME rule consolidate.js's `spendingMtd` uses.
 *
 *  Boundary MUST be `localMonthKeyStartUtc`, NOT `localMonthStartUtc`: wealth
 *  flow metrics are day-keyed at UTC midnight of the local day string (monarch.js
 *  `dayTs` stores local July 1 at `2026-07-01T00:00:00Z`, not true local midnight
 *  `…T04:00:00Z` in EDT). `localMonthStartUtc` returns 04:00Z and would silently
 *  drop the entire first day of the month — the regression this fixes. Returns
 *  null when there's no discretionary spend recorded yet this month. */
async function canonicalSpendingMtd(asOf, tz) {
  const { localMonthKeyStartUtc } = require('../util/date');
  const monthStart = localMonthKeyStartUtc(tz, asOf);
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

  // `include` selects which NON-core sections to compose. The core dependency
  // chain (recovery → effectiveWorkout → forecast) is always built — it's cheap
  // and every current-state consumer needs it. Heavy/independent sections are
  // opt-OUT (default on) so a lean caller — the realtime voice `get_today_context`
  // tool — can skip wealth insights, findings, experiments, goals, etc. it never
  // reads, instead of paying for them just to answer "what's my recovery?".
  const want = {
    forecast: include.forecast !== false,
    goals: include.goals !== false,
    weeklyIntention: include.weeklyIntention !== false,
    commitments: include.commitments !== false,
    wealth: include.wealth !== false,
    findings: include.findings !== false,
    experiments: include.experiments !== false,
    eligibleContext: include.eligibleContext !== false,
    calendar: include.calendar === true, // network — default OFF
    sourceHealth: include.sourceHealth !== false,
    resolvedContext: include.resolvedContext !== false,
    nightlyContextHistory: include.nightlyContextHistory !== false,
  };

  // A section that wasn't requested — distinct from one that failed. Its
  // provenance says 'unavailable' with reason 'not-included', never a fake empty.
  const skip = (value = null) => ({ value, ok: true, skipped: true, error: null });

  const failures = [];
  // read(): run an authority, capturing ok/error so a FAILURE is represented in
  // provenance (freshness 'unavailable', degraded:true) and LOGGED — never
  // silently turned into apparently-valid empty data (the honest-provenance rule).
  async function read(field, fn, fallback = null) {
    try {
      return { field, value: await fn(), ok: true, skipped: false, error: null };
    } catch (err) {
      const msg = err?.message || String(err);
      failures.push({ field, error: msg });
      console.error(`[brain/snapshot] authority '${field}' failed: ${msg}`);
      return { field, value: fallback, ok: false, skipped: false, error: msg };
    }
  }

  // Recovery is the anchor: effectiveWorkout reads its band, forecast reads both.
  const recoveryRead = recovery !== undefined
    ? { field: 'recovery', value: recovery, ok: true, skipped: false, error: null }
    : await read('recovery', () => require('../intelligence/recovery').liveRecovery());
  const recoveryVal = recoveryRead.value;

  // effectiveWorkout depends on recovery.band; fan out ALL independent sections
  // concurrently alongside it (voice-latency: independent authority reads run in
  // parallel, not one-at-a-time).
  const [
    workoutRead, goalsRead, intentionRead, commitmentsRead,
    wealthInsightsRead, spendingRead, spendingPaceRead, findingsRead, experimentsRead,
    contextRead, calendarRead, sourceHealthRead, resolvedContextRead,
    nightlyContextHistoryRead,
  ] = await Promise.all([
    read('effectiveWorkout', () => require('../services/workout').getEffectiveWorkout({ asOf, tz, band: recoveryVal?.band ?? null })),
    want.goals ? read('goals', () => require('../store/goals').listGoals({ status: 'active' }), []) : skip([]),
    want.weeklyIntention ? read('weeklyIntention', () => require('../store/intentions').currentIntention()) : skip(null),
    want.commitments ? read('commitments', () => require('../store/commitments').listActive({ limit: 20 }), []) : skip([]),
    want.wealth ? read('wealth', () => require('../services/wealth-insights').buildWealthInsights(), []) : skip([]),
    want.wealth ? read('spendingMtd', () => canonicalSpendingMtd(asOf, tz), null) : skip(null),
    // Matched-pace baseline (median of the same elapsed-fraction-of-month
    // spend across trailing complete months) — the SAME function
    // wealth-landing.js/ask.js call, so this can never disagree with the
    // Wealth tab or a cited Ask answer.
    want.wealth ? read('spendingPace', () => require('../services/wealth-pace').computeDiscretionaryMatchedPace({ asOf, tz }), null) : skip(null),
    want.findings ? read('findings', () => require('../store/findings').listFindings({ status: 'open', limit: 40 }), []) : skip([]),
    want.experiments ? read('experiments', () => require('../store/experiments').listExperiments(), []) : skip([]),
    want.eligibleContext ? read('eligibleContext', async () => {
      const { localDayBoundsUtc } = require('../util/date');
      const { filterEligible } = require('../intelligence/context-semantics');
      const { start } = localDayBoundsUtc(tz, asOf);
      const active = await require('../store/annotations').overlapping(start, asOf);
      return filterEligible(active, { purpose: 'general' });
    }, []) : skip([]),
    want.calendar ? read('calendarAvailability', () => require('../services/calendar').fetchWorkBusyBlocks(), null) : skip(null),
    want.sourceHealth ? read('sourceHealth', async () => {
      const { describeDataGaps } = require('../intelligence/source-health');
      const sources = await require('../store/sources').listSources();
      return describeDataGaps(sources);
    }, []) : skip([]),
    // Context Understanding Layer's canonical projection — see
    // intelligence/context-resolver.js. One read fetches both the raw
    // assertions/relations AND resolves them; contextAssertions/
    // contextRelations below are cheap derived views of THIS read's result,
    // not separate DB round trips.
    want.resolvedContext ? read('resolvedContext', () => require('../intelligence/context-resolver').resolveContext({ tz, now: asOf }), null) : skip(null),
    want.nightlyContextHistory
      ? read('nightlyContextHistory', () => require('../intelligence/nightly-context-history').computeNightlyContextHistory({ tz, asOf }), [])
      : skip([]),
  ]);

  // trainingOutcome depends on the ALREADY-RESOLVED effective workout (same
  // "one authority read per snapshot" discipline as forecast below) — what
  // actually happened toward training today (exerciseHabitDone vs
  // plannedWorkoutCompleted vs hardSessionCompleted), never re-derived by
  // predict.js or evening-brief.js from raw activity/habit queries anymore.
  // Always built (not gated by `include`) — cheap (same handful of rows
  // predict.js used to query inline every forecast build) and both the
  // forecast and the evening brief need it.
  const trainingOutcomeRead = await read('trainingOutcome', () => require('../services/workout').resolveTrainingOutcome({
    asOf, tz, effectiveWorkout: workoutRead.value,
  }));

  // forecast depends on recovery + the ALREADY-RESOLVED effective workout AND
  // trainingOutcome — pass both in so computeTodayForecast does NOT
  // re-resolve/re-query them a second time. One authority read per snapshot.
  const forecastRead = want.forecast
    ? await read('forecast', () => require('../intelligence/predict').computeTodayForecast({
      recovery: recoveryVal, asOf, effectiveWorkout: workoutRead.value, trainingOutcome: trainingOutcomeRead.value,
    }))
    : skip(null);

  const wealth = { insights: wealthInsightsRead.value || [], spendingMtd: spendingRead.value ?? null, spendingPace: spendingPaceRead.value ?? null };

  // ── Truthful provenance: a 5-state freshness model ────────────────────────
  // 'unavailable' used to mean two very different things at once — "the
  // authority succeeded and correctly reports zero of these" (no open
  // commitments right now IS the true, current state) and "we don't actually
  // know" (recovery is null because there's no HRV reading) — collapsing them
  // made every legitimately-empty collection look like a data gap. And every
  // present value was called 'fresh' regardless of how old the underlying read
  // actually was, even for fields the registry itself declares a TTL for
  // (recovery's RECOVERY_CACHE_MS). Five distinct states:
  //   'failed'      — the authority THREW. Always logged (see read() above)
  //                   and carries `error`; never silently downgraded to an
  //                   empty value.
  //   'unavailable' — skipped by `include`, OR a scalar/singular fact with no
  //                   value where absence means "we don't know" (recovery,
  //                   effectiveWorkout, forecast) — a real data gap.
  //   'valid-empty' — the authority succeeded and an EMPTY result is itself a
  //                   normal, correct answer (no open commitments, no running
  //                   experiments, no weekly intention set yet).
  //   'stale'       — present, successful, but read from a cache/computation
  //                   older than the registry's declared TTL for that field
  //                   (only meaningful for fields with both a real
  //                   computed-at timestamp AND a non-null ttlMs — currently
  //                   just `recovery`, via its liveRecovery() promise cache).
  //   'fresh'       — present, successful, and (when a TTL applies) within it.
  const isEmpty = (v) => v == null || (Array.isArray(v) && v.length === 0);
  function classifyFreshness(rd, { emptyIsValid = false, computedAt = null, ttlMs = null } = {}) {
    if (rd.skipped) return 'unavailable';
    if (!rd.ok) return 'failed';
    if (isEmpty(rd.value)) return emptyIsValid ? 'valid-empty' : 'unavailable';
    if (computedAt != null && ttlMs != null && (Date.now() - computedAt) > ttlMs) return 'stale';
    return 'fresh';
  }
  const provenance = (rd, opts = {}) => {
    const { confidence = null, ...classifyOpts } = opts;
    return {
      source: authorityFor(rd.field) || rd.field,
      asOf: snapshotAt,
      freshness: classifyFreshness(rd, classifyOpts),
      ...(confidence != null ? { confidence } : {}),
      ...(rd.skipped ? { reason: 'not-included' } : {}),
      ...(!rd.ok ? { degraded: true, error: rd.error } : {}),
    };
  };

  const recoveryConfidence = recoveryVal?.score == null ? null : (recoveryVal.proxy ? 'low' : 'high');
  const forecastVal = forecastRead.value;
  // Recovery's REAL staleness signal: when the value came from
  // liveRecovery()'s own promise cache, how old is that cache — not
  // "asOf minus now" (asOf/snapshotAt is always "when this snapshot was cut",
  // which tells you nothing about whether the recovery VALUE inside it is a
  // 90-second-old cache hit or a fresh compute).
  const recoveryComputedAt = recovery !== undefined
    ? null // an injected `recovery` has no cache timestamp we can inspect — treat as fresh (caller's responsibility)
    : require('../intelligence/recovery').recoveryComputedAt();
  const recoveryTtlMs = FIELDS.recovery?.ttlMs ?? null;

  return {
    snapshotId,
    version: SNAPSHOT_VERSION,
    asOf: snapshotAt,
    localDate,
    timezone: tz,
    // Authorities that failed to read this cut — logged above AND surfaced here
    // so a consumer/test can see the snapshot was degraded rather than empty.
    degraded: failures,

    recovery: fact(recoveryVal, provenance(recoveryRead, {
      confidence: recoveryConfidence, computedAt: recoveryComputedAt, ttlMs: recoveryTtlMs,
    })),
    effectiveWorkout: fact(workoutRead.value, provenance(workoutRead, {
      confidence: workoutRead.value ? 'high' : null,
    })),
    trainingOutcome: fact(trainingOutcomeRead.value, provenance(trainingOutcomeRead, {
      confidence: trainingOutcomeRead.value ? 'high' : null,
    })),
    forecast: fact(forecastVal?.capacity ? forecastVal : (forecastVal ?? null), provenance(forecastRead, {
      confidence: forecastVal?.capacity?.proxy ? 'low' : (forecastVal?.capacity ? 'high' : null),
    })),
    goals: fact(goalsRead.value, provenance(goalsRead, { emptyIsValid: true })),
    weeklyIntention: fact(intentionRead.value, provenance(intentionRead, { emptyIsValid: true })),
    commitments: fact(commitmentsRead.value, provenance(commitmentsRead, { emptyIsValid: true })),
    wealth: fact(wealth, {
      ...provenance(wealthInsightsRead, { emptyIsValid: true }),
      source: authorityFor('wealth'),
      // The MTD-spend read can fail independently of the insight cards — reflect it.
      ...(!spendingRead.ok ? { degraded: true, error: spendingRead.error } : {}),
    }),
    findings: fact(findingsRead.value, provenance(findingsRead, { emptyIsValid: true })),
    experiments: fact(experimentsRead.value, provenance(experimentsRead, { emptyIsValid: true })),
    eligibleContext: fact(contextRead.value, provenance(contextRead, { emptyIsValid: true })),
    calendarAvailability: fact(calendarRead.value, provenance(calendarRead, { emptyIsValid: true })),
    sourceHealth: fact(sourceHealthRead.value, provenance(sourceHealthRead, { emptyIsValid: true })),
    // Context Understanding Layer — see intelligence/context-resolver.js.
    // contextAssertions/contextRelations are derived views of the SAME
    // resolvedContextRead (no extra authority read of their own), so their
    // freshness/degraded state always agrees with resolvedContext's.
    contextAssertions: fact(resolvedContextRead.value?.assertions ?? [], {
      ...provenance(resolvedContextRead, { emptyIsValid: true }), source: authorityFor('contextAssertions'),
    }),
    contextRelations: fact(resolvedContextRead.value?.relations ?? [], {
      ...provenance(resolvedContextRead, { emptyIsValid: true }), source: authorityFor('contextRelations'),
    }),
    resolvedContext: fact(resolvedContextRead.value, provenance(resolvedContextRead, { emptyIsValid: false })),
    // Canonical nightly context-tag history — see registry.js's
    // nightlyContextHistory field and intelligence/nightly-context-history.js.
    // Empty is a normal, valid state (no tags logged in the window), not a
    // data gap — a user who hasn't opened the self-report card recently is
    // not "unavailable", it's genuinely nothing to report.
    nightlyContextHistory: fact(nightlyContextHistoryRead.value, provenance(nightlyContextHistoryRead, { emptyIsValid: true })),
  };
}

// ── Thin projections ────────────────────────────────────────────────────────
// Surfaces should read these instead of re-deriving. Each returns plain values
// (unwrapped) shaped for that consumer, but sourced from ONE snapshot so every
// surface agrees.

/** Realtime `get_today_context` projection: the morning brief's
 *  synthesis/action/risk (only if the brief is from the snapshot's local date
 *  AND hasn't gone stale relative to the invalidation bus since), the
 *  canonical effective workout, and the current recovery band.
 *
 *  A same-calendar-day brief is NOT automatically "current": recovery can
 *  change, a workout can be overridden, or context can be retracted AFTER the
 *  brief was built but on the SAME day — a pure date check can't see that. So
 *  when `opts.currentVersions` is supplied (the invalidation bus's
 *  versionOf() per field, refreshed by the caller so it's authoritative
 *  across instances — see chat/realtimeTools.js), it's compared against the
 *  brief's OWN `content.fieldVersions` (stamped at the brief's build time —
 *  see routes/briefing.js) for recovery/effectiveWorkout/todayForecast; any
 *  mismatch means the bus has moved past what the brief reflects, so its
 *  synthesis/action/risk are treated as stale even though the date matches.
 *  Older briefs with no stored fieldVersions, or a caller that doesn't pass
 *  currentVersions, fall back to the pure date check (unchanged behavior). */
function realtimeTodayContext(snapshot, briefing, opts = {}) {
  const briefLocalDate = briefing?.generated_at
    ? new Date(briefing.generated_at).toLocaleDateString('en-CA', { timeZone: snapshot.timezone })
    : (briefing?.content?.localDate ?? null);
  const sameCalendarDay = briefLocalDate === snapshot.localDate;

  const briefVersions = briefing?.content?.fieldVersions || null;
  const currentVersions = opts.currentVersions || null;
  let versionCurrent = true; // no version info to compare → don't invent staleness
  if (briefVersions && currentVersions) {
    for (const field of ['recovery', 'effectiveWorkout', 'todayForecast']) {
      if ((currentVersions[field] ?? 0) !== (briefVersions[field] ?? 0)) { versionCurrent = false; break; }
    }
  }

  const briefIsToday = sameCalendarDay && versionCurrent;
  const cb = briefIsToday ? briefing?.content?.chiefBrief : null;
  const w = snapshot.effectiveWorkout.value;
  const r = snapshot.recovery.value;
  // Context Understanding Layer: a compact projection of what the user has
  // told NormOS (harden pass, item 2) — so a calendar reclassification or
  // completion correction said earlier in the SAME voice session (or in a
  // brief/Ask turn just before it) is visible to later voice turns too,
  // instead of the realtime session re-reasoning from nothing. Capped
  // smaller than Chief Brief/Ask's projection (voice's context budget is
  // tighter) — see context-resolver.js's summarizeResolvedContext.
  let resolvedContextNote = null;
  if (snapshot.resolvedContext?.value) {
    try {
      const { summarizeResolvedContext } = require('../intelligence/context-resolver');
      resolvedContextNote = summarizeResolvedContext(snapshot.resolvedContext.value, { purpose: 'general', maxItems: 4 }) || null;
    } catch { /* non-critical */ }
  }
  return {
    synthesis: cb?.synthesis ?? null,
    action: cb?.action ?? null,
    risk: cb?.risk ?? null,
    briefIsCurrent: briefIsToday,
    workout: w ? { type: w.label, source: w.source, isHard: w.isHard } : null,
    recovery: r ? { score: r.score ?? null, band: r.band ?? null } : null,
    resolvedContext: resolvedContextNote,
  };
}

/** Compact facts object for the claim validator — the canonical values a
 *  generated brief is allowed to reference — built from raw domain parts. The
 *  ONE fact-shaping function: both canonicalFacts(snapshot) and the briefing
 *  hot path (which already has these parts in scope) call THIS, so a brief is
 *  always validated against the identical fact shape the snapshot exposes. */
function canonicalFactsFrom({ recovery, effectiveWorkout, trainingOutcome, forecast, goals, commitments, experiments, wealth, localDate, recoveryDrivers, resolvedContext, nightlyContextHistory } = {}) {
  const r = recovery, w = effectiveWorkout, f = forecast, t = trainingOutcome;
  return {
    localDate: localDate ?? null,
    recoveryScore: r?.score ?? null,
    recoveryBand: r?.band ?? null,
    recoveryProxy: r?.proxy ?? false,
    // The ONLY annotations eligible to explain TODAY's recovery number —
    // purpose:'health', temporally aligned to the exact overnight window
    // that produced the reading (see routes/briefing.js's recoveryDriversContext
    // block). Empty means no eligible driver exists: checkRecoveryCause (below,
    // via brain/claimValidator.js) neutralizes any causal recovery sentence
    // when this is empty, rather than let the model's own guess ship.
    recoveryDrivers: (recoveryDrivers || []).filter(Boolean),
    effectiveWorkoutLabel: w?.label ?? null,
    effectiveWorkoutId: w?.workoutId ?? null,
    effectiveWorkoutSource: w?.source ?? null,       // override | auto_downgrade | scheduled
    scheduledWorkoutLabel: w?.scheduledLabel ?? null,
    // The ONE canonical training-day state object (brain/trainingDayState.js)
    // every Today surface should resolve from — packaged here alongside the
    // flattened fields above (kept for backward compatibility with existing
    // checks) so a caller building chiefFacts already has it without a
    // second resolve.
    trainingDayState: require('./trainingDayState').resolveTrainingDayState({ effectiveWorkout: w }),
    // Canonical training-completion facts — see services/workout.
    // resolveTrainingOutcome. `null` (trainingOutcome absent) means "unknown",
    // never "not completed" — brain/claimValidator.js's
    // checkWorkoutCompletionOverclaim only fires on an explicit `false`, so a
    // caller without this fact simply doesn't get the extra check (same
    // backward-compatible pattern as every other canonical fact here).
    plannedWorkoutCompleted: t?.plannedWorkoutCompleted ?? null,
    hardSessionCompleted: t?.hardSessionCompleted ?? null,
    trainingOutcomeStatus: t?.status ?? null,
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
    // Matched-pace baseline (services/wealth-pace.js) — how the MTD total
    // above compares to the median of the same elapsed-fraction-of-month
    // spend across trailing complete months. null (not just an absent field)
    // whenever there isn't enough history to trust a comparison — never a
    // manufactured "typical" from too little data.
    spendingPaceVsTypical: wealth?.spendingPace?.medianBaseline != null ? {
      dollars: wealth.spendingPace.vsMedian?.dollars ?? null,
      pct: wealth.spendingPace.vsMedian?.pct ?? null,
      label: wealth.spendingPace.paceLabel ?? null,
      monthsUsed: wealth.spendingPace.monthsUsed ?? 0,
    } : null,
    // The Context Understanding Layer's canonical projection (see
    // intelligence/context-resolver.js) — passed through verbatim (not
    // flattened) so brain/claimValidator.js's checkResolvedContextConflicts
    // can use its selectors directly. `null` (the default) is the
    // backward-compatible "resolver not available to this caller" state —
    // every check gated on it simply stays silent, same as `facts` itself
    // being null.
    resolvedContext: resolvedContext ?? null,
    // Canonical, per-occurrence, EXPLICITLY-dated nightly context-tag
    // history — see intelligence/nightly-context-history.js. Every entry is
    // a COMPLETED-night observation; brain/claimValidator.js's
    // checkTemporalFraming reads this (via facts.nightlyContextHistory)
    // alongside resolvedContext to reject a generated claim that restates
    // one of these as a current/future plan.
    nightlyContextHistory: nightlyContextHistory || [],
  };
}

/** Compact facts object for the claim validator, projected from a snapshot. */
function canonicalFacts(snapshot) {
  return canonicalFactsFrom({
    recovery: snapshot.recovery.value,
    effectiveWorkout: snapshot.effectiveWorkout.value,
    trainingOutcome: snapshot.trainingOutcome?.value ?? null,
    forecast: snapshot.forecast.value,
    goals: snapshot.goals.value,
    commitments: snapshot.commitments.value,
    experiments: snapshot.experiments.value,
    wealth: snapshot.wealth.value,
    localDate: snapshot.localDate,
    resolvedContext: snapshot.resolvedContext?.value ?? null,
    nightlyContextHistory: snapshot.nightlyContextHistory?.value ?? [],
  });
}

module.exports = {
  buildBrainSnapshot, realtimeTodayContext, canonicalFacts, canonicalFactsFrom, fact,
  canonicalSpendingMtd, SNAPSHOT_VERSION, DEFAULT_TZ,
};
