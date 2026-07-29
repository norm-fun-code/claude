// Briefing router: the main /api/briefing builder (the core "chief of staff"
// synthesis over health/wealth/wisdom/calendar/email data — the single
// largest and most complex route in the app), its mid-day live
// partial-refresh, and the non-blocking rebuild trigger. Twenty-sixth (and
// final) router extraction out of server.js's monolith (see the engineering
// review's #1+#6 recommendation).
//
// This is moved VERBATIM — no internal restructuring. Only the outer
// route-registration boilerplate changed (app.METHOD -> router.METHOD,
// '/api/x' -> '/x', try/catch -> asyncHandler where the original had a
// single outer try/catch; the two CRON_SECRET-style helpers below keep
// their original shape since they had none). Every require('./src/...')
// became require('../...'). Verified via diff-multiset comparison against
// the original block before removing it from server.js.
const express = require('express');
const { withTimeout } = require('../util/async');
const { localDayBoundsUtc, localDateStr } = require('../util/date');
const { fetchCalendarEvents, fetchWorkBusyBlocks } = require('../services/calendar');
const { fetchRandomNotionPage, fetchNotionQuotes } = require('../services/notion');
const { fetchRandomQuote } = require('../services/googleDoc');
const { fetchWeather } = require('../services/weather');
const { generateChiefBrief, generateWisdomInsights } = require('../services/briefing-ai');
const { getEffectiveWorkout } = require('../services/workout');
const { suppressAnsweredOpenQuestion, bindOpenQuestionInstance, formatAnsweredQuestionsContext } = require('../intelligence/open-question-policy');
const openQuestionsStore = require('../store/openQuestions');
const { computeCalendarLoad } = require('../intelligence/calendar-load');

/** Today's plan for the chief-brief prompt, shaped like getWorkout()'s
 *  { type, duration, hrTarget, protein, hrvNote } — but resolved through
 *  getEffectiveWorkout so BOTH a manual day-swap (workout_overrides) AND an
 *  automatic recovery-based downgrade (red recovery band swaps a scheduled
 *  hard session to Mobility, same as the Health tab shows) are reflected
 *  here, not just the static weekly schedule. getTodayWorkout() alone used
 *  to feed this prompt, so "today's authoritative plan" the brief stated
 *  could silently diverge from a swap the user had already made or seen —
 *  a real production case: red recovery auto-swapped a Push session to
 *  Mobility on the Health tab, but the brief still said "scale back today's
 *  Push", never mentioning it had already been swapped for exactly that
 *  reason. `autoSwapNote` carries an explicit, LLM-facing explanation of an
 *  automatic swap so the brief narrates it as already-done and correct
 *  instead of either ignoring it or silently treating Mobility as if it had
 *  always been the static plan. */
/** Pure: getEffectiveWorkout()'s result -> the prompt-facing shape. No I/O — so
 *  every caller that has ALREADY resolved the effective workout once (the full
 *  build's single BrainSnapshot, the cache-hit refresh) can reuse that ONE
 *  read instead of calling getEffectiveWorkout a second time just to get this
 *  shape. */
// briefings.period_start is TIMESTAMPTZ (migrations/001_init.sql), so the pg
// driver hands back a JS Date — serializing it raw via res.json() produces a
// full ISO timestamp ('2026-07-06T00:00:00.000Z'), not the plain YYYY-MM-DD
// weekStart string every OTHER weekStart producer in this codebase uses
// (store/intentions.js's weekStart(), intelligence/review.js's periodStart).
// Every route that surfaces a weekly review's week identity must agree on
// this exact format — openWeeklyReview's mobile cache-key matching and the
// weekly-review route's own regression tests both compare it as a plain date.
function dateOnly(d) {
  if (d == null) return null;
  const iso = d instanceof Date ? d.toISOString() : new Date(d).toISOString();
  return iso.slice(0, 10);
}

function workoutPromptShape(eff) {
  const autoSwapNote = eff.source === 'auto_downgrade'
    ? `NOTE: today's session was AUTOMATICALLY swapped from the scheduled ${eff.scheduledLabel} to ${eff.label} because last night's recovery came in ${eff.recoveryBand}. This already happened — it is not a suggestion — and it was the correct, protective call. If training comes up, acknowledge the swap plainly (e.g. "already eased off to ${eff.label} given ${eff.recoveryBand} recovery — right call") and do NOT tell the user to scale back, modify, or go easier on the ORIGINAL ${eff.scheduledLabel} session, since that is no longer today's plan.`
    : null;
  return {
    type: eff.label,
    duration: eff.duration ?? null,
    hrTarget: eff.hrTarget ?? null,
    protein: eff.protein ?? null,
    hrvNote: 'Green=train as planned | Yellow=downgrade intensity | Red=mobility/walk only',
    autoSwapNote,
  };
}

/** Used only by callers that do NOT already have a resolved effective workout
 *  in hand (the scoped chief-brief-only rebuild, which deliberately skips a
 *  full BrainSnapshot for speed — see buildQuickChiefBriefContext). The full
 *  build must NOT call this — it derives the prompt shape from its ONE
 *  BrainSnapshot via workoutPromptShape() directly instead. */
async function resolveWorkoutForPrompt(tz) {
  const eff = await getEffectiveWorkout({ tz });
  return workoutPromptShape(eff);
}
const { buildWealthInsights } = require('../services/wealth-insights');
const metricsStore = require('../store/metrics');
const findingsStore = require('../store/findings');
const sourcesStore = require('../store/sources');
const { runIngest } = require('../ingest/run');
const { analyze, TREND_STALE_DAYS } = require('../intelligence/analyze');
const { filterEligible } = require('../intelligence/context-semantics');
const { embedPending } = require('../intelligence/embeddings');
const annotationsStore = require('../store/annotations');
const experimentsStore = require('../store/experiments');
const experiments = require('../intelligence/experiments');
const devicesStore = require('../store/devices');
const nudgesStore = require('../store/nudges');
const surfacedStore = require('../store/surfaced');
const briefingsStore = require('../store/briefings');
const recommendationsStore = require('../store/recommendations');
const intentionsStore = require('../store/intentions');
const lifeChaptersStore = require('../store/lifeChapters');
const { asyncHandler } = require('../middleware/asyncHandler');

// Postgres advisory lock (not an in-memory boolean) so "is a rebuild already
// running" is answered correctly across replicas, not just within this one
// process — an in-memory flag is invisible to a sibling instance, so two
// replicas could each start their own 60-90s rebuild concurrently. Arbitrary
// lock id; just needs to not collide with another feature's (see
// scheduler.js's LEADER_LOCK_ID = 727001). Module-level (not just local to
// createBriefingRouter) so notify/morning.js's automatic-trigger guard can
// share the exact same lock — a manual rebuild in flight and an automatic
// trigger firing at the same moment must not both proceed.
const REBUILD_LOCK_ID = 727002;

// recoveryMateriallyChanged now lives in intelligence/recovery.js (it's used
// there too, by the ingestion path — see store/metrics.js's insertMetrics —
// to decide whether a newly-written HRV/RHR/sleep row is worth a
// recovery_change bump, not just by this route's cache-hit path). Re-exported
// below for existing callers/tests that import it from this module.
const { recoveryMateriallyChanged } = require('../intelligence/recovery');

// ── Honest timestamps ────────────────────────────────────────────────────────
// The briefing payload distinguishes three timestamps, so a consumer can tell
// "this whole response was produced now" from "this specific card was actually
// re-derived now":
//   - builtAt      : response PRODUCTION / delivery time. Always advances on
//                    any build or scoped rebuild — the client polls on it as
//                    the "a rebuild finished" signal (mobile useBriefing), so
//                    its meaning and compatibility are preserved exactly.
//   - snapshotAt   : when the underlying FULL-BUILD state snapshot was cut.
//                    Advances only on a full build — NOT on a scoped
//                    chief-brief rebuild (which recut no other field) and NOT
//                    on a cache serve.
//   - fieldsBuiltAt: { field -> ISO } map of when each field was last actually
//                    derived. A scoped chief-brief rebuild advances only
//                    fieldsBuiltAt.chiefBrief; the cache-hit recovery refresh
//                    advances only the recovery-dependent fields. This is what
//                    makes an untouched card no longer masquerade as freshly
//                    rebuilt just because the global builtAt moved.
/** Return a new fieldsBuiltAt map with `fields` stamped to `at` (default now). */
function stampFields(prevMap, fields, at = new Date().toISOString()) {
  const next = { ...(prevMap || {}) };
  for (const f of fields) next[f] = at;
  return next;
}

// The full set of top-level fields a FULL build derives — stamped together at
// the full build's snapshot time.
const FULL_BUILD_FIELDS = [
  'chiefBrief', 'morningFocus', 'recovery', 'todayForecast', 'workout', 'recoveryComposite',
  'wealth', 'wealthInsights', 'healthInsights', 'insights', 'crossContextInsights',
  'forecasts', 'weeklyGoals', 'weeklyReview', 'leverageActions', 'urgentEmails',
];

// Registry field key → briefing response field name. The cache-hit atomic
// refresh derives WHICH fields a recovery change touches from the registry's
// invalidation graph (not a hand-copied list), so a future recovery-derived
// field added to the registry is refreshed here automatically.
// Registry field key → briefing response field name. NOTE: the registry's
// `wealth` field is the buildWealthInsights()/canonicalSpendingMtd authority,
// which surfaces in the response as `wealthInsights` (the display-card array)
// — NOT the separate, unrelated top-level `wealth` object further down in
// this file (a rolling net-worth/weekly-spend snapshot built from raw metric
// aggregation, outside the registry's canonical-fact scope, same as how
// evening-brief/Ask read historical time-series directly). Mapping the
// registry key to the WRONG response field here would silently refresh
// nothing on a transaction_sync.
const REGISTRY_TO_BRIEF_FIELD = {
  recovery: 'recovery', effectiveWorkout: 'workout',
  todayForecast: 'todayForecast', recoveryComposite: 'recoveryComposite',
  wealth: 'wealthInsights',
};

// Registry field keys the briefing's CACHED content tracks a version for.
// goals/weeklyIntention/commitments/eligibleContext are deliberately excluded:
// weeklyGoals is refreshed unconditionally on every cache serve already (cheap,
// no version-gating needed), commitments has no cached representation in this
// payload at all (the Commitments UI reads a separate endpoint), and
// eligibleContext's only visible effect here is through todayForecast (already
// covered — annotation_retirement invalidates todayForecast directly too).
const TRACKED_CACHE_FIELDS = ['recovery', 'effectiveWorkout', 'todayForecast', 'recoveryComposite', 'wealth'];

// Fast, scoped context for POST /briefing/chief-brief/rebuild — recomputes
// only the cheap, side-effect-free, DB-only inputs generateChiefBrief reads,
// so a "just retry the brief text" tap takes seconds, not the full builder's
// 60-90s. Deliberately narrower than the main /briefing builder's context
// (see buildFullBriefingContext-equivalent block further down, which stays
// untouched/verbatim):
//  - calendar/workBusy/emails are reused from the last full build rather than
//    refetched (no external API calls here at all) — they rarely change
//    tap-to-tap, and a full "Rebuild briefing" still refreshes them.
//  - leverageContext is DERIVED from the already-persisted
//    prior.content.leverageActions/forecasts rather than re-querying findings
//    and re-running the main builder's recommendation-ledger dedup/logging —
//    that logging is a write with its own 7-day dedup semantics and must only
//    run from a real full build, not every quick-retry tap.
//  - continuityContext (has a similar write side effect, in curate.js's
//    first-seen tracking) and cashflowContext/progressContext (both
//    Monday-only anyway, and cashflow needs a live Monarch MCP round-trip)
//    are skipped — empty string, same as any other day they don't apply.
// Net effect: a slightly less rich prompt than the full builder's, in
// exchange for being fast and free of write side effects. If this proves
// valuable, the shared pieces are candidates to extract into one function
// both routes call — noted here rather than done blind under time pressure.
async function buildQuickChiefBriefContext(prior) {
  const tz = process.env.TZ || 'America/New_York';
  const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const workout = await resolveWorkoutForPrompt(tz);
  const calendar = prior.content?.calendar ?? [];
  const workBusy = prior.content?.workBusy ?? [];

  const [
    wellbeingContext,
    annotationsAndGaps,
    recoveryContext,
    experimentsContext,
    selfModel,
    strengthContext,
    spendingContext,
    weeklyGoals,
    chaptersContext,
    recoveryDrivers,
    nightlyContextHistory,
  ] = await Promise.all([
    (async () => {
      try {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const avg = async (domain, metric) => {
          const r = await metricsStore.dailyAggregate({ domain, metric, from: since, agg: 'avg' });
          const vals = r.map((x) => Number(x.value)).filter(Number.isFinite);
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        };
        const binaryHabits = ['gratitude', 'morning_tm', 'afternoon_tm', 'exercise'];
        const habitLabels = { gratitude: 'gratitude', morning_tm: 'morning meditation', afternoon_tm: 'afternoon meditation', exercise: 'exercise', eat_healthy: 'eating well' };
        const [mood, energy, focus, ...habitAvgs] = await Promise.all([
          avg('wellbeing', 'mood'), avg('wellbeing', 'energy'), avg('wellbeing', 'focus'),
          ...binaryHabits.map((m) => avg('habits', m)),
          avg('habits', 'eat_healthy'),
        ]);
        const lagging = [];
        binaryHabits.forEach((m, i) => { if (habitAvgs[i] != null && habitAvgs[i] < 0.6) lagging.push(habitLabels[m]); });
        const eatAvg = habitAvgs[binaryHabits.length];
        if (eatAvg != null && eatAvg < 3) lagging.push(habitLabels.eat_healthy);
        const { wellbeingLevel } = require('../intelligence/catalog');
        const parts = [];
        if (mood != null) parts.push(`mood ${wellbeingLevel(mood)}`);
        if (energy != null) parts.push(`energy ${wellbeingLevel(energy)}`);
        if (focus != null) parts.push(`focus ${wellbeingLevel(focus)}`);
        if (lagging.length) parts.push(`slipping on ${lagging.slice(0, 3).join(', ')}`);
        return parts.join('; ');
      } catch (err) {
        console.error('[quick chief-brief] wellbeing context failed:', err.message);
        return '';
      }
    })(),
    (async () => {
      let ctx = '';
      let rows = [];
      try {
        const { start: startOfToday } = localDayBoundsUtc(process.env.TZ || 'America/New_York');
        const active = await annotationsStore.overlapping(startOfToday, new Date());
        // 'general' purpose — excludes retractions/retired/financial (see
        // context-semantics.js) but keeps planned/occurred/negated, all of
        // which are legitimate acknowledged context for a quick brief.
        const eligible = filterEligible(active, { purpose: 'general' });
        rows = eligible;
        if (eligible.length) {
          ctx = eligible
            .map((a) => `${a.label}${a.note ? ` (${a.note})` : ''}`)
            .slice(0, 5)
            .join('; ');
        }
      } catch (err) {
        console.error('[quick chief-brief] annotations context failed:', err.message);
      }
      try {
        const { describeDataGaps } = require('../intelligence/source-health');
        const allSources = await sourcesStore.listSources();
        const gaps = describeDataGaps(allSources);
        if (gaps.length) {
          const warning = `DATA GAPS — these sources have not synced recently: ${gaps.join('; ')}. Caveat any claims that rely on this data.`;
          ctx = ctx ? `${ctx}; ${warning}` : warning;
        }
      } catch (err) {
        console.error('[quick chief-brief] pipeline health failed:', err.message);
      }
      // Raw rows kept alongside the rendered text (not just the string) so
      // the caller can partition them against a compiled resolvedContext —
      // see intelligence/context-resolver.js's partitionRawContext (audit
      // fix, item 2) — and re-append only the genuinely unmatched subset.
      return { text: ctx, rows };
    })(),
    (async () => {
      try {
        const recovery = await require('../intelligence/recovery').liveRecovery();
        if (recovery?.score == null) {
          return 'UNAVAILABLE — Eight Sleep device not worn recently. Do NOT reference HRV, resting heart rate, or recovery score in today\'s brief.';
        }
        let ctx = `score ${recovery.score}/100 (${recovery.band ?? 'unknown'} band)`;
        if (recovery.rawHrv != null) ctx += `, HRV ${Math.round(recovery.rawHrv)}ms`;
        if (recovery.rawRhr != null) ctx += `, RHR ${Math.round(recovery.rawRhr)}bpm`;
        if (recovery.proxy) ctx += ' — SELF-REPORTED (no Eight Sleep reading last night; this is a subjective estimate, not a real HRV/RHR measurement).';
        return ctx;
      } catch (err) {
        console.error('[quick chief-brief] recovery context failed:', err.message);
        return '';
      }
    })(),
    (async () => {
      try {
        const allExps = await experimentsStore.listExperiments();
        const lines = [];
        for (const e of allExps.filter((e) => e.status === 'running').slice(0, 4)) lines.push(`⟳ Running: ${e.hypothesis}`);
        for (const e of allExps.filter((e) => e.status === 'paused').slice(0, 3)) lines.push(`⏸ Paused by the user: ${e.hypothesis} — do not reference as active, running, or logging`);
        return lines.join('\n');
      } catch (err) {
        console.error('[quick chief-brief] experiments context failed:', err.message);
        return '';
      }
    })(),
    (async () => {
      try {
        let text = (await require('../store/selfModel').latestModelText()) ?? '';
        text = text.replace(/^WEALTH:.*$/m, (line) => {
          const spend = line.match(/MTD[^$]*spending \$[\d,]+(?: \(excludes[^)]*\))?/);
          return spend ? `WEALTH: ${spend[0]}` : '';
        });
        return text;
      } catch (err) {
        console.error('[quick chief-brief] selfModel failed:', err.message);
        return '';
      }
    })(),
    require('../intelligence/strength-progression').topProgressionNote({ days: 45, minSessions: 3 }).catch(() => ''),
    (async () => {
      try {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const yestDate = yesterday.toLocaleDateString('en-CA', { timeZone: tz });
        const yestFrom = new Date(`${yestDate}T00:00:00Z`);
        const yestTo = new Date(yestFrom.getTime() + 24 * 60 * 60 * 1000);
        const baselineFrom = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
        const [yestRows, baselineRows] = await Promise.all([
          metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending_discretionary', from: yestFrom, to: yestTo, agg: 'sum', excludeSource: 'seed' }),
          metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending_discretionary', from: baselineFrom, to: yestFrom, agg: 'sum', excludeSource: 'seed' }),
        ]);
        const yestTotal = yestRows.reduce((s, r) => s + Number(r.value || 0), 0);
        const recentSpend = yestTotal > 0 ? yestTotal : null;
        const spendBaseline = baselineRows.length >= 7
          ? baselineRows.reduce((s, r) => s + Number(r.value || 0), 0) / baselineRows.length
          : null;
        if (recentSpend != null && spendBaseline != null && spendBaseline > 10 && recentSpend > spendBaseline * 1.8) {
          const mult = (recentSpend / spendBaseline).toFixed(1);
          return `Discretionary spending yesterday was $${Math.round(recentSpend)} vs a $${Math.round(spendBaseline)}/day average (${mult}× normal).`;
        }
        return '';
      } catch (err) {
        console.error('[quick chief-brief] spending context failed:', err.message);
        return '';
      }
    })(),
    // ONE currentIntention() read feeds the prose context, the structured
    // liveGoals used by the goal-completion guard, AND goalsWeekStart (the
    // explicit period identity this chiefBrief's goal claims describe) — a
    // single canonical fetch instead of two independent re-derivations of
    // the same row (truth-and-evidence contract, audit priority #1: every
    // surface must stamp WHICH week's goals a "done"/"open" claim is about,
    // so a cache-served chiefBrief generated against a NOW-PRIOR week can
    // never silently look like it's describing this week's goals).
    (async () => {
      try {
        const currentInt = await intentionsStore.currentIntention();
        const goals = currentInt?.goals ?? [];
        const liveGoals = goals.map((g) => ({ text: g.text, achieved: !!g.achieved }));
        if (!goals.length) return { weeklyGoalsContext: '', liveGoals, goalsWeekStart: currentInt?.weekStart ?? null };
        const done = goals.filter((g) => g.achieved).map((g) => `[done] ${g.text}`);
        const open = goals.filter((g) => !g.achieved).map((g) => `[OPEN] ${g.text}`);
        const weeklyGoalsContext = `${[...open, ...done].join(' · ')}` + (currentInt?.context ? ` (week context: "${String(currentInt.context).slice(0, 300)}")` : '');
        return { weeklyGoalsContext, liveGoals, goalsWeekStart: currentInt?.weekStart ?? null };
      } catch (err) {
        console.error('[quick chief-brief] weeklyGoals context failed:', err.message);
        return { weeklyGoalsContext: '', liveGoals: [], goalsWeekStart: null };
      }
    })(),
    (async () => {
      try {
        const chapters = await lifeChaptersStore.listActive();
        return require('../intelligence/chapters').composeChapterContext(chapters);
      } catch (err) {
        console.error('[quick chief-brief] chapters context failed:', err.message);
        return '';
      }
    })(),
    require('../intelligence/recovery-drivers').computeRecoveryDrivers({ tz })
      .catch((err) => { console.error('[quick chief-brief] recovery drivers failed:', err.message); return { context: '', labels: [] }; }),
    // Same canonical authority the full build's brainSnapshot composes (see
    // brain/registry.js's nightlyContextHistory field) — the scoped rebuild
    // doesn't build a full snapshot, so this is its own direct, cheap,
    // DB-only call, exactly like recoveryDrivers above and resolvedContext
    // below. Ensures both build paths validate against IDENTICAL canonical
    // temporal facts (required test: full build and scoped rebuild receive
    // identical canonical temporal facts).
    require('../intelligence/nightly-context-history').computeNightlyContextHistory({ tz })
      .catch((err) => { console.error('[quick chief-brief] nightly context history failed:', err.message); return []; }),
  ]);

  // Derived from persisted output, not a fresh findings query — see the
  // function header comment for why (avoids re-running the leverage
  // engine's recommendation-ledger side effects on every quick-retry tap).
  const lev = (prior.content?.leverageActions ?? []).map((f, i) => `${i + 1}. ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
  const risks = (prior.content?.forecasts ?? [])
    .filter((f) => f.status === 'off_track' || f.status === 'at_risk')
    .slice(0, 2)
    .map((f) => `- ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
  const leverageParts = [];
  if (lev.length) leverageParts.push(`HIGHEST-LEVERAGE ACTIONS (leverage engine):\n${lev.join('\n')}`);
  if (risks.length) leverageParts.push(`TRENDING WRONG (at-risk forecasts):\n${risks.join('\n')}`);

  let dayOffContext = '';
  try {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    dayOffContext = require('../util/dayContext').describeDayOff(todayStr);
  } catch { /* non-critical */ }

  return {
    emails: [], // raw email list isn't persisted; urgentEmails is carried over as-is by the caller instead
    dayName,
    workout,
    calendar,
    workBusy,
    wellbeingContext,
    annotationsContext: annotationsAndGaps.text,
    annotationsRows: annotationsAndGaps.rows,
    recoveryContext,
    experimentsContext,
    selfModel,
    leverageContext: leverageParts.join('\n\n'),
    strengthContext,
    spendingContext,
    continuityContext: '', // has write side effects in the full builder — skipped here, see header comment
    cashflowContext: '', // Monday-only + a live Monarch round-trip — skipped for speed
    progressContext: '', // Monday-only — skipped for speed
    weeklyGoalsContext: weeklyGoals.weeklyGoalsContext,
    chaptersContext,
    dayOffContext,
    liveGoals: weeklyGoals.liveGoals,
    // The explicit week identity these liveGoals/weeklyGoalsContext describe
    // — carried through to the response so a cache-served chiefBrief can
    // never silently look like it's about a DIFFERENT (now-current) week's
    // goals than the one it was actually generated against.
    goalsWeekStart: weeklyGoals.goalsWeekStart,
    recoveryDriversContext: recoveryDrivers.context,
    recoveryDriverLabels: recoveryDrivers.labels,
    nightlyContextHistory,
    nightlyContextHistoryContext: require('../intelligence/nightly-context-history').renderNightlyContextHistoryPrompt(nightlyContextHistory),
  };
}


/**
 * Build a fresh (or cache-served) daily briefing and return the response
 * payload. Extracted so both GET /briefing AND the two internal "warm the
 * cache" callers (POST /briefing/rebuild, notify/morning.js's warmBriefing)
 * invoke the exact same logic directly instead of each doing a loopback HTTP
 * round-trip to this same process's own /api/briefing?refresh=1 — the
 * loopback pattern adds an unnecessary network hop and its own failure mode
 * for what is, underneath, a same-process function call. force=true skips
 * the cache and always rebuilds (mirrors ?refresh=1).
 */
async function buildFreshBriefing({ force = false, publish = true } = {}) {
  const errors = [];

  // Serve a cached briefing instantly unless force. Building fresh calls
  // the LLM + weather/calendar/Notion/embeddings (~60-90s), so we always
  // serve the last build immediately. The scheduler pre-builds at 8:30am so the
  // cache is warm. Pull-to-refresh serves cache instantly; the explicit per-tab
  // "Rebuild" button forces a new build.
  //
  // We never auto-rebuild on non-forced requests — doing so caused a silent
  // failure loop: the 60-90s build exceeded the client's 45s timeout, the request
  // was aborted, and the app got stuck on yesterday's data with no visible error.
  const CACHE_TTL_MIN = Number(process.env.BRIEFING_CACHE_MIN || 180); // stale threshold
  const tz = process.env.TZ || 'America/New_York';

  // The most recent prior build, and whether it was built earlier *today* (in the
  // user's timezone). Used for the daily-lock: the "wisdom" content (library
  // highlight, daily quote, Notion page + the Gemini insights on them) is chosen
  // on the first build of the day and then carried over on every later build so
  // it stays static until midnight. Dynamic data (weather, calendar, email,
  // findings) still refreshes every build.
  let prior = null;
  let priorIsToday = false;
  try {
    prior = await briefingsStore.latestBriefing('daily');
    if (prior?.generated_at) {
      const localDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
      priorIsToday = localDate(prior.generated_at) === localDate(new Date());
    }
  } catch (err) {
    console.error('[briefing prior] read failed:', err.message);
  }

  // A cached row built under an OLDER snapshot contract (SNAPSHOT_VERSION —
  // see brain/snapshot.js) may carry a claim the CURRENT validator would
  // reject but the row's own build never checked for (the temporal-grounding
  // fix, v1->v2, is exactly this: a v1 row can contain a false "tonight"
  // claim generated from a historical context tag with no checkTemporalFraming
  // to catch it). Missing snapshotVersion (pre-dates the field entirely) is
  // treated the same as "older" — fail toward a fresh rebuild, not toward
  // trusting unvalidated old content. This never mutates or deletes the old
  // row — history is preserved; the row is simply not eligible for the
  // cache-hit fast path, so the very next request forces a real rebuild
  // (stamping the current version) instead of serving it indefinitely.
  const cacheContractCurrent = (prior?.content?.snapshotVersion ?? 0) >= require('../brain/snapshot').SNAPSHOT_VERSION;

  if (!force && prior?.content && cacheContractCurrent) {
    const ageMin = prior.generated_at
      ? (Date.now() - new Date(prior.generated_at).getTime()) / 60000
      : 0;
    const isStale = ageMin >= CACHE_TTL_MIN;
    // Refresh the cheap, fast-changing weekly-goal state even on a cached serve.
    // The "Goals hit" tile and the goal checkboxes read this; without the live
    // refresh, checking off a goal wouldn't move the count until the next full
    // (60-90s LLM) rebuild — making the checkboxes feel broken.
    let weeklyGoals = prior.content.weeklyGoals ?? null;
    try {
      const [currentInt, priorInt] = await Promise.all([
        intentionsStore.currentIntention(),
        intentionsStore.priorIntention(),
      ]);
      if (currentInt || priorInt) weeklyGoals = { current: currentInt ?? null, prior: priorInt ?? null };
    } catch (err) {
      console.error('[briefing cache] weeklyGoals refresh failed:', err.message);
    }
    // Apply insight dismissals live too, so dismissing a card sticks on the next
    // instant cache reload rather than waiting for a full rebuild.
    const cachedContent = { ...prior.content };

    // Read-time recovery for an already-corrupted/pending `prior` row, AND
    // for a `prior` that is honest but from a PREVIOUS calendar day (Chief
    // Brief regression fix — Backend requirements #2/#3/#8/#9): `prior`'s OWN
    // chiefBrief may be null/pending (a destructive repair row from before
    // this fix, or a same-day build that never finished) even though an
    // EARLIER same-day build published a perfectly good card — or `prior`
    // itself may simply predate today (this cache-hit branch has no day
    // boundary of its own; it only gates on TTL age, so a build from late
    // last night can still be "not stale enough" to force a rebuild shortly
    // after midnight). Either way, this never mutates or deletes anything —
    // it only decides what THIS response's cachedContent.chiefBrief shows,
    // and it is ALWAYS scoped to TODAY's actual local day (never a previous
    // day's content silently masquerading as today's, and never reaching
    // past today into an even-older day either).
    const todayLocalDay = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const priorLocalDay = prior.generated_at ? new Date(prior.generated_at).toLocaleDateString('en-CA', { timeZone: tz }) : null;
    const chiefBriefNeedsRecovery = priorLocalDay !== todayLocalDay || !briefingsStore.isPublishableRow(cachedContent);
    // Set only when a recovery actually swaps in an OLDER row's chiefBrief —
    // carries THAT row's own builtAt/snapshotId for chiefBriefProvenance
    // (below) without touching cachedContent's global snapshotId/snapshotAt/
    // builtAt. Those three feed todayCommandCenter and the rest of this same
    // response (recovery/wealth/forecasts/todayForecast), which still
    // reflect `prior`'s own (newer) snapshot cut — overwriting them with the
    // recovered row's older identity would ship an internally inconsistent
    // payload (chiefBriefProvenance is the ONLY place the recovered row's
    // own build identity belongs).
    let recoveredProvenance = null;
    if (chiefBriefNeedsRecovery) {
      try {
        const lastGoodRow = await briefingsStore.latestPublishableDailyForLocalDay(todayLocalDay, { tz });
        if (lastGoodRow) {
          cachedContent.chiefBrief = lastGoodRow.content.chiefBrief;
          cachedContent.morningFocus = lastGoodRow.content.morningFocus || '';
          cachedContent.chiefBriefPending = false;
          cachedContent.chiefBriefStale = true;
          cachedContent.goalsWeekStart = lastGoodRow.content.goalsWeekStart ?? null;
          recoveredProvenance = {
            builtAt: lastGoodRow.content.builtAt ?? null,
            snapshotId: lastGoodRow.content.snapshotId ?? null,
          };
        } else if (priorLocalDay !== todayLocalDay) {
          // No usable row for today exists at all, and `prior` is from a
          // previous day — an honest pending state, never yesterday's brief
          // shown as today's.
          cachedContent.chiefBrief = null;
          cachedContent.chiefBriefPending = true;
          cachedContent.chiefBriefStale = false;
        }
      } catch (err) {
        console.error('[briefing cache] last-good recovery scan failed:', err.message);
      }
    }

    // The cached chiefBrief's goal-completion claims were validated against
    // whatever week was current AT BUILD TIME (cachedContent.goalsWeekStart)
    // — if the week has rolled over since (weeklyGoals.current is now
    // refreshed live, above, and can be a NEWER week), that chiefBrief can be
    // describing an already-past week's "all done" goals while this same
    // response's live weeklyGoals shows fresh unchecked ones. Flag it
    // explicitly rather than let the two silently disagree (truth-and-
    // evidence contract, audit priority #1).
    let chiefBriefGoalsStale = Boolean(
      cachedContent.goalsWeekStart && weeklyGoals?.current?.weekStart
        && cachedContent.goalsWeekStart !== weeklyGoals.current.weekStart
    );

    // Automatic stale-period repair (Today-tab cleanup, Part 2): NormOS must
    // detect and repair a stale period-dependent claim itself, not knowingly
    // serve it and ask the user to tap refresh. One idempotent SCOPED rebuild
    // (chiefBrief/morningFocus only — see performScopedChiefBriefRebuild,
    // reused verbatim from the manual ↻ endpoint, not reimplemented) fixes
    // the overwhelmingly common case (the week rolled over; a fresh
    // generation against the now-current week's goals just isn't stale
    // anymore). A FAILED repair attempt no longer nulls out chiefBrief (see
    // performScopedChiefBriefRebuild's own header comment): it falls back to
    // the same last-known-good content the recovery block above would have
    // used, and chiefBriefGoalsStale (recomputed after the repair, below)
    // stays the deterministic, explicit qualifier on the one stale
    // goal-dependent claim — the brief itself is never deleted over it.
    //
    // Loop protection: store/chiefBriefRepairLedger.js's durable
    // 'goals_stale' attempt marker (a failed attempt records a cooldown tied
    // to the specific week it was trying to fix — an outage that makes every
    // attempt fail degrades to "try again in REPAIR_COOLDOWN_MS" rather than
    // firing a full LLM call on every single cache-hit request). No push
    // notification is sent from this path (performScopedChiefBriefRebuild
    // only saves the briefing row on SUCCESS; briefing.js's cache-hit serve
    // has never sent notifications) and no unrelated section (recovery/
    // wealth/insights/etc., all untouched here) is rebuilt.
    if (chiefBriefGoalsStale) {
      const REPAIR_COOLDOWN_MS = 10 * 60 * 1000;
      const repairLedger = require('../store/chiefBriefRepairLedger');
      try {
        const eligible = await repairLedger.eligibleForRepair('goals_stale', {
          contextKey: weeklyGoals?.current?.weekStart ?? null, cooldownMs: REPAIR_COOLDOWN_MS,
        });
        if (eligible) {
          const repaired = await performScopedChiefBriefRebuild(prior, { repairReason: 'goals_stale' });
          Object.assign(cachedContent, repaired.content);
          chiefBriefGoalsStale = Boolean(cachedContent.chiefBriefGoalsStale);
        }
      } catch (err) {
        console.error('[briefing cache] automatic goals-staleness repair failed:', err.message);
      }
    }

    // Hoisted out of the try block below (not a fresh const there) so
    // "On My Radar"'s buildTodayCommandCenter call further down can reuse
    // the SAME fetched set for its own dismiss filter — one query, not two.
    let dismissedKeysSet = new Set();
    try {
      const dismissedInsights = require('../store/dismissedInsights');
      dismissedKeysSet = await dismissedInsights.dismissedKeys();
      for (const k of ['insights', 'wealthInsights', 'healthInsights', 'crossContextInsights']) {
        if (Array.isArray(cachedContent[k])) cachedContent[k] = dismissedInsights.applyDismissals(cachedContent[k], dismissedKeysSet);
      }
    } catch (err) {
      console.error('[briefing cache] dismissals failed:', err.message);
    }
    // ── Version-gated staleness check ───────────────────────────────────────
    // Pull the authoritative (DB-backed, cross-instance) versions before
    // deciding what's stale. A mutation this cache-hit path must react to — a
    // belated Eight Sleep sync, a workout override with recovery UNCHANGED, a
    // Monarch transaction sync, an annotation retirement — may have been
    // applied by ANOTHER request, another server instance, or by THIS
    // process's own post-response ingestion priming after an earlier build
    // (see buildFreshBriefing's post-persist section) — refresh() is what
    // keeps this decision from depending on process-local memory alone (see
    // brain/invalidation.js's header for the multi-instance contract).
    const inv = require('../brain/invalidation');
    await inv.refresh().catch(() => {});
    const cachedVersions = cachedContent.fieldVersions || {};
    const versionStale = (field) => inv.versionOf(field) !== (cachedVersions[field] ?? 0);

    try {
      const priorRecovery = cachedContent.recovery; // the value baked into the cached derived fields
      const freshRecovery = await require('../intelligence/recovery').liveRecovery();
      cachedContent.recovery = freshRecovery ?? null;
      const tz = process.env.TZ || 'America/New_York';
      const recoveryValueChanged = recoveryMateriallyChanged(priorRecovery, freshRecovery);

      // Workout staleness is checked and refreshed INDEPENDENTLY of whether
      // recovery data happens to be present. An override lands on
      // workout_overrides regardless of last night's HRV — gating this behind
      // "recovery is present" (the old shape: workout only ever refreshed
      // inside the recovery-present branch) meant a workout override on a day
      // with NO recovery reading never reached a cache-hit response at all,
      // even though the bus correctly flagged effectiveWorkout as stale.
      const workoutStale = recoveryValueChanged || versionStale('effectiveWorkout');
      let freshEff = null;
      if (workoutStale) {
        try {
          // ONE getEffectiveWorkout call, band passed explicitly from the
          // recovery we just re-read (possibly null) — not a second
          // self-fetching call via the old resolveWorkoutForPrompt(tz).
          freshEff = await getEffectiveWorkout({ tz, band: freshRecovery?.band ?? null });
          cachedContent.workout = workoutPromptShape(freshEff);
          cachedContent.effectiveWorkout = freshEff;
          cachedContent.fieldsBuiltAt = stampFields(cachedContent.fieldsBuiltAt, ['workout']);
        } catch (e) { console.error('[briefing cache] workout recompute failed:', e.message); }
      }

      if (!freshRecovery) {
        // No fresh recovery data (device away) — todayForecast capacity is
        // recovery-driven, so null it; drop the stale recovery composite so
        // neither the Health RecoveryCard nor the Today TodayForecastCard show
        // stale green data. (Workout, above, is refreshed independently of this.)
        cachedContent.todayForecast = { capacity: null, sleepDebt: cachedContent.todayForecast?.sleepDebt ?? null };
        if (Array.isArray(cachedContent.healthComposites)) {
          cachedContent.healthComposites = cachedContent.healthComposites.filter((c) => c?.type !== 'recovery');
        }
        cachedContent.fieldsBuiltAt = stampFields(cachedContent.fieldsBuiltAt, ['recovery', 'todayForecast', 'recoveryComposite']);
      } else {
        const forecastStale = recoveryValueChanged || workoutStale || versionStale('todayForecast');
        if (forecastStale) {
          try {
            cachedContent.todayForecast = await require('../intelligence/predict')
              .computeTodayForecast({ recovery: freshRecovery, effectiveWorkout: freshEff ?? undefined });
            cachedContent.fieldsBuiltAt = stampFields(cachedContent.fieldsBuiltAt, ['todayForecast']);
          } catch (e) { console.error('[briefing cache] todayForecast recompute failed:', e.message); }
        }
        // recoveryComposite: keep its score/band consistent with the fresh
        // recovery in place (the visible inconsistency was score/band).
        const compositeStale = recoveryValueChanged || versionStale('recoveryComposite');
        if (compositeStale && Array.isArray(cachedContent.healthComposites) && freshRecovery.score != null) {
          const idx = cachedContent.healthComposites.findIndex((c) => c?.type === 'recovery');
          if (idx !== -1) {
            const { band } = require('../intelligence/recovery').recoveryBand(freshRecovery.score);
            const c = cachedContent.healthComposites[idx];
            cachedContent.healthComposites = [...cachedContent.healthComposites];
            cachedContent.healthComposites[idx] = {
              ...c,
              title: `Recovery ${freshRecovery.score}/100 — ${band}`,
              evidence: { ...(c.evidence || {}), score: freshRecovery.score, band, parts: freshRecovery.parts ?? c.evidence?.parts },
            };
            cachedContent.fieldsBuiltAt = stampFields(cachedContent.fieldsBuiltAt, ['recoveryComposite']);
          }
        }
        if (recoveryValueChanged) {
          cachedContent.fieldsBuiltAt = stampFields(cachedContent.fieldsBuiltAt, ['recovery']);
        }
      }
    } catch { /* non-critical — leave cached value on error */ }

    // Automatic trainingDayState-contract repair: invalidate and rebuild a
    // STORED brief whose chiefBrief text fails the canonical training-day
    // contract (brain/trainingDayState.js) even though it otherwise passes
    // cache freshness — the production incident this exists to fix was
    // exactly a cached brief whose headline/action disagreed with the
    // authoritative effective workout. This runs AFTER the workout-refresh
    // block above so it always validates against the freshest
    // cachedContent.effectiveWorkout, never a stale one (a workout override
    // applied moments before this exact request must be reflected here).
    // Same idempotent, cooldown-gated, no-notification scoped rebuild
    // mechanism as the goals-staleness repair above (performScopedChiefBriefRebuild),
    // and the durable store/chiefBriefRepairLedger.js cooldown. A failed
    // repair attempt falls back to the last-known-good same-day content
    // (same as every other caller of performScopedChiefBriefRebuild) — safe
    // even when that carried-forward text is the same still-contradictory
    // brief, because todayCommandCenter.buildTodayCommandCenter (below) ALSO
    // runs this same trainingDayState check on EVERY serve, unconditionally,
    // and neutralizes the DISPLAY (deterministic conflict-resolution copy,
    // action suppressed) regardless of whether this repair fires or
    // succeeds — it can never reach the user raw. This block's real job is
    // fixing the underlying STORED text so other consumers of
    // cachedContent.chiefBrief (Ask/voice, notifications) don't keep reading
    // the bad copy either; the render-time guard is what actually keeps the
    // user safe either way.
    if (!cachedContent.chiefBriefPending && cachedContent.chiefBrief) {
      try {
        const { resolveTrainingDayState, validateTrainingDayContent } = require('../brain/trainingDayState');
        const tds = resolveTrainingDayState({ effectiveWorkout: cachedContent.effectiveWorkout });
        const { valid } = validateTrainingDayContent(tds, {
          synthesis: cachedContent.chiefBrief.synthesis, action: cachedContent.chiefBrief.action,
          risk: cachedContent.chiefBrief.risk, move: cachedContent.chiefBrief.move,
        });
        if (!valid) {
          const REPAIR_COOLDOWN_MS = 10 * 60 * 1000;
          const repairLedger = require('../store/chiefBriefRepairLedger');
          const eligible = await repairLedger.eligibleForRepair('plan_conflict', { cooldownMs: REPAIR_COOLDOWN_MS });
          if (eligible) {
            const repaired = await performScopedChiefBriefRebuild(prior, { repairReason: 'plan_conflict' });
            Object.assign(cachedContent, repaired.content);
          }
        }
      } catch (err) {
        console.error('[briefing cache] automatic trainingDayState repair failed:', err.message);
      }
    }

    // Wealth: version-gated only — unlike recovery there's no cheap "did the
    // value move" signal to check first, so a transaction_sync bump is the
    // ONLY trigger. Recomputes through the SAME authorities the snapshot
    // itself uses (buildWealthInsights + canonicalSpendingMtd), so a cache-hit
    // refresh can never disagree with what a full build would have produced.
    if (versionStale('wealth')) {
      try {
        const wtz = process.env.TZ || 'America/New_York';
        const { canonicalSpendingMtd } = require('../brain/snapshot');
        const [insights] = await Promise.all([buildWealthInsights(), canonicalSpendingMtd(new Date(), wtz)]);
        cachedContent.wealthInsights = insights;
        cachedContent.fieldsBuiltAt = stampFields(cachedContent.fieldsBuiltAt, ['wealthInsights']);
      } catch (e) { console.error('[briefing cache] wealth recompute failed:', e.message); }
    }

    // Sync fieldVersions to the CURRENT bus state so the NEXT cache-hit
    // compares against an up-to-date baseline — every tracked field's version
    // now matches what this response actually reflects, whether or not it
    // needed a refresh this time (an untouched field's version already matched).
    cachedContent.fieldVersions = Object.fromEntries(TRACKED_CACHE_FIELDS.map((f) => [f, inv.versionOf(f)]));

    // Freshen the fitness (VO2 max) insight's CURRENT reading on every cache
    // serve — same reasoning as recovery/weeklyGoals/weeklyReview above. VO2
    // samples are live device values (mobile pushes new HealthKit readings to
    // the spine on every Health tab open), but this cached finding's
    // title/detail were baked in by whenever analyze() last ran, which for
    // nearly all requests (this IS the branch that serves them) can be hours
    // stale. VO2 barely moves day to day, so the trend (per90) is fine staying
    // batch-computed; it's specifically "current" that a live push can outrun,
    // producing two different VO2 numbers on the same tab (caught via a
    // product screenshot review). One cheap latest() query; leaves the cached
    // value untouched on any error or if there's no fitness insight cached.
    if (Array.isArray(cachedContent.healthInsights)) {
      const fitnessIdx = cachedContent.healthInsights.findIndex((f) => f.type === 'fitness');
      if (fitnessIdx !== -1) {
        try {
          const latestVo2 = await metricsStore.latest({ domain: 'health', metric: 'vo2_max' });
          const current = latestVo2?.value != null ? Number(latestVo2.value) : null;
          if (current != null) {
            const { formatFitnessFinding } = require('../intelligence/recovery');
            const per90 = cachedContent.healthInsights[fitnessIdx].evidence?.per90 ?? null;
            const { title, detail } = formatFitnessFinding(current, per90);
            const round1 = (n) => Math.round(n * 10) / 10;
            cachedContent.healthInsights = [...cachedContent.healthInsights];
            cachedContent.healthInsights[fitnessIdx] = {
              ...cachedContent.healthInsights[fitnessIdx],
              title, detail,
              // evidence.current must be refreshed alongside title/detail — a
              // prior version of this freshen only updated the prose, leaving
              // evidence.current (the ONE field the mobile Health screen and
              // Ask/briefing context should all read for cross-surface
              // identity) silently stale and disagreeing with the headline
              // (the exact "46.3 vs 46.6" production bug).
              evidence: { ...(cachedContent.healthInsights[fitnessIdx].evidence || {}), current: round1(current), asOf: latestVo2?.ts ?? null },
            };
          }
        } catch (err) {
          console.error('[briefing cache] fitness freshen failed:', err.message);
        }
      }
    }

    // Re-fetch weekly review on every cache serve so the parsed/recovered version
    // always shows — the stored briefing may have the raw-JSON-as-narrative fallback.
    let weeklyReview = cachedContent.weeklyReview ?? null;
    try {
      const wr = await briefingsStore.latestBriefing('weekly');
      if (wr) {
        const contentObj = wr.content;
        // 'Weekly review' is the exact fallback headline set when extractJson fails
        // at generation time. A real review always has a specific punchy headline.
        // Suppress the broken record so the card hides rather than rendering raw JSON.
        if (contentObj?.headline !== 'Weekly review') {
          // id/weekStart: stable identity for the canonical openWeeklyReview
          // action (mobile) — the SAME row this payload's narrative came
          // from, never re-derived from title text or array position.
          weeklyReview = { ...contentObj, generatedAt: wr.generated_at, id: wr.id, weekStart: dateOnly(wr.period_start) };
        }
      }
    } catch (err) {
      console.error('[briefing cache] weeklyReview refresh failed:', err.message);
    }
    // Today command-center: recomputed fresh on EVERY cache-hit serve (cheap —
    // one attention-ledger query, no rebuild) rather than served from
    // whatever was stored, so "Since This Morning" and the risk gate reflect
    // what's true right now, not what was true when this row was cached.
    let todayCommandCenter = cachedContent.todayCommandCenter ?? null;
    try {
      todayCommandCenter = await require('../brain/todayCommandCenter').buildTodayCommandCenter({
        snapshotId: cachedContent.snapshotId, snapshotVersion: cachedContent.snapshotVersion,
        snapshotAt: cachedContent.snapshotAt, builtAt: cachedContent.builtAt,
        tz: cachedContent.timezone || process.env.TZ || 'America/New_York',
        chiefBrief: cachedContent.chiefBrief, chiefBriefStale: cachedContent.chiefBriefStale,
        chiefBriefPending: cachedContent.chiefBriefPending, chiefBriefQuality: cachedContent.chiefBriefQuality,
        goalsWeekStart: cachedContent.goalsWeekStart, chiefBriefGoalsStale,
        forecasts: cachedContent.forecasts, todayForecast: cachedContent.todayForecast,
        healthInsights: cachedContent.healthInsights, wealthInsights: cachedContent.wealthInsights,
        weeklyReview, wealth: cachedContent.wealth, recovery: cachedContent.recovery,
        effectiveWorkout: cachedContent.effectiveWorkout, dismissed: dismissedKeysSet,
      });
    } catch (err) {
      console.error('[todayCommandCenter] cache-hit build failed:', err.message);
    }

    // Wealth redesign (audit rec #5) — the one canonical Wealth landing
    // projection, recomputed fresh on EVERY cache-hit serve (cheap — metric
    // aggregates + a couple of small store reads, no LLM), same design
    // choice as todayCommandCenter above: the Wealth tab must never show a
    // posture/action computed from a stale cached cut when the underlying
    // data has moved since.
    let wealthLanding = cachedContent.wealthLanding ?? null;
    try {
      wealthLanding = await require('../services/wealth-landing').buildWealthLandingProjection({ tz: cachedContent.timezone || process.env.TZ || 'America/New_York' });
    } catch (err) {
      console.error('[wealthLanding] cache-hit build failed:', err.message);
    }

    // Unambiguous displayed-content-vs-attempt-state contract (Chief Brief
    // regression fix, requirement #7) — computed from whatever cachedContent
    // ended up holding above (untouched cache, or merged repair/recovery
    // result), so it always describes what THIS response actually returns.
    const { buildChiefBriefContract, attemptStateFromQuality } = require('../brain/chiefBriefContract');
    const contractFields = buildChiefBriefContract({
      chiefBrief: cachedContent.chiefBrief,
      source: cachedContent.chiefBriefStale ? 'last_good' : 'fresh',
      localDate: cachedContent.localDate ?? null,
      // A recovered (older) row's own build identity — NOT this response's
      // global builtAt/snapshotId, which stayed untouched above precisely so
      // it wouldn't drift from the rest of this same payload.
      builtAt: recoveredProvenance?.builtAt ?? cachedContent.builtAt ?? null,
      snapshotId: recoveredProvenance?.snapshotId ?? cachedContent.snapshotId ?? null,
      attemptState: attemptStateFromQuality(cachedContent.chiefBriefQuality?.status ?? null, cachedContent.chiefBrief != null),
      attemptedAt: cachedContent.builtAt ?? null,
      reasonCodes: cachedContent.chiefBriefQuality?.reasonCodes ?? [],
      persistenceFailed: Boolean(cachedContent.persistenceFailed),
    });

    // Always serve the cache — never block the client on a 60-90s rebuild.
    // `stale: true` signals the app to show a "Rebuild briefing" button.
    return {
      ...cachedContent, weeklyGoals, weeklyReview, chiefBriefGoalsStale, todayCommandCenter, wealthLanding,
      ...contractFields, cached: true, stale: isStale, cachedAgeMin: Math.round(ageMin),
    };
  }

  // Format today's date label
  const now = new Date();
  const dateLabel = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
  // Weekend / US-holiday awareness so a day off (e.g. Friday of the July 4th
  // weekend) isn't framed as a packed workday with "meeting load" risk.
  const dayOffContext = (() => {
    try {
      const tz = process.env.TZ || 'America/New_York';
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
      return require('../util/dayContext').describeDayOff(todayStr);
    } catch { return ''; }
  })();

  // Refresh the DERIVED intelligence from the CURRENT metrics before building the
  // brief, so every surface reads the same live data. The brief pulls the stored
  // self-model (7-day averages) and stored findings; without this refresh a
  // "Rebuild briefing" just re-ran the LLM over last night's nightly self-model
  // and the last analyze pass — so corrected metrics (e.g. fixed step totals)
  // never reached the brief or Insights until the 9:30pm scheduler ran. analyze()
  // is pure stats and consolidate() is DB queries + string building (no LLM), so
  // this adds ~a few seconds to the already-60-90s build. Best-effort: a failure
  // here must not block the briefing.
  // A forced/manual rebuild ("Rebuild briefing" tap) should reflect whatever Eight
  // Sleep has posted RIGHT NOW — don't depend on the background scheduler having
  // already polled (it only starts at a fixed floor and gates the AUTOMATIC brief
  // on a separate wake buffer; neither should block an explicit user request).
  // Best-effort: a failed/absent connector must not block the briefing.
  try {
    await runIngest({ only: 'eight_sleep_api' });
  } catch (err) {
    console.error('[briefing force] eight-sleep pull failed:', err.message);
  }

  let analyzeOk = false;
  try {
    await analyze();
    analyzeOk = true;
  } catch (err) {
    console.error('[briefing build] intelligence refresh failed:', err.message);
  }

  // Cross-context insights need the fresh correlation findings analyze() just
  // wrote, but touch nothing else in the source fetch below (weather/calendar/
  // notion/email) — kick it off here and run it CONCURRENTLY with that
  // fetch instead of serially before it, so its LLM call's latency is hidden
  // behind the ~12s bounded fetch rather than adding to the critical path.
  // consolidate() still runs after it resolves (below), preserving the original
  // analyze -> crossContext -> consolidate ordering; only crossContext's LLM call
  // itself moves off the critical path.
  // Tracks success separately from the promise itself (rather than swallowing
  // the error into a `null` return) so consolidate() below can replicate the
  // ORIGINAL single-try/catch behavior exactly: skip consolidate() if EITHER
  // analyze() or crossContext generation failed, not just analyze().
  let crossContextOk = false;
  const crossContextPromise = analyzeOk
    ? require('../intelligence/crossContext').generateCrossContext()
        .then((v) => { crossContextOk = true; return v; })
        .catch((err) => { console.error('[briefing build] crossContext regen failed:', err.message); return null; })
    : Promise.resolve(null);

  // `workout` (the prompt-facing shape) is derived further down, from the ONE
  // BrainSnapshot this build cuts (see "Cut ONE real BrainSnapshot" below) —
  // not resolved here, which used to mean the full build called
  // getEffectiveWorkout TWICE (once here with no band — self-fetching its own
  // recovery — and once again inside the snapshot).

  // Notion wisdom page: avoid repeating one shown in the last 30 days.
  const seenNotion = await surfacedStore.recentRefs('notion_page', 30).catch(() => new Set());

  // Fetch all independent data sources in parallel. Each is bounded by a hard
  // timeout so one slow upstream (Notion/etc.) can't hang the whole
  // briefing — allSettled waits for every promise, so without this a single
  // stall blocks the response. A timed-out source just shows as a soft error.
  const EXT = Number(process.env.BRIEFING_SOURCE_TIMEOUT_MS || 12000);
  const [weatherResult, calendarResult, workBusyResult, notionResult, quoteResult] =
    await Promise.allSettled([
      withTimeout(fetchWeather(), EXT, 'weather'),
      withTimeout(fetchCalendarEvents(), EXT, 'calendar'),
      withTimeout(fetchWorkBusyBlocks(), EXT, 'workCalendar'),
      // Wisdom page is day-locked: skip the Notion API on same-day rebuilds so
      // we don't burn credits for a page that will be discarded by lockedNotion.
      priorIsToday && prior?.content?.notionText
        ? Promise.resolve({ text: prior.content.notionText, pageTitle: prior.content.notionPageTitle ?? 'Notion' })
        : withTimeout(fetchRandomNotionPage({ exclude: [...seenNotion] }), EXT, 'notion'),
      withTimeout(fetchRandomQuote(), EXT, 'googleDoc'),
    ]);

  function unwrap(result, name) {
    if (result.status === 'fulfilled') return result.value;
    console.error(`[${name}] failed:`, result.reason?.message || result.reason);
    errors.push({ service: name, error: result.reason?.message || String(result.reason) });
    return null;
  }

  const weather = unwrap(weatherResult, 'weather');
  const calendar = unwrap(calendarResult, 'calendar') ?? [];
  const workBusy = unwrap(workBusyResult, 'workCalendar') ?? [];
  const notionData = unwrap(notionResult, 'notion') ?? { text: '', pageTitle: 'Notion' };
  // Mark this Notion page as shown so it won't repeat for 30 days — but ONLY when
  // we're actually serving a fresh pick today. If an earlier build already locked
  // today's wisdom, this fresh fetch gets discarded by the day-lock below, so
  // recording it would silently burn the no-repeat pool on every refresh.
  if (!priorIsToday && notionData.pageTitle && notionData.pageTitle !== 'Notion') {
    surfacedStore.record('notion_page', notionData.pageTitle).catch(() => {});
  }
  const quoteData = unwrap(quoteResult, 'googleDoc') ?? { quote: '' };
  // Gmail is no longer fetched (removed with the newsletter-summary feature);
  // generateChiefBrief still accepts an emailData param and its urgentEmails
  // schema field, so this always resolves to an empty array rather than
  // threading a removed feature's absence through every call site.
  const emails = [];

  // Now that the source fetch above is done, make sure crossContext (kicked off
  // concurrently with it) has actually finished before consolidate() reads its
  // findings — preserves the original analyze -> crossContext -> consolidate order.
  await crossContextPromise;
  if (analyzeOk && crossContextOk) {
    try {
      await require('../intelligence/consolidate').consolidate({ kind: 'briefing' });
    } catch (err) {
      console.error('[briefing build] consolidate failed:', err.message);
    }
  }

  // Quote of the day from the Notion "Quotes" page (each bullet = one quote).
  // No-repeat for 30 days so it cycles through all your quotes.
  // Day-locked: skip the Notion API on same-day rebuilds — the quote is already
  // chosen and will be carried forward by keep(p?.dailyQuote, ...) below.
  let dailyQuote = priorIsToday ? (prior?.content?.dailyQuote ?? null) : null;
  if (!priorIsToday) {
    try {
      const quotes = await withTimeout(fetchNotionQuotes(), EXT, 'notionQuotes');
      if (quotes.length) {
        const seen = await surfacedStore.recentRefs('daily_quote', 30);
        const [pick] = surfacedStore.pickFresh(
          quotes.map((q) => q).sort(() => Math.random() - 0.5),
          seen,
          { max: 1, keyFn: (q) => q }
        );
        if (pick) {
          dailyQuote = pick;
          await surfacedStore.record('daily_quote', pick);
        }
      }
    } catch (err) {
      console.error('[notionQuotes] failed:', err.message);
    }
  }

  // Wellbeing context: recent inner-state signals (mood/energy/focus + lagging
  // habits) so the quote/Notion commentary can tailor to how you're actually
  // doing — without referencing calendar specifics or your profession.
  let wellbeingContext = '';
  let wellbeingTheme = ''; // search phrase for the "From Your Library" highlight
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const avg = async (domain, metric) => {
      const r = await metricsStore.dailyAggregate({ domain, metric, from: since, agg: 'avg' });
      const vals = r.map((x) => Number(x.value)).filter(Number.isFinite);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    // Habits trailing completion (which ones are slipping). The five binary
    // habits are 0/1 (flag <60% adherence); eat_healthy is a 1–5 score, so it
    // needs its own threshold (flag when averaging below ~3/5) — checking it
    // against 0.6 like the binaries meant it could never flag.
    const binaryHabits = ['gratitude', 'morning_tm', 'afternoon_tm', 'exercise'];
    const habitLabels = { gratitude: 'gratitude', morning_tm: 'morning meditation', afternoon_tm: 'afternoon meditation', exercise: 'exercise', eat_healthy: 'eating well' };
    // All 9 lookups (mood/energy/focus + 5 binary habits + eat_healthy) are
    // independent DB round-trips — batch them into one Promise.all instead of
    // 3 parallel + 6 serial awaits.
    // Recent annotations + day-journal notes over the SAME 7-day window as the
    // habit averages above — so a documented reason ("skipped cold showers,
    // still fighting off a cold") can suppress the raw statistical "slipping"
    // flag for that one habit. Live bug found via a product review: the
    // Wisdom card moralized a slipping cold-shower streak as "patience with
    // discomfort wearing thin" — a real character judgment — while the SAME
    // week's annotations/day-journal already explained it was illness, not a
    // willpower lapse. This mirrors analyze.js's anomaly-vs-annotation
    // reconciliation (see lifeContextRelevant there), scoped to this
    // narrower "is a lagging habit actually explained" question. Best-effort:
    // a failure here just means the raw statistical flag stands, same as before.
    let explainedText = '';
    try {
      const [recentAnnotations, recentJournal] = await Promise.all([
        annotationsStore.overlapping(since, new Date()),
        require('../store/dayJournal').recent({ days: 7 }),
      ]);
      // 'general' purpose — a retracted/superseded annotation ("forget that
      // illness note") must not suppress the raw statistical "slipping" flag
      // either; day-journal entries already exclude retractions at the
      // write site (POST /briefing/context never journals one).
      const eligibleAnnotations = filterEligible(recentAnnotations, { purpose: 'general' });
      explainedText = [
        ...eligibleAnnotations.map((a) => `${a.label || ''} ${a.note || ''}`),
        ...recentJournal.map((j) => j.text || ''),
      ].join(' ').toLowerCase();
    } catch { /* non-critical — falls back to the unexplained (old) behavior */ }

    const [mood, energy, focus, ...habitAvgs] = await Promise.all([
      avg('wellbeing', 'mood'), avg('wellbeing', 'energy'), avg('wellbeing', 'focus'),
      ...binaryHabits.map((m) => avg('habits', m)),
      avg('habits', 'eat_healthy'),
    ]);
    // A lagging habit already explained in the user's own recent words isn't
    // a discipline lapse to narrate a "virtue" theme around — it's a
    // documented, reasonable pause. Only suppress on a real mention of the
    // habit's own label (not a bare word match on something unrelated).
    const isExplained = (label) => explainedText.includes(label.toLowerCase());
    const lagging = [];
    binaryHabits.forEach((m, i) => {
      const a = habitAvgs[i];
      if (a != null && a < 0.6 && !isExplained(habitLabels[m])) lagging.push(habitLabels[m]); // <60% adherence, not already explained
    });
    const eatAvg = habitAvgs[binaryHabits.length];
    if (eatAvg != null && eatAvg < 3 && !isExplained(habitLabels.eat_healthy)) lagging.push(habitLabels.eat_healthy); // below ~3/5, not already explained
    const parts = [];
    const themes = [];
    // Shared wording (low/ok/high) with the self-model and every other surface
    // that narrates these — never the raw "2.6/5" figure.
    const { wellbeingLevel } = require('../intelligence/catalog');
    if (mood != null) { parts.push(`mood ${wellbeingLevel(mood)}`); if (wellbeingLevel(mood) === 'low') themes.push('contentment, perspective, equanimity'); }
    if (energy != null) { parts.push(`energy ${wellbeingLevel(energy)}`); if (wellbeingLevel(energy) === 'low') themes.push('rest, restoration, sustainable effort'); }
    if (focus != null) { parts.push(`focus ${wellbeingLevel(focus)}`); if (wellbeingLevel(focus) === 'low') themes.push('presence, deep work, single-tasking, attention'); }
    // Lagging habits steer the theme toward their virtue.
    const habitThemes = { gratitude: 'gratitude, appreciation', 'morning meditation': 'stillness, mindfulness', 'afternoon meditation': 'stillness, mindfulness', exercise: 'discipline, vitality, the body', 'eating well': 'discipline, nourishment, moderation' };
    for (const l of lagging) if (habitThemes[l]) themes.push(habitThemes[l]);
    if (lagging.length) parts.push(`slipping on ${lagging.slice(0, 3).join(', ')}`);
    wellbeingContext = parts.join('; ');
    // If nothing is low/slipping, theme stays empty -> falls back to quote/evergreen.
    wellbeingTheme = themes.slice(0, 3).join('; ');
  } catch (err) {
    console.error('[wellbeingContext] failed:', err.message);
    errors.push({ service: 'wellbeing_context', error: err.message });
  }

  // Active life-context annotations (travel, illness, deadline, etc.) so the
  // AI can acknowledge them in the briefing. Only today's annotations — stale
  // context from prior days clears at midnight so it can't bleed into a new day.
  //
  // TWO deliberately separate blocks (product-review finding): a general
  // annotation ("big presentation today", "guests this weekend") is real,
  // acknowledgeable life context, but it is NOT evidence for what's driving
  // TODAY's recovery number — only an annotation that is (a) topically
  // health-plausible AND (b) falls inside the EXACT overnight window that
  // produced today's HRV/RHR reading may be cited as a recovery cause.
  // Conflating the two let the brief explain a recovery dip with a same-day
  // scheduling note, or with a real "drank last night" annotation from the
  // WRONG night. Only recoveryDriversContext below may explain recovery —
  // annotationsContext may be acknowledged but never used causally.
  let annotationsContext = '';
  let recoveryDriversContext = '';
  // Raw labels (not the rendered prompt string) for the claim validator —
  // see canonicalFactsFrom's `recoveryDrivers` below, which checkRecoveryCause
  // uses to verify a causal recovery sentence actually names an eligible driver.
  let recoveryDriverLabels = [];
  // Kept alongside the rendered `annotationsContext` string (not just the
  // string itself) so the resolved-context merge below can compute which of
  // these specific rows are ALREADY represented by a compiled assertion —
  // see intelligence/context-resolver.js's partitionRawContext (audit fix,
  // item 2) — and re-render only the genuinely unmatched subset, instead of
  // handing the model the compiled version AND every one of these again.
  let eligibleAnnotationRows = [];
  const briefTz = process.env.TZ || 'America/New_York';
  const { reanchorRelativeTime } = require('../intelligence/reanchor-time');
  const formatAnnotationRows = (rows) => rows
    .map((a) => {
      // Include the submission date so the AI can resolve relative terms like
      // "tomorrow" or "today" in notes entered the night before.
      const submitted = a.start_ts
        ? new Date(a.start_ts).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: briefTz })
        : null;
      const dateTag = submitted ? `[${submitted}] ` : '';
      // Re-anchor relative time words to TODAY rather than leaving the model to
      // do the date math off the bracketed date (which it does unreliably — a
      // "25 hour fast starting tonight" note entered last night was echoed the
      // next morning as "starting tonight" instead of "last night"). Anchor
      // off the true entry time (created_at) so a past-referring note whose
      // start_ts was backdated to the night it describes still re-anchors from
      // when it was actually written. See intelligence/reanchor-time.js.
      const label = reanchorRelativeTime(a.label, { fromDate: a.created_at || a.start_ts, tz: briefTz });
      return `${dateTag}${label}${a.note ? ` (${a.note})` : ''}`;
    })
    .slice(0, 5)
    .join('; ');
  try {
    const { start: startOfToday } = localDayBoundsUtc(process.env.TZ || 'America/New_York');
    const active = await annotationsStore.overlapping(startOfToday, new Date());
    // 'general' purpose — excludes retractions/retired/financial but keeps
    // planned/occurred/negated, all legitimate for the chief brief to
    // acknowledge (see context-semantics.js). NEVER used to explain recovery.
    const eligible = filterEligible(active, { purpose: 'general' });
    eligibleAnnotationRows = eligible;
    if (eligible.length) {
      annotationsContext = formatAnnotationRows(eligible);
    }
  } catch (err) {
    console.error('[annotations] failed:', err.message);
  }

  try {
    const drivers = await require('../intelligence/recovery-drivers').computeRecoveryDrivers({});
    recoveryDriversContext = drivers.context;
    recoveryDriverLabels = drivers.labels;
  } catch (err) {
    console.error('[recovery drivers] failed:', err.message);
  }

  // Recovery context for the briefing prompt — computed early so the chief-of-staff
  // morning focus can reference the actual score and HRV. Stored in `recovery` so
  // the later section can skip a redundant liveRecovery() call.
  let recovery = null;
  let recoveryContext = '';
  try {
    recovery = await require('../intelligence/recovery').liveRecovery();
    if (recovery?.score != null) {
      // Lead with the centralized presentation label (recoveryPresentation.js),
      // not the bare canonical band — a near-green score (e.g. 59) is
      // canonically "yellow" for training-logic purposes, but presented to
      // the user as "Solid — near green". Feeding the LLM only the raw band
      // let it independently editorialize a near-green score as
      // "under-recovered", contradicting every other surface (Health, Today,
      // Ask, voice) that already reads it as reassuring.
      const presLabel = recovery.presentation?.label;
      recoveryContext = presLabel
        ? `score ${recovery.score}/100 — ${presLabel} (canonical band: ${recovery.band ?? 'unknown'})`
        : `score ${recovery.score}/100 (${recovery.band ?? 'unknown'} band)`;
      // rawHrv/rawRhr are actual measurements (ms / bpm), not the 0-100 score components.
      if (recovery.rawHrv != null) recoveryContext += `, HRV ${Math.round(recovery.rawHrv)}ms`;
      if (recovery.rawRhr != null) recoveryContext += `, RHR ${Math.round(recovery.rawRhr)}bpm`;
      // A proxy score is self-reported (no Eight Sleep reading last night) — the
      // UNAVAILABLE branch below only catches the no-data-at-all case, so a
      // proxy score was slipping through with no caveat, narrated as
      // confidently as a real overnight HRV reading. Flag it explicitly so the
      // brief doesn't build a causal "pattern confirmed" story off a subjective
      // 1-5 self-report.
      if (recovery.proxy) {
        recoveryContext += ' — SELF-REPORTED (no Eight Sleep reading last night; this is a subjective estimate, not a real HRV/RHR measurement). Do NOT narrate this with the same confidence as a real overnight reading, and do NOT claim it "confirms" or is the "cleanest proof yet" of any sleep/HRV pattern — at most note it\'s a rough read.';
      }
    } else {
      // No fresh Eight Sleep data (device away or not worn). Explicitly flag this
      // so the LLM doesn't cite stale HRV/recovery numbers from trend findings or the self-model.
      recoveryContext = 'UNAVAILABLE — Eight Sleep device not worn recently. Do NOT reference HRV, resting heart rate, or recovery score in today\'s brief.';
    }
  } catch (err) {
    console.error('[recovery context] failed:', err.message);
    errors.push({ service: 'recovery_context', error: err.message });
  }

  // Pre-brief signals: detect anomalies and generate targeted questions for the
  // mobile app to show before the user reads the brief. Answers come back as
  // annotations via POST /api/briefing/context, which flow into annotationsContext
  // automatically on the next build — no extra prompt plumbing needed.
  let signals = [];
  let spendingContext = ''; // a discretionary-spend anomaly the brief can call out

  // Computed ONCE, here, and reused later for the Wealth tab's "What The Data
  // Shows" card (see the `wealthInsights =` assignment further down, which
  // now just reuses this instead of calling buildWealthInsights() a second
  // time). Previously the chief-brief's spending narrative was driven by a
  // SEPARATE, narrower check inline below (yesterday's total discretionary
  // spend vs a 31-day daily average) — completely independent from this
  // category-level MTD-pace detector. The two could — and, per a live product
  // review, DID — disagree: the brief said "no unusual spike" (its own
  // day-level check was quiet) while the Wealth tab flagged 3 category
  // anomalies (Clothing, Taxi, Restaurants) from this detector, in the same
  // build. One detector, read by both surfaces, closes that gap for good
  // rather than just reconciling this one instance of it.
  // Lifecycle: recompute wealth flow metrics BEFORE reading them into the brief
  // (wealth insights + the snapshot's canonical spendingMtd), so the cut reflects
  // recategorizations from the last transaction sync — and so this state-changing
  // step happens BEFORE the snapshot, never after the brief is persisted. (The
  // post-persist chain no longer recomputes wealth, closing the build-store →
  // recompute-newer → serve-older window.)
  try {
    const r = await require('../services/recompute-wealth').recomputeWealthFlows();
    if (r?.metricsWritten) console.log(`[recompute-wealth pre-cut] ${r.transactions} txns → ${r.metricsWritten} flow rows`);
  } catch (e) { console.error('[recompute-wealth pre-cut] failed:', e.message); }

  // ── Cut ONE real BrainSnapshot for this build ────────────────────────────
  // THE authoritative state cut every downstream part of this build reads
  // from: the LLM prompt's `workout`/spending narrative, the claim validator's
  // facts, the response's todayForecast, the response cards (workout, wealth,
  // wealthInsights), and the persisted brief all project from this SAME
  // object — none of them re-resolve the effective workout or re-query wealth
  // insights independently. Reuses the `recovery` already fetched above (one
  // authority read, not two) and the wealth flows just recomputed pre-cut.
  const factsTz = process.env.TZ || 'America/New_York';
  const snapAsOf = new Date();
  let brainSnapshot = null;
  try {
    const { buildBrainSnapshot } = require('../brain/snapshot');
    brainSnapshot = await buildBrainSnapshot({ asOf: snapAsOf, tz: factsTz, recovery });
  } catch (e) { console.error('[briefing build] snapshot assembly failed:', e.message); }

  // Snapshot the invalidation bus's CURRENT per-field versions right here, at
  // cut time — before the ~60-90s LLM call and everything after it, so this
  // build's stamped fieldVersions describe what THIS snapshot actually
  // reflects, not whatever the bus happens to read as by the time the
  // response is assembled. The cache-hit path (below, on a LATER request)
  // compares a cached brief's fieldVersions against the bus's then-current
  // versions to know precisely which fields a mutation since this cut has
  // made stale — this is what proves "no post-cut mutation silently leaves
  // the served brief wrong": the version recorded here freezes the instant
  // read; the very next check against it will disagree the moment something
  // relevant changes, whether that's a workout override two minutes from now
  // or this exact build's own post-response ingest priming.
  const snapshotFieldVersions = (() => {
    const inv = require('../brain/invalidation');
    const out = {};
    for (const f of TRACKED_CACHE_FIELDS) out[f] = inv.versionOf(f);
    return out;
  })();

  // `workout` (prompt shape) and `wealthInsights` (display cards) are PURE
  // projections of the snapshot's already-resolved effectiveWorkout/wealth —
  // no second getEffectiveWorkout()/buildWealthInsights() call. Fall back to a
  // direct (single) resolve only if the snapshot itself failed to build, so a
  // snapshot failure degrades gracefully instead of blanking the whole brief.
  let workout;
  // The RAW getEffectiveWorkout() shape (label/source/scheduledLabel/
  // workoutId) — kept alongside `workout` (the prompt-text shape above)
  // purely so todayCommandCenter's plan-conflict guard has source/scheduled
  // identity to compare chiefBrief text against, without a second resolve.
  let effectiveWorkoutRaw = null;
  let wealthInsights = [];
  if (brainSnapshot) {
    effectiveWorkoutRaw = brainSnapshot.effectiveWorkout.value ?? { label: 'Rest', source: 'scheduled' };
    workout = brainSnapshot.effectiveWorkout.value
      ? workoutPromptShape(brainSnapshot.effectiveWorkout.value)
      : workoutPromptShape({ label: 'Rest', source: 'scheduled', isHard: false });
    wealthInsights = brainSnapshot.wealth.value?.insights ?? [];
  } else {
    try {
      effectiveWorkoutRaw = await getEffectiveWorkout({ tz: factsTz });
      workout = workoutPromptShape(effectiveWorkoutRaw);
    } catch { workout = workoutPromptShape({ label: 'Rest', source: 'scheduled', isHard: false }); }
    try {
      wealthInsights = await buildWealthInsights();
    } catch (err) {
      console.error('[wealthInsights] failed:', err.message);
      errors.push({ service: 'wealth_insights', error: err.message });
    }
  }
  // Captured here (before the dismissal filter below reassigns `wealthInsights`
  // to the plain-dismissed display array) so wealthLanding's own materiality-
  // aware reactivation logic (applyWealthDismissals) sees the RAW insights —
  // and so it never triggers a second buildWealthInsights() call for this build.
  const wealthInsightsRawForLanding = wealthInsights;

  // Hoisted out of the try block below (not just locals of the pre-brief-
  // signals computation) — bindOpenQuestionInstance (after chief-brief
  // generation, further down this route) needs the SAME today/tomorrow
  // calendar-load inputs to deterministically detect whether the model's
  // own freeform openQuestion is ABOUT this exact canonical figure. Default
  // values match "the pre-brief-signals block failed/found nothing" — the
  // subject detector treats missing load data as "don't bind", never as a
  // reason to fail brief generation itself.
  let tomorrowWorkBusy = [];
  let tomorrowCalendar = [];
  let tomorrowWorkBusyAvailable = false;
  let tomorrowCalendarAvailable = false;
  let signalClassifiedOverridesToday = [];
  let signalClassifiedOverridesTomorrow = [];
  try {
    const preBriefSignals = require('../intelligence/pre-brief-signals');
    // Anomaly callout for the brief narrative (distinct from the user-facing
    // question below): surface the same category spending-pattern flags the
    // Wealth tab shows. buildWealthInsights() is now the ONE place that
    // ranks these by dollar impact (not raw percentage — a $576/460% spike
    // and a $527/47% one are comparably real; percentage-of-a-small-base
    // manufactures noise) — no second, independent re-sort here, so the
    // Wealth tab and this prompt can never silently disagree on order
    // (truth-and-evidence contract, audit priority #1).
    const spendingAnomalies = wealthInsights
      .filter((i) => i.type === 'spending_pattern' || i.type === 'over_budget')
      .slice(0, 3);
    if (spendingAnomalies.length) {
      spendingContext = `Spending patterns this month (ranked by dollar impact): ${spendingAnomalies.map((i) => i.title).join('; ')}.`;
    }
    // Yesterday's discretionary spend vs a 31-day daily average — a distinct,
    // day-granularity signal feeding the proactive "anything to explain that
    // spend?" question below (pre-brief-signals), separate from the
    // month-granularity category trend narrative above. Kept independent on
    // purpose: a single day's discretionary total spiking is a different
    // fact from a category trending over its monthly usual/budget, and
    // conflating them would just create a new disagreement in the other
    // direction.
    let recentSpend = null;
    let spendBaseline = null;
    try {
      const tz = process.env.TZ || 'America/New_York';
      // Use yesterday's completed data — today's Monarch sync only ran this morning
      // and may be incomplete or attribute yesterday's settled transactions to today.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yestDate = yesterday.toLocaleDateString('en-CA', { timeZone: tz });
      const yestFrom = new Date(`${yestDate}T00:00:00Z`);
      const yestTo = new Date(yestFrom.getTime() + 24 * 60 * 60 * 1000);
      const baselineFrom = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      const [yestRows, baselineRows] = await Promise.all([
        metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending_discretionary', from: yestFrom, to: yestTo, agg: 'sum', excludeSource: 'seed' }),
        metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending_discretionary', from: baselineFrom, to: yestFrom, agg: 'sum', excludeSource: 'seed' }),
      ]);
      const yestTotal = yestRows.reduce((s, r) => s + Number(r.value || 0), 0);
      if (yestTotal > 0) recentSpend = yestTotal;
      if (baselineRows.length >= 7) {
        spendBaseline = baselineRows.reduce((s, r) => s + Number(r.value || 0), 0) / baselineRows.length;
      }
    } catch { /* non-critical */ }
    // Tomorrow's work AND personal calendar — so a long / all-day block the
    // next day (an OOO, a travel day, a wall of meetings) can prompt "what's
    // going on there?" the day PRIOR, giving the user a chance to add context
    // before that brief. Personal events are required (not optional) so the
    // canonical calendar-load projection below can subtract a mirrored
    // personal event (e.g. a Sabbath block also mirrored onto the work
    // free/busy feed) from tomorrow's load exactly as it already does for
    // today — fetching only workBusy here reproduced the double-counting bug
    // one day early, since computeCalendarLoad({calendar: []}) has nothing to
    // net against.
    {
      const tmr = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const calendarSvc = require('../services/calendar');
      // allSettled (not all) — a failure fetching one of the two must not also
      // blank out the other, matching today's fetch pattern above.
      const [wb, cal] = await Promise.allSettled([
        calendarSvc.fetchWorkBusyBlocks({ date: tmr }),
        calendarSvc.fetchCalendarEvents({ date: tmr }),
      ]);
      if (wb.status === 'fulfilled') { tomorrowWorkBusy = wb.value; tomorrowWorkBusyAvailable = true; }
      else console.error('[pre-brief-signals] tomorrow workBusy fetch failed:', wb.reason?.message || wb.reason);
      if (cal.status === 'fulfilled') { tomorrowCalendar = cal.value; tomorrowCalendarAvailable = true; }
      else console.error('[pre-brief-signals] tomorrow calendar fetch failed:', cal.reason?.message || cal.reason);
    }
    // Durable, server-side suppression for the calendar_load subject —
    // covers yesterday..tomorrow's local dates so both the "tomorrow is
    // heavily blocked" question (asked about tomorrow) and today's "packed
    // calendar" question (asked about today) can see whichever of the two
    // was already answered, even though they run on different days' builds.
    const signalAnswersStore = require('../store/signalAnswers');
    const nowForSignals = new Date();
    const signalsTz = process.env.TZ || 'America/New_York';
    const calendarLoadAnswers = await signalAnswersStore.answersFor('calendar_load', {
      fromDate: localDateStr(signalsTz, new Date(nowForSignals.getTime() - 24 * 60 * 60 * 1000)),
      toDate: localDateStr(signalsTz, new Date(nowForSignals.getTime() + 24 * 60 * 60 * 1000)),
    }).catch(() => new Map());
    // TODAY's own calendar/workBusy availability — calendarResult/workBusyResult
    // are the same Promise.allSettled results `calendar`/`workBusy` were
    // unwrapped from above; a rejection there already collapsed to `[]`
    // (unwrap(...) ?? []), which is exactly the ambiguity this module exists
    // to remove — so track fulfilled/rejected here rather than re-deriving it
    // from the now-indistinguishable empty array.
    // Match any active calendar-classification correction against TODAY's
    // (and tomorrow's — matchCalendarClassifications simply finds no
    // applicable interval if the correction doesn't apply there) real
    // calendar/workBusy intervals off this build's one BrainSnapshot cut, so
    // a "that's a Sabbath block, not meetings" correction also suppresses
    // the packed-calendar question itself, not just the number inside it.
    // Date-scoped separately for today vs tomorrow (context-resolver.js's
    // matchCalendarClassifications `targetLocalDate`) — a classification
    // meant for one day must never silently apply to the other day's block
    // at the same clock time (see pre-brief-signals.js's split
    // classifiedOverridesToday/Tomorrow params).
    if (brainSnapshot?.resolvedContext?.value) {
      const resolver = require('../intelligence/context-resolver');
      const todayKeyForMatch = localDateStr(signalsTz, nowForSignals);
      const tomorrowKeyForMatch = localDateStr(signalsTz, new Date(nowForSignals.getTime() + 24 * 60 * 60 * 1000));
      try {
        signalClassifiedOverridesToday = resolver.matchCalendarClassifications(
          brainSnapshot.resolvedContext.value, { calendar, workBusy, targetLocalDate: todayKeyForMatch }
        );
      } catch (e) { console.error('[pre-brief-signals] matchCalendarClassifications (today) failed:', e.message); }
      try {
        signalClassifiedOverridesTomorrow = resolver.matchCalendarClassifications(
          brainSnapshot.resolvedContext.value, { calendar: tomorrowCalendar, workBusy: tomorrowWorkBusy, targetLocalDate: tomorrowKeyForMatch }
        );
      } catch (e) { console.error('[pre-brief-signals] matchCalendarClassifications (tomorrow) failed:', e.message); }
    }
    const allSignals = preBriefSignals.buildSignals({
      recovery, calendar, workBusy, spend: recentSpend, spendBaseline, tomorrowWorkBusy, tomorrowCalendar,
      tz: signalsTz, now: nowForSignals, calendarLoadAnswers,
      workBusyAvailable: workBusyResult.status === 'fulfilled',
      calendarAvailable: calendarResult.status === 'fulfilled',
      tomorrowWorkBusyAvailable, tomorrowCalendarAvailable,
      classifiedOverridesToday: signalClassifiedOverridesToday,
      classifiedOverridesTomorrow: signalClassifiedOverridesTomorrow,
    });
    signals = preBriefSignals.selectQuestions(allSignals, 2);
  } catch (err) {
    console.error('[pre-brief-signals] failed:', err.message);
  }

  // Ongoing experiments — running/paused hypotheses, so the brief can casually
  // reference "still gathering data on X" instead of the topic going silent
  // between proposal and verdict (fresh completed verdicts are already handled
  // loudly by continuityContext above). Re-enabled after being paused for data-
  // quality reasons: a RUNNING experiment is only described as actively
  // tracking when its underlying metric genuinely has recent data — otherwise
  // it's flagged as stalled so the brief never narrates a disconnected device
  // (e.g. Eight Sleep) as "still logging."
  let experimentsContext = '';
  // Same staleness bar as analyze.js's trend suppression (computeTrends) — one
  // shared constant so the Health tab and the brief's own narration can't
  // disagree about whether the same metric's data still counts as current.
  const EXPERIMENT_STALE_DAYS = TREND_STALE_DAYS;
  try {
    const allExps = await experimentsStore.listExperiments();
    const runningExps = allExps.filter((e) => e.status === 'running').slice(0, 4);
    const pausedExps = allExps.filter((e) => e.status === 'paused').slice(0, 3);

    // Each experiment's freshness check is an independent DB read — batch them
    // instead of awaiting one at a time inside the loop.
    const lasts = await Promise.all(runningExps.map((e) => {
      const [domain, metric] = String(e.metric || '').split(':');
      return domain && metric ? metricsStore.latest({ domain, metric }).catch(() => null) : null;
    }));

    const lines = [];
    runningExps.forEach((e, i) => {
      const [domain, metric] = String(e.metric || '').split(':');
      let note = '';
      if (domain && metric) {
        const last = lasts[i];
        const ageDays = last ? Math.floor((Date.now() - new Date(last.ts).getTime()) / 864e5) : null;
        if (ageDays == null || ageDays > EXPERIMENT_STALE_DAYS) {
          note = ` — NO FRESH DATA (${ageDays == null ? 'none ever' : `${ageDays}d old`}); do NOT say this is actively tracking or "still logging," at most note it's stalled`;
        }
      }
      const daysLeft = e.end_date
        ? Math.max(0, Math.ceil((new Date(e.end_date) - Date.now()) / 86400000))
        : null;
      lines.push(`⟳ Running: ${e.hypothesis}${daysLeft != null ? ` (${daysLeft}d left)` : ''}${note}`);
    });
    for (const e of pausedExps) {
      lines.push(`⏸ Paused by the user: ${e.hypothesis} — do not reference as active, running, or logging`);
    }
    if (lines.length) experimentsContext = lines.join('\n');
  } catch (err) {
    console.error('[experiments context] failed:', err.message);
  }

  // Self-model: nightly-consolidated portrait of the user — injected into the
  // briefing prompt so the chief-of-staff voice knows who it's talking to.
  let selfModel = '';
  try {
    selfModel = (await require('../store/selfModel').latestModelText()) ?? '';
    // The daily brief shouldn't surface net worth (it's noise day-to-day and the
    // LLM kept forcing nonsensical "net worth tied to your work" ties). Strip the
    // net-worth figure from the WEALTH line for the brief only — keep MTD spending
    // so genuine spending insights still flow. The full model keeps net worth for
    // other surfaces (Ask, wealth tab).
    selfModel = selfModel.replace(/^WEALTH:.*$/m, (line) => {
      const spend = line.match(/MTD[^$]*spending \$[\d,]+(?: \(excludes[^)]*\))?/);
      return spend ? `WEALTH: ${spend[0]}` : '';
    });
  } catch (err) {
    console.error('[selfModel] failed:', err.message);
  }

  // Pipeline health: inject a data-gap warning into annotationsContext when a
  // critical connector hasn't synced recently. The LLM sees this and caveats
  // stale-data claims; avoids confidently citing week-old numbers.
  try {
    const { describeDataGaps } = require('../intelligence/source-health');
    const allSources = await sourcesStore.listSources();
    const gaps = describeDataGaps(allSources);
    if (gaps.length) {
      const warning = `DATA GAPS — these sources have not synced recently: ${gaps.join('; ')}. Caveat any claims that rely on this data.`;
      annotationsContext = annotationsContext ? `${annotationsContext}; ${warning}` : warning;
    }
  } catch (err) {
    console.error('[pipeline health] failed:', err.message);
  }

  // Leverage + risk context for the Chief-of-Staff brief. THE ACTION comes from
  // the leverage engine; THE RISK from the most at-risk forecast. Fetched before
  // the LLM call so the brief can name them; reused later for the card sections
  // (see openFindingsForBrief below) instead of a second identical round trip.
  const openFindingsForBrief = await findingsStore.listFindings({ status: 'open' }).catch(() => []);

  // Continuity context: without this, the chief-of-staff brief has zero memory
  // across days — no awareness of what it already said, what it told the user to
  // do, or whether its own predictions held up. Bundles four "does this feel like
  // it knows me" signals: (1) how long the leading finding has actually been
  // open, so a stretch of days on the same issue reads as "day 4 of this" instead
  // of a fresh explainer every morning; (2) the last suggested action's outcome,
  // for real follow-up instead of only ever proposing something new; (3) whether
  // yesterday's tomorrow-forecast actually held, for honest self-grading; (4) the
  // last few days' raw brief text, so repeated PHRASING is visible even when the
  // underlying topic isn't formally tracked as a finding.
  let continuityContext = '';
  try {
    const NARRATABLE = new Set(['trend', 'anomaly', 'habit_split', 'sleep_impact', 'activity_impact', 'correlation', 'daytime_cardio']);
    const curateLib = require('../intelligence/curate');
    const candidates = openFindingsForBrief.filter((f) => NARRATABLE.has(f.type));
    const sigs = candidates.map(curateLib.signature);
    const firstSeenBySig = await curateLib.recordAndLoadFirstSeen(sigs).catch(() => new Map());
    const now = Date.now();
    const topStreaks = candidates
      .map((f) => {
        const first = firstSeenBySig.get(curateLib.signature(f));
        const days = first ? Math.floor((now - new Date(first).getTime()) / 864e5) : 0;
        return { f, days };
      })
      .filter((x) => x.days >= 3)
      .sort((a, b) => b.days - a.days)
      .slice(0, 4);
    // A correlation/trend finding stays legitimately "open" for as long as the
    // relationship keeps holding — but if its underlying metric is night-sourced
    // (Eight Sleep) and hasn't posted in days, "open N days running" reads as
    // "still actively measuring" when nothing has actually been measured lately.
    // Flag it so the brief says "stalled," not "quietly measuring in the background."
    const { NIGHT_METRICS, staleDays, TREND_STALE_DAYS } = require('../intelligence/analyze');
    const todayKeyForStreaks = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const streaks = await Promise.all(topStreaks.map(async (x) => {
      const keys = x.f.evidence?.metric
        ? [x.f.evidence.metric]
        : [x.f.evidence?.a, x.f.evidence?.b].filter(Boolean);
      const nightKeys = keys.filter((k) => NIGHT_METRICS.has(k));
      let staleNote = '';
      if (nightKeys.length) {
        const ages = await Promise.all(nightKeys.map(async (k) => {
          const [domain, metric] = k.split(':');
          const series = await metricsStore.dailyAggregate({ domain, metric, from: new Date(Date.now() - 30 * 864e5) }).catch(() => []);
          return staleDays(series, todayKeyForStreaks);
        }));
        const maxAge = ages.filter((a) => a != null).sort((a, b) => b - a)[0] ?? null;
        if (maxAge != null && maxAge > TREND_STALE_DAYS) {
          staleNote = ` — STALLED: no fresh reading in ${maxAge}d; describe this as stalled/paused, NOT as actively measuring or "still logging"`;
        }
      }
      return `- ${x.f.title} — open ${x.days} days running${staleNote} (this isn't new; if it's today's lead, name the streak and escalate rather than re-explaining it)`;
    }));

    const openers = await briefingsStore.recentDailyBriefOpeners(3).catch(() => []);
    const openerLines = openers.map((o) =>
      `- ${o.day}: "${o.synthesis || ''}" | action: "${o.action || ''}"`
    );

    // Closed-loop accountability: a real chief of staff follows up on what they
    // told you to do, not just picks a fresh action every morning. Reuses the
    // recommendation ledger's own outcome tracking (thumbs, or auto-measured once
    // ~a week of data exists) so the brief can say "yesterday I said X — here's
    // what happened" instead of only ever suggesting something new.
    let lastActionLine = null;
    try {
      const todayLocalDateStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
      const startOfTodayUtc = new Date(require('../util/date').naiveToUtcIso(`${todayLocalDateStr}T00:00:00`, tz));
      const lastAction = await recommendationsStore.mostRecentLeverageAction(startOfTodayUtc);
      if (lastAction) {
        const daysAgo = Math.floor((Date.now() - new Date(lastAction.created_at).getTime()) / 864e5);
        if (daysAgo <= 7) {
          const thumbed = lastAction.outcome_measured_at != null && Math.abs(Number(lastAction.outcome_delta)) === 1;
          // Shared interpretation with the leverage engine's outcome-history
          // weighting (see recommendationsStore.outcomeVerdict) — the narrative
          // and the ranking must never disagree about what an outcome meant.
          const verdict = recommendationsStore.outcomeVerdict(lastAction);
          const status = thumbed
            ? (verdict === 'helped' ? 'they gave it 👍 — marked it helped' : 'they gave it 👎 — marked it did not help')
            : lastAction.outcome_measured_at != null
              ? (verdict == null ? 'no data to judge it yet' : verdict === 'helped' ? "their data shows it worked" : 'their data shows no effect')
              : 'outcome still being measured automatically from their data (takes about a week) — the user owes NOTHING here; never ask for feedback or count days waiting';
          const whenStr = daysAgo === 0 ? 'earlier today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;
          lastActionLine = `LAST ACTION SUGGESTED (${whenStr}): "${lastAction.title}" — ${status}.`;
        }
      }
    } catch (err) {
      console.error('[last action] failed:', err.message);
    }

    // Explicit calibration: compare YESTERDAY's tomorrow-forecast against TODAY's
    // actual recovery. Only surfaced on a genuine miss (or a low-confidence call
    // that happened to land) — a correct routine call isn't news and forcing a
    // "yesterday I predicted X" ritual into every brief would just become another
    // rote pattern. The credibility payoff specifically comes from owning misses.
    let calibrationLine = null;
    try {
      const yesterday = openers[0] ?? null;
      const fc = yesterday?.tomorrowForecast;
      if (fc && recovery?.score != null && recovery?.band) {
        const missed = fc.band !== recovery.band;
        // Persist EVERY comparison (not just misses) into the calibration
        // ledger — the running hit rate is what lets forecast confidence learn
        // from its own track record (see predict.js's empirical cap) instead
        // of each day's comparison evaporating after one prompt line.
        const calibrationStore = require('../store/forecastCalibration');
        const todayLocalStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
        await calibrationStore.record({
          day: todayLocalStr,
          predictedBand: fc.band, predictedScore: fc.projectedScore, confidence: fc.confidence,
          actualBand: recovery.band, actualScore: recovery.score,
        }).catch((e) => console.error('[calibration] record failed:', e.message));
        const lowConfHit = !missed && fc.confidence != null && fc.confidence < 60;
        if (missed || lowConfHit) {
          calibrationLine = `CALIBRATION CHECK: yesterday's forecast leaned ${fc.band} (~${fc.projectedScore}/100, ${fc.confidence}% confidence) for today; today actually came in ${recovery.band} at ${recovery.score}/100. ${missed ? 'That is a miss — if recovery is part of today\'s synthesis or risk, briefly own the earlier call rather than ignoring it (admitting a miss builds more trust than always sounding certain).' : 'The low-confidence call happened to hold — a brief, light callback is fine if relevant, not a big deal either way.'}`;
          // Enough history to be meaningful → give the model the honest track
          // record so "own the miss" can carry proportion ("3rd miss in 30
          // days" reads very differently from "first miss in a month").
          const track = await calibrationStore.hitRate({ days: 30 });
          if (track.n >= 5) {
            calibrationLine += ` Track record: ${track.hits}/${track.n} of the last ${track.n} daily forecasts landed in the right band.`;
          }
        }
      }
    } catch (err) {
      console.error('[calibration] failed:', err.message);
    }

    // Multi-day training periodization: look at the REST of the week's scheduled
    // sessions (not just today), so back-to-back hard days can be flagged before
    // they stack — a real coach plans the week, not just today. Deliberately rare:
    // only fires when training load is already elevated AND hard days cluster, so
    // it doesn't become a standing weekly notice about a schedule that's fixed.
    let periodizationLine = null;
    try {
      const acwrFinding = openFindingsForBrief.find((f) => f.type === 'training_load');
      const acwrBand = acwrFinding?.evidence?.band ?? null;
      const upcoming = require('../services/workout').getUpcomingWorkouts(3);
      periodizationLine = require('../intelligence/periodization').computePeriodizationNote({ upcoming, acwrBand });
    } catch (err) {
      console.error('[periodization] failed:', err.message);
    }

    const parts = [];
    if (streaks.length) parts.push(`PERSISTENT ISSUES (from the novelty ledger):\n${streaks.join('\n')}`);
    // Nightly context-tag recency (Alcohol, Late meal, …) used to be an
    // ad-hoc inline query here feeding analyze.js's computeContextRecency,
    // whose "logged on K of the last N days" output named no date and let a
    // historical occurrence read as ongoing/current. It's now sourced from
    // THE canonical, explicitly-dated brainSnapshot.nightlyContextHistory
    // projection (see intelligence/nightly-context-history.js) — built into
    // nightlyContextHistoryContext below, alongside chiefFacts, so both the
    // prompt text and the deterministic validator (claimValidator.js's
    // checkTemporalFraming) agree on the exact same dated facts.
    if (lastActionLine) parts.push(lastActionLine);
    if (calibrationLine) parts.push(calibrationLine);
    // Fresh experiment verdicts — the payoff of a multi-week self-test lands
    // LOUDLY in the next brief instead of sitting silently in the experiments
    // list. Fresh = concluded within the last 2 days (verdicts land on end_date).
    try {
      const allExps = await require('../store/experiments').listExperiments({ status: 'completed' });
      const fresh = (allExps || []).filter((e) => {
        if (!e.verdict || !e.end_date) return false;
        const end = new Date(typeof e.end_date === 'string' ? `${e.end_date}T12:00:00Z` : e.end_date);
        return Date.now() - end.getTime() < 2 * 864e5;
      }).slice(0, 2);
      for (const e of fresh) {
        const icon = e.verdict === 'confirmed' ? 'CONFIRMED ✓' : e.verdict === 'refuted' ? 'REFUTED ✗' : 'INCONCLUSIVE ~';
        const pct = e.result?.pctChange != null ? ` — ${e.result.pctChange > 0 ? '+' : ''}${Math.round(e.result.pctChange * 100)}% on ${e.metric}` : '';
        parts.push(
          `EXPERIMENT VERDICT (fresh — this is the payoff of a multi-week self-test; announce it prominently today, in plain words): ${icon}: "${e.hypothesis}"${pct}. ` +
            (e.verdict === 'confirmed'
              ? 'This is now PROVEN on their own data — going forward it is a fact about them, not a suggestion.'
              : e.verdict === 'refuted'
                ? 'Their own data says this one does not work for them — respect the result and do not re-pitch it.'
                : 'The data could not decide — say so honestly; a longer or cleaner test is a fair next step.')
        );
      }
    } catch { /* verdict announcement is best-effort */ }
    if (periodizationLine) parts.push(`WEEK-AHEAD PERIODIZATION: ${periodizationLine}`);
    if (openerLines.length) parts.push(`YOUR LAST ${openerLines.length} MORNING BRIEFS (do not reuse this phrasing or structure — if the same topic is genuinely still the lead, change the angle, escalate, or ask a pointed question instead of restating the setup):\n${openerLines.join('\n')}`);
    continuityContext = parts.join('\n\n');
  } catch (err) {
    console.error('[continuity context] failed:', err.message);
  }

  // THE canonical, explicitly-dated nightly context-tag history — see
  // intelligence/nightly-context-history.js. Sourced from THIS SAME
  // brainSnapshot cut (zero extra reads), exactly like resolvedContext
  // above, so the prompt text and chiefFacts (below) always agree.
  let nightlyContextHistoryContext = '';
  try {
    if (brainSnapshot?.nightlyContextHistory?.value?.length) {
      nightlyContextHistoryContext = require('../intelligence/nightly-context-history')
        .renderNightlyContextHistoryPrompt(brainSnapshot.nightlyContextHistory.value);
    }
  } catch (err) {
    console.error('[nightly context history] prompt render failed:', err.message);
  }

  let leverageContext = '';
  try {
    const open = openFindingsForBrief;
    const levFindings = open
      .filter((f) => f.type === 'leverage')
      .sort((a, b) => (a.evidence?.rank ?? 99) - (b.evidence?.rank ?? 99))
      .slice(0, 3);
    const lev = levFindings.map((f, i) => `${i + 1}. ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
    const risks = open
      .filter((f) => f.type === 'forecast' && (f.evidence?.status === 'off_track' || f.evidence?.status === 'at_risk'))
      .sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1))
      .slice(0, 2)
      .map((f) => `- ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
    const parts = [];
    if (lev.length) parts.push(`HIGHEST-LEVERAGE ACTIONS (leverage engine):\n${lev.join('\n')}`);
    if (risks.length) parts.push(`TRENDING WRONG (at-risk forecasts):\n${risks.join('\n')}`);
    leverageContext = parts.join('\n\n');

    // Log leverage actions to the recommendation ledger (fire-and-forget).
    // Deduplicated over a 7-day window two ways: dedup_key (the finding's stable
    // basis identity — kind + lever/outcome — survives the TITLE COPY being
    // reworded later, e.g. "Best sleep nights → 13% better HRV" becoming
    // "Best sleep nights lift your next-day HRV" should still count as the same
    // insight) and NUMBER-NORMALIZED title (catches percentage-only variations
    // and chat-surfaced recs that have no basis to key off of). A per-run guard
    // also blocks two findings that collapse the same from both landing in one
    // briefing.
    if (levFindings.length) {
      Promise.all([recommendationsStore.recentTitles(7), recommendationsStore.recentDedupKeys(7)])
        .then(([recent, recentKeys]) => {
        const recentNorm = new Set([...recent].map(recommendationsStore.normalizeRecTitle));
        const seenThisRun = new Set();
        const seenKeysThisRun = new Set();
        for (const f of levFindings) {
          const ev = f.evidence || {};
          const dedupKey = ev.dedupKey ?? null;
          const normKey = recommendationsStore.normalizeRecTitle(f.title);
          if (dedupKey && (recentKeys.has(dedupKey) || seenKeysThisRun.has(dedupKey))) continue;
          if (recentNorm.has(normKey) || seenThisRun.has(normKey)) continue;
          seenThisRun.add(normKey);
          if (dedupKey) seenKeysThisRun.add(dedupKey);
          // recordRecommendation auto-links a follow-up commitment itself when
          // there's no outcomeMetric to auto-measure against.
          recommendationsStore.recordRecommendation({
            type: 'leverage',
            findingId: f.id ?? null,
            title: f.title,
            detail: f.detail ?? null,
            lever: ev.basis?.lever ?? null,
            outcomeMetric: ev.basis?.outcome ?? null,
            expectedDirection: ev.basis?.r != null ? (ev.basis.r >= 0 ? 'up' : 'down') : null,
            score: ev.score ?? null,
            surfacedIn: 'briefing',
            dedupKey,
            commitmentSource: 'brief',
          }).catch((e) => console.error('[recommendations] log failed:', e.message));
        }
      }).catch((e) => console.error('[recommendations] dedup check failed:', e.message));
    }
  } catch (err) {
    console.error('[leverage context] failed:', err.message);
  }

  // Dedup the Notion wisdom at the QUOTE level (not just the page): list the
  // quotes shown in the last 30 days so the LLM picks a different passage, even
  // when the same page recurs or a page has one standout line.
  const seenNotionQuotes = await surfacedStore.recentRefs('notion_quote', 30).catch(() => new Set());
  const notionTextForBrief = seenNotionQuotes.size
    ? `${notionData.text}\n\n[ALREADY SHOWN in the last 30 days — do NOT select any of these; choose a DIFFERENT passage (return empty string if the page has nothing else worthwhile):\n${[...seenNotionQuotes].slice(0, 60).map((q) => `- ${q}`).join('\n')}]`
    : notionData.text;

  // Strength progression nugget — the biggest recent estimated-1RM gain across
  // logged lifts, so the chief-of-staff can call out training wins.
  let strengthContext = '';
  try {
    strengthContext = (await require('../intelligence/strength-progression')
      .topProgressionNote({ days: 45, minSessions: 3 })) || '';
  } catch { /* non-critical */ }

  // Forward-looking cashflow: unlike the spending-anomaly check above (which
  // reports on what already happened), this looks at Monarch's recurring-bill
  // forecast for what's ABOUT to hit, so the brief can warn before the balance
  // drops rather than after. Best-effort and bounded — Monarch's MCP round-trip
  // must never hold up the rest of the briefing.
  let cashflowContext = '';
  try {
    const monarchWealth = require('../services/monarch-wealth');
    if (monarchWealth.isConfigured()) {
      const [recurring, accountsData] = await Promise.all([
        withTimeout(monarchWealth.getRecurring(), EXT, 'monarchRecurring').catch(() => null),
        withTimeout(monarchWealth.getAccounts(), EXT, 'monarchAccounts').catch(() => null),
      ]);
      if (recurring) {
        const { computeCashflowLookahead } = require('../intelligence/cashflow-lookahead');
        const streams = [...(recurring.expenses || []), ...(recurring.creditCards || [])];
        const { detail } = computeCashflowLookahead({ streams, accounts: accountsData?.accounts || [] });
        if (detail) cashflowContext = detail;
      }
    }
  } catch (err) {
    console.error('[cashflow lookahead] failed:', err.message);
  }

  // "You vs past you" — Monday-only longitudinal zoom-out (trailing 4 weeks vs
  // ~3 months ago). Weekly cadence keeps it a perspective beat, not a daily
  // ritual; the module itself only reports shifts that clear real thresholds.
  let progressContext = '';
  try {
    const weekday = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: process.env.TZ || 'America/New_York' });
    if (weekday === 'Monday') {
      progressContext = await require('../intelligence/progress').computeProgressContext();
    }
  } catch (err) {
    console.error('[progress context] failed:', err.message);
  }

  // Life chapters — standing long-arc facts (pregnancy week auto-derived from
  // the due date, countdowns to key dates) so the brief knows the user's life,
  // not just their metrics, without weekly re-typing.
  let chaptersContext = '';
  try {
    const chapters = await lifeChaptersStore.listActive();
    chaptersContext = require('../intelligence/chapters').composeChapterContext(chapters);
  } catch (err) {
    console.error('[chapters context] failed:', err.message);
  }

  // This week's stated goals (the Sunday check-in) — fetched BEFORE the LLM
  // call so the chief of staff can surface an important goal that's still
  // unchecked as the week runs out, instead of the goals living only as a
  // silent checklist on the Insights tab. Reused for the response payload.
  let weeklyGoals = null;
  let weeklyGoalsContext = '';
  // Structured live state ({ text, achieved }[]) passed separately from the
  // prose weeklyGoalsContext string above — briefing-ai.js's goal-completion
  // guard validates generated text against THIS, not the prose, so it works
  // even if the model paraphrases rather than repeating the goal verbatim.
  let liveGoals = [];
  try {
    const [currentInt, priorInt] = await Promise.all([
      intentionsStore.currentIntention(),
      intentionsStore.priorIntention(),
    ]);
    if (currentInt || priorInt) weeklyGoals = { current: currentInt ?? null, prior: priorInt ?? null };
    const goals = currentInt?.goals ?? [];
    liveGoals = goals.map((g) => ({ text: g.text, achieved: !!g.achieved }));
    if (goals.length) {
      const done = goals.filter((g) => g.achieved).map((g) => `[done] ${g.text}`);
      const open = goals.filter((g) => !g.achieved).map((g) => `[OPEN] ${g.text}`);
      weeklyGoalsContext =
        `${[...open, ...done].join(' · ')}` +
        (currentInt?.context ? ` (week context: "${String(currentInt.context).slice(0, 300)}")` : '');
    }
  } catch (err) {
    console.error('[weeklyGoals] failed:', err.message);
    errors.push({ service: 'weekly_goals', error: err.message });
  }

  // Deferred-attention context: things the attention policy noticed earlier
  // today but judged as add_to_brief / ask_question rather than a real-time
  // interruption. Surfacing them here is the "defer to the brief" arm of the
  // policy actually paying out — otherwise those judgments would be recorded
  // and never seen. Fail-soft: any error just yields no extra context.
  let attentionContext = '';
  try {
    const pending = await require('../store/attention').pendingForBrief({ tz });
    if (pending.length) {
      attentionContext = pending
        .map((p) => `- ${p.reason || `${p.domain} ${p.type}: ${p.subject}`}${p.disposition === 'ask_question' ? ' (worth asking about)' : ''}`)
        .join('\n');
    }
  } catch (err) {
    console.error('[briefing attentionContext] failed:', err.message);
  }

  // Call the two independent LLM sections in PARALLEL (chief-brief and the
  // quote/Notion "wisdom" reflection used to be one combined call — splitting
  // them means wall-clock is whichever is slower, not the sum of both).
  //
  // Wisdom is SKIPPED ENTIRELY once today's quote/Notion pair is already
  // day-locked (see lockedQuotePair/lockedNotion further below, which discard
  // ANY freshly-generated quoteInsight/notionQuote/notionInsight in favor of
  // the first build's once priorIsToday && prior.quote/notionQuote exist) —
  // regenerating it on a same-day "Rebuild" tap would be immediately thrown
  // away, so skipping the call saves its full latency+cost every time.
  const wisdomAlreadyLocked = Boolean(priorIsToday && prior?.content?.quote && prior?.content?.notionQuote);
  const LLM_TIMEOUT = Number(process.env.BRIEFING_LLM_TIMEOUT_MS || 90000);

  // Canonical facts for the chief-brief claim validator (brain/claimValidator),
  // projected from the SAME single `brainSnapshot` cut earlier in this build
  // (see "Cut ONE real BrainSnapshot" above) — NOT a second snapshot, and NOT
  // a fresh getEffectiveWorkout()/buildWealthInsights() call. So a generated
  // claim about recovery band/score, the EFFECTIVE workout, or goal/commitment
  // completion is checked against the exact same values the prompt and the
  // response cards already reflect. Best-effort: on any failure the validator
  // falls back to just its goal-completion checks (facts=null → no extra checks).
  // Context Understanding Layer: prefer the compiled/resolved projection
  // over raw annotation reinterpretation when available (harden pass, item
  // 2) — reuses the SAME brainSnapshot.resolvedContext cut used for
  // chiefFacts below, so this costs nothing extra.
  //
  // Audit fix (item 2): raw annotationsContext used to be appended in FULL
  // after the compiled summary, every time — the model got both the
  // corrected version AND the raw text it corrected, "prefer the compiled
  // one" left as an unenforced suggestion. Now only the SUBSET of raw rows
  // partitionRawContext can't match to a compiled assertion (by
  // sourceAnnotationId, then by conservative text overlap) is appended —
  // real, not-yet-structured journal content is never silently dropped, but
  // a row the compiler already turned into a canonical assertion (and
  // possibly corrected) is never handed over a second time as competing raw
  // truth. If compilation produced nothing at all (`compiled` is falsy —
  // compiler failure or zero assertions), annotationsContext is left
  // completely untouched: the original, full raw fallback.
  if (brainSnapshot?.resolvedContext?.value) {
    try {
      const { summarizeResolvedContext, partitionRawContext } = require('../intelligence/context-resolver');
      const compiled = summarizeResolvedContext(brainSnapshot.resolvedContext.value, { purpose: 'general' });
      if (compiled) {
        const { unmatched } = partitionRawContext(brainSnapshot.resolvedContext.value, eligibleAnnotationRows);
        const unmatchedRaw = unmatched.length ? formatAnnotationRows(unmatched) : '';
        annotationsContext = unmatchedRaw ? `${compiled}\n(raw notes, for reference): ${unmatchedRaw}` : compiled;
      }
    } catch (e) { console.error('[briefing build] resolved-context summary failed:', e.message); }
  }

  let chiefFacts = null;
  if (brainSnapshot) {
    try {
      const { canonicalFactsFrom } = require('../brain/snapshot');
      chiefFacts = canonicalFactsFrom({
        recovery: brainSnapshot.recovery.value,
        effectiveWorkout: brainSnapshot.effectiveWorkout.value,
        forecast: brainSnapshot.forecast.value,
        // Goal-completion is validated against the WEEKLY-INTENTION goals (the ones
        // the brief actually discusses, carrying the authoritative `achieved` flag)
        // — a distinct set from the snapshot's long-term goals table.
        goals: liveGoals,
        commitments: brainSnapshot.commitments.value,
        experiments: brainSnapshot.experiments.value,
        wealth: brainSnapshot.wealth.value,
        localDate: brainSnapshot.localDate,
        recoveryDrivers: recoveryDriverLabels,
        // Context Understanding Layer's canonical projection — already cut
        // as part of THIS SAME brainSnapshot (see registry.js's
        // resolvedContext field), so this is zero extra reads, not a second
        // resolver call. Lets claimValidator.checkResolvedContextConflicts
        // catch negated/retracted events, resolver-corrected completion
        // states, driver conflicts, and calendar reclassifications.
        resolvedContext: brainSnapshot.resolvedContext?.value ?? null,
        nightlyContextHistory: brainSnapshot.nightlyContextHistory?.value ?? [],
      });
      // EvidenceClaim packet (truth-and-evidence contract, audit priority
      // #1) — without this, claimValidator.checkAssociationOverclaim is a
      // silent no-op for Chief Brief (it only fires when facts.claims is
      // present), so Chief Brief had no deterministic backstop against
      // "confirmed"/"proven" language for an association/observation claim,
      // unlike Evening Brief/Ask/Weekly Review which already adopted this
      // packet. Pure projection of the SAME chiefFacts just built above —
      // no new data, no extra read.
      if (chiefFacts) chiefFacts.claims = require('../brain/evidenceClaim').buildEvidenceClaims(chiefFacts);
    } catch (e) { console.error('[briefing build] chiefFacts assembly failed:', e.message); }
  }

  // Today's already-answered open questions — fed into the prompt so the
  // model has a head start on not re-asking them (see
  // intelligence/open-question-policy.js). This is best-effort context, NOT
  // the enforcement: the deterministic suppressAnsweredOpenQuestion call
  // right after generation (below) is what actually guarantees a repeat
  // never ships, regardless of whether the model honors this block.
  let answeredQuestionsContext = '';
  try {
    const openQuestionsTz = process.env.TZ || 'America/New_York';
    const answeredToday = await openQuestionsStore.answeredOn(localDateStr(openQuestionsTz, new Date()));
    answeredQuestionsContext = formatAnsweredQuestionsContext(answeredToday);
  } catch (err) {
    console.error('[openQuestion context] failed:', err.message);
  }

  let geminiResult = null;
  {
    const [chiefSettled, wisdomSettled] = await Promise.allSettled([
      withTimeout(
        generateChiefBrief(emails, dayName, workout, calendar, wellbeingContext, annotationsContext, recoveryContext, experimentsContext, selfModel, leverageContext, workBusy, strengthContext, spendingContext, continuityContext, cashflowContext, progressContext, weeklyGoalsContext, chaptersContext, dayOffContext, attentionContext, liveGoals, chiefFacts, recoveryDriversContext,
          // Whether TODAY's own calendar/workBusy fetches actually succeeded
          // (see calendarResult/workBusyResult above) — a rejection there
          // already collapsed to `[]` via unwrap(...) ?? [], indistinguishable
          // from "genuinely empty" by the time `calendar`/`workBusy` reach
          // here, so this is tracked separately rather than re-derived.
          { workBusy: workBusyResult.status === 'fulfilled', calendar: calendarResult.status === 'fulfilled' },
          answeredQuestionsContext, nightlyContextHistoryContext),
        LLM_TIMEOUT,
        'gemini_chief'
      ),
      wisdomAlreadyLocked
        ? Promise.resolve(null)
        : withTimeout(generateWisdomInsights(notionTextForBrief, quoteData.quote, wellbeingContext), LLM_TIMEOUT, 'gemini_wisdom'),
    ]);

    let chiefResult = null;
    if (chiefSettled.status === 'fulfilled') {
      chiefResult = chiefSettled.value;
    } else {
      console.error('[gemini_chief] failed:', chiefSettled.reason?.message);
      errors.push({ service: 'gemini_chief', error: chiefSettled.reason?.message });
      // Carry over urgentEmails from ANY prior build (not just today's) so a
      // failed/timed-out call doesn't blank the inbox card — mirrors the
      // chiefBrief/morningFocus carryover already built into the response
      // object below (which reads prior?.content directly), for the one field
      // that isn't covered there.
      if (prior?.content?.urgentEmails?.length) chiefResult = { urgentEmails: prior.content.urgentEmails };
    }

    let wisdomResult = null;
    if (wisdomAlreadyLocked) {
      // Nothing to do — lockedQuotePair/lockedNotion below source quoteInsight/
      // notionQuote/notionInsight straight from prior.content regardless.
    } else if (wisdomSettled.status === 'fulfilled') {
      wisdomResult = wisdomSettled.value;
    } else {
      console.error('[gemini_wisdom] failed:', wisdomSettled.reason?.message);
      errors.push({ service: 'gemini_wisdom', error: wisdomSettled.reason?.message });
      // Same carryover as the old combined fallback: quoteInsight/notionQuote/
      // notionInsight aren't covered by a prior?.content fallback anywhere else
      // (only the day-locked path reads prior.content for these).
      if (prior?.content?.quoteInsight || prior?.content?.notionInsight) {
        wisdomResult = {
          quoteInsight: prior.content.quoteInsight ?? '',
          notionQuote: prior.content.notionQuote ?? '',
          notionInsight: prior.content.notionInsight ?? '',
        };
      }
    }

    geminiResult = (chiefResult || wisdomResult) ? { ...(chiefResult || {}), ...(wisdomResult || {}) } : null;
  }

  // (LLM-failure carryover for urgentEmails/quoteInsight/notionQuote/notionInsight
  // now happens per-leg, right after each Promise.allSettled result above — this
  // runs BEFORE the dedup check below either way, same as before the split.)

  // Dedup the wisdom quote DETERMINISTICALLY (the model often ignores the
  // avoid-list in the prompt, and the LLM-failure fallback above can carry an
  // older quote forward verbatim). Runs on whatever notionQuote will actually be
  // shown today — live pick or fallback — so neither path can bypass the 30-day
  // no-repeat memory. On a fresh build: if it's already shown in the last 30 days,
  // suppress it so the card hides today rather than repeating; otherwise record it.
  if (!priorIsToday && geminiResult?.notionQuote) {
    const ref = String(geminiResult.notionQuote).toLowerCase().replace(/\s+/g, ' ').replace(/[“”"']/g, '').trim().slice(0, 300);
    if (ref && seenNotionQuotes.has(ref)) {
      geminiResult.notionQuote = '';
      geminiResult.notionInsight = '';
    } else if (ref) {
      surfacedStore.record('notion_quote', ref).catch(() => {});
    }
  }

  // Deterministic suppression for the "one question" — the prompt already says
  // "never ask a question whose answer you already have," but a rebuild re-runs
  // the LLM from scratch with no memory of what was just answered a minute ago,
  // so the same (or near-identical) question can resurface verbatim right after
  // being answered. Centralized in intelligence/open-question-policy.js — every
  // path that can produce/replace chiefBrief (this full build, the scoped
  // chief-brief-only rebuild, and any retry) runs the SAME check against the
  // durable answered_open_questions ledger (store/openQuestions.js), not an
  // ad-hoc scan of 'brief_context' annotations (an unreliable substitute: it
  // shares a table — and its top-N window — with every other kind of life-
  // context note, and previously only this one build path ran it at all).
  if (geminiResult?.chiefBrief?.openQuestion) {
    try {
      const openQuestionsTz = process.env.TZ || 'America/New_York';
      const todayKey = localDateStr(openQuestionsTz, new Date());
      geminiResult.chiefBrief = await suppressAnsweredOpenQuestion(geminiResult.chiefBrief, { localDate: todayKey });
      // Give the SURVIVING question a server-owned canonical instance/id —
      // see open-question-policy.js's bindOpenQuestionInstance. Reuses the
      // exact today/tomorrow calendar-load inputs already computed above
      // for the prompt/pre-brief-signals (workBusy/calendar/
      // signalClassifiedOverridesToday match generateChiefBrief's OWN
      // internal classifiedOverrides computation byte-for-byte — same
      // resolvedContext, same calendar/workBusy, same targetLocalDate), so
      // the deterministic subject detector sees the identical figures the
      // model could have summed itself.
      if (geminiResult.chiefBrief?.openQuestion) {
        const tomorrowKey = localDateStr(openQuestionsTz, new Date(Date.now() + 24 * 60 * 60 * 1000));
        const todayLoad = computeCalendarLoad({
          workBusy, calendar,
          sourcesAvailable: { workBusy: workBusyResult.status === 'fulfilled', calendar: calendarResult.status === 'fulfilled' },
          classifiedOverrides: signalClassifiedOverridesToday,
        });
        const tomorrowLoad = computeCalendarLoad({
          workBusy: tomorrowWorkBusy, calendar: tomorrowCalendar,
          sourcesAvailable: { workBusy: tomorrowWorkBusyAvailable, calendar: tomorrowCalendarAvailable },
          classifiedOverrides: signalClassifiedOverridesTomorrow,
        });
        geminiResult.chiefBrief = await bindOpenQuestionInstance(geminiResult.chiefBrief, {
          localDate: todayKey,
          subjectContext: {
            todayLoad, tomorrowLoad, todayKey, tomorrowKey,
            todayWorkBusy: workBusy, tomorrowWorkBusy,
          },
        });
      }
    } catch (err) {
      console.error('[openQuestion dedup] failed:', err.message);
    }
  }

  // Surface the intelligence layer's current findings (from the last analysis).
  // (wealthInsights is declared earlier, near spendingContext — it's computed
  // once, up there, and reused for both the chief-brief prompt and the
  // Wealth tab; see that declaration's comment.)
  let insights = [];
  let crossContextInsights = [];
  let healthInsights = [];
  let leverageActions = [];
  let forecasts = [];
  // Set below (dismissals block) and reused by the todayCommandCenter call
  // further down ("On My Radar"'s dismiss filter) — one dismissedKeys()
  // query, not two.
  let dismissedKeysSet = new Set();
  // `recovery` is already declared + computed earlier (for the briefing prompt);
  // the block below reuses it and only recomputes if that early call came back null.
  let healthComposites = [];
  try {
    // Same query already run above (openFindingsForBrief) — nothing writes to
    // findings in between, so reuse it instead of a second identical round trip.
    const open = openFindingsForBrief;
    leverageActions = open
      .filter((f) => f.type === 'leverage')
      .sort((a, b) => (a.evidence?.rank ?? 99) - (b.evidence?.rank ?? 99))
      .slice(0, 3)
      .map((f) => ({ title: f.title, detail: f.detail }));
    forecasts = open
      .filter((f) => f.type === 'forecast')
      .sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1)) // most at-risk first
      .slice(0, 5)
      .map((f) => ({
        title: f.title,
        detail: f.detail,
        probability: f.confidence,
        status: f.evidence?.status ?? null,
      }));

    // Live health composites (recovery/sleep-debt/etc.) are current status, not
    // rotating insights — pull them out so they're shown fresh every day and
    // surface the recovery score as its own headline field.
    const COMPOSITE_TYPES = ['recovery', 'sleep_debt', 'sleep_consistency', 'sleep_regularity', 'training_load'];

    // Recovery is computed LIVE from the spine at every briefing build, not
    // re-served from the finding analyze() stored at its morning run. The
    // stored finding scores whatever the DB held at ~8:30am — for a daytime
    // watch wearer there's no HRV/RHR row for today yet at that hour, so its
    // "latest" is yesterday's value, and the card would contradict the live
    // HealthKit numbers below it all day. Falls back to the stored finding.
    // (liveRecovery was already called above for the briefing prompt — skip redundant call)
    if (!recovery) {
      try {
        recovery = await require('../intelligence/recovery').liveRecovery();
      } catch (err) {
        console.error('[recovery live] failed:', err.message);
      }
    }
    if (!recovery) {
      const recoveryFinding = open.find((f) => f.type === 'recovery');
      if (recoveryFinding) {
        recovery = {
          score: recoveryFinding.evidence?.score ?? null,
          band: recoveryFinding.evidence?.band ?? null,
          parts: recoveryFinding.evidence?.parts ?? {},
          detail: recoveryFinding.detail,
        };
      }
    }
    healthComposites = open
      .filter((f) => COMPOSITE_TYPES.includes(f.type) && f.type !== 'recovery')
      .map((f) => ({ type: f.type, title: f.title, detail: f.detail, evidence: f.evidence }));

    // Cross-context insights get their own prominent surface (the differentiator),
    // so pull them out of the generic rotation and expose them directly.
    crossContextInsights = open
      .filter((f) => f.type === 'cross_context')
      .slice(0, 3)
      .map((f) => ({ title: f.title, detail: f.detail, domains: f.domains, confidence: f.confidence }));

    // Insights rotate: prefer ones not shown in the last 30 days so the card
    // stays fresh, falling back to the rest if you've seen them all. Composites
    // and cross-context (shown separately) are excluded.
    const insightPool = open.filter(
      (f) => f.type !== 'leverage' && f.type !== 'forecast' && f.type !== 'cross_context' && !COMPOSITE_TYPES.includes(f.type)
    );

    // Curation layer: score every finding on ONE comparable scale (importance ×
    // magnitude × confidence × novelty), dedupe redundant single-metric findings,
    // and rank. Replaces the old per-bucket confidence/type sorts so the strongest,
    // newest, most actionable findings float to the top of every tab — and a
    // 45-day-old confirmed correlation recedes instead of re-showing daily.
    let rankedPool = insightPool;
    try {
      rankedPool = await require('../intelligence/curate').curate(insightPool);
    } catch (err) {
      console.error('[curate] failed, falling back to confidence sort:', err.message);
      rankedPool = [...insightPool].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    }

    const slim = (f) => ({ type: f.type, title: f.title, detail: f.detail, confidence: f.confidence, domains: f.domains });
    // healthInsights additionally carries evidence: the mobile Worth Knowing
    // dedup (healthWorthKnowing.ts) needs the underlying metric/comparison
    // identity (evidence.metric / evidence.driver+outcome / evidence.a+b) to
    // tell two DISTINCT findings (e.g. an HRV finding vs a resting-HR one)
    // apart from two duplicate emissions of the SAME finding — a title/detail
    // text match alone can't make that distinction safely.
    const slimHealth = (f) => ({ ...slim(f), evidence: f.evidence });

    // Today's "What The Data Shows": the top of the curated pool, already ranked
    // by signal strength. The client splits this into health vs. habit cards by
    // domain, so send a generous slice (12) to feed both without starving either.
    insights = rankedPool.slice(0, 12).map(slim);

    // wealthInsights for the Wealth tab was already computed earlier (see
    // spendingContext's declaration) and reused for the chief-brief's own
    // spending narrative — no second buildWealthInsights() call here.

    // Health (body/physiology) findings for the Health tab — anything that touches
    // the HEALTH domain: sleep/activity impact, habit↔health splits, sleep→focus
    // levers, HRV/sleep trends/anomalies/correlations. Wellbeing-ONLY findings
    // (mood/energy/focus standouts with no body metric) are deliberately excluded
    // here — they live on Today's HabitTrendsCard — so the same mood anomaly never
    // shows on two tabs at once. Already ranked by the curator; just filter + cap.
    healthInsights = rankedPool
      .filter((f) => Array.isArray(f.domains) && f.domains.includes('health'))
      .slice(0, 5)
      .map(slimHealth);
    // NOTE: no VO2 "current" freshening needed here — this is the fresh-build
    // path, and analyze() (which just ran, see the ingest/analyze call above)
    // already read the latest vo2_max metric fresh when it computed this
    // finding. The freshening step lives in the CACHE-HIT branch instead (see
    // buildFreshBriefing's `if (!force && prior?.content)` block above) — that's
    // the path that actually serves nearly all traffic, since it returns the
    // stored content from whenever analyze() last ran without recomputing it.

    // Card-level dismissals: drop any insight the user has explicitly dismissed
    // (e.g. a recurring car payment flagged for "review"), and stamp each survivor
    // with its stable dismissKey so the client can dismiss it. Applies uniformly
    // to stored findings AND live-computed wealth insights.
    try {
      const dismissedInsights = require('../store/dismissedInsights');
      dismissedKeysSet = await dismissedInsights.dismissedKeys();
      insights = dismissedInsights.applyDismissals(insights, dismissedKeysSet);
      // wealthInsights specifically uses wealth-landing.js's REACTIVATION-AWARE
      // filter (+ single-transaction "explained" annotation) — the same
      // pipeline the Wealth tab reads — so a category marked "This was
      // intentional" stops warning on Today's radar too, not just on Wealth
      // (severity/reliability cleanup, item 3: one dismissal, every surface).
      // The plain applyDismissals() above is fine for non-wealth findings,
      // which have no comparable dollar-evidence reactivation rule.
      const wealthLanding = require('../services/wealth-landing');
      const dismissedContext = await dismissedInsights.dismissedContextByKey();
      wealthInsights = await wealthLanding.annotateExplainedSpikes(
        wealthLanding.applyWealthDismissals(wealthInsights, dismissedKeysSet, dismissedContext),
        new Date()
      );
      healthInsights = dismissedInsights.applyDismissals(healthInsights, dismissedKeysSet);
      crossContextInsights = dismissedInsights.applyDismissals(crossContextInsights, dismissedKeysSet);
    } catch (err) {
      console.error('[insights dismissals] failed:', err.message);
    }
  } catch (err) {
    console.error('[insights] failed:', err.message);
    errors.push({ service: 'insights', error: err.message });
  }

  // Relevant-not-random: surface the library highlight that speaks to where
  // you are *internally* (mood/energy/focus + slipping habits), not your task
  // list — and never repeat one within 30 days. Falls back to the quote, then
  // to evergreen growth themes when there's no recent check-in data.
  let relevantHighlight = null;
  try {
    const rh = require('../intelligence/relevant-highlight');
    // Semantic-match against the user's CURRENT situation (goals, life context,
    // any low-wellbeing themes) — not the daily quote — and have the LLM name the
    // connection ("why now") or admit it's only a loose fit (→ honest factual
    // frame on the card). excludeAuthor drops same-author echoes of today's quote.
    relevantHighlight = await withTimeout(
      rh.buildRelevantHighlight({ themes: wellbeingTheme, excludeAuthor: quoteData?.author || null }),
      EXT, 'highlight'
    );
    if (relevantHighlight && relevantHighlight.id && !priorIsToday) {
      await surfacedStore.record('highlight', relevantHighlight.id);
    }
  } catch (err) {
    console.error('[relevantHighlight] failed:', err.message);
    errors.push({ service: 'highlight', error: err.message });
  }

  // Weekly goal achievement (current + prior week with hit/miss) was fetched
  // above, before the LLM call, so the chief brief could see open goals — the
  // same `weeklyGoals` object is reused here for the response payload.

  // Latest weekly review (generated separately on a weekly cadence).
  let weeklyReview = null;
  try {
    const wr = await briefingsStore.latestBriefing('weekly');
    if (wr) {
      const contentObj = wr.content;
      // 'Weekly review' is the exact fallback headline when extractJson fails —
      // a real review always has a specific punchy headline. Suppress the broken record.
      if (contentObj?.headline !== 'Weekly review') {
        weeklyReview = { ...contentObj, generatedAt: wr.generated_at, id: wr.id, weekStart: dateOnly(wr.period_start) };
      }
    }
  } catch (err) {
    console.error('[weeklyReview] failed:', err.message);
    errors.push({ service: 'weekly_review', error: err.message });
  }

  // Wealth snapshot for the Wealth tab (from the canonical spine — Monarch etc.).
  let wealth = null;
  // Hoisted so the staleness-alerts block below can reuse this ONE fetch of
  // Monarch's real sync-clock record instead of querying it again.
  let monarchSrcForAlerts = null;
  try {
    const sum = (arr) => arr.reduce((s, r) => s + Number(r.value), 0);
    // Truncate to UTC midnight so the range boundary aligns with how metrics
    // are stored (dayTs → YYYY-MM-DDT00:00:00Z). Without this, a rolling-ms
    // weekAgo of "Jun 18 12:00 UTC" would exclude Jun 18 00:00 UTC metrics.
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    weekAgo.setUTCHours(0, 0, 0, 0);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    monthAgo.setUTCHours(0, 0, 0, 0);
    const nw = await metricsStore.latest({ domain: 'wealth', metric: 'net_worth' });
    const nwPrev = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'net_worth', from: monthAgo, to: weekAgo, agg: 'avg', excludeSource: 'seed' });
    const now = new Date();
    const [spend, discretionary, income, spendMonth, incomeMonth, discretionaryMonth, monarchSrc] = await Promise.all([
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending', from: weekAgo, to: now, agg: 'sum', excludeSource: 'seed' }),
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending_discretionary', from: weekAgo, to: now, agg: 'sum', excludeSource: 'seed' }),
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'income', from: weekAgo, to: now, agg: 'sum', excludeSource: 'seed' }),
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending', from: monthAgo, to: now, agg: 'sum', excludeSource: 'seed' }),
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'income', from: monthAgo, to: now, agg: 'sum', excludeSource: 'seed' }),
      metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending_discretionary', from: monthAgo, to: now, agg: 'sum', excludeSource: 'seed' }),
      sourcesStore.getSource('monarch'),
    ]);
    monarchSrcForAlerts = monarchSrc;
    if (nw || spend.length) {
      const netWorth = nw ? Number(nw.value) : null;
      const priorNw = nwPrev.length ? sum(nwPrev) / nwPrev.length : null;
      // Calendar month-to-date discretionary spend — the SAME canonical figure
      // BrainSnapshot exposes as wealth.spendingMtd (brain/snapshot.js's
      // canonicalSpendingMtd), reused here rather than re-derived, so the
      // Wealth tab and any chief-brief/claim-validator reference to "MTD
      // spending" can never disagree. This is a genuinely different window
      // from discretionaryThisMonth below (rolling 30 days) — audit priority
      // #1 bug 7 ("Wealth mixes MTD/rolling-7d/rolling-30d figures
      // contradictorily"): both are now present, separately labeled, instead
      // of one silently standing in for the other.
      const { localMonthKeyStartUtc } = require('../util/date');
      const mtdSince = localMonthKeyStartUtc(factsTz, now).toISOString();
      wealth = {
        netWorth,
        netWorthChange: netWorth != null && priorNw ? Math.round((netWorth - priorNw)) : null,
        // The exact window netWorthChange was computed over — a 23-day average
        // (monthAgo..weekAgo) vs. today, not a clean "30 days ago" point. The
        // client renders this range explicitly instead of the old blanket
        // "~30 days" label, which implied more precision than the underlying
        // averaging window actually has.
        netWorthChangeFrom: monthAgo.toISOString(),
        netWorthChangeTo: weekAgo.toISOString(),
        spendingThisWeek: Math.round(sum(spend)),
        discretionaryThisWeek: discretionary.length ? Math.round(sum(discretionary)) : null,
        incomeThisWeek: Math.round(sum(income)),
        cashflowThisWeek: Math.round(sum(income) - sum(spend)),
        // NB: the *ThisMonth fields are ROLLING 30 days (monthAgo = now − 30d),
        // not calendar MTD. Rolling is the right basis for cashflow/income/savings
        // (constant-length window, always spans a full pay cycle, so lumpy income
        // doesn't distort it). Budget adherence stays MTD elsewhere — budgets are
        // calendar-month. The card labels these "(30d)" so the two never blur.
        spendingThisMonth: Math.round(sum(spendMonth)),
        incomeThisMonth: Math.round(sum(incomeMonth)),
        cashflowThisMonth: Math.round(sum(incomeMonth) - sum(spendMonth)),
        discretionaryThisMonth: discretionaryMonth.length ? Math.round(sum(discretionaryMonth)) : null,
        // Calendar MTD discretionary spend (distinct from discretionaryThisMonth's
        // rolling 30d above) + the local calendar-month start it's summed from,
        // so the client can render "MTD (since Jul 1)" without recomputing or
        // guessing the boundary itself.
        spendingMtd: brainSnapshot?.wealth?.spendingMtd ?? null,
        mtdSince,
        // syncedAt is the net-worth METRIC's own data date (when the figure is
        // AS OF) — not when Monarch itself last actually ran a sync. Those are
        // two different facts (audit priority #1 bug 9: "brief built" time
        // doesn't distinguish per-source sync times) and conflating them meant
        // a stale-but-unchanged net worth reading could look freshly synced.
        // sourceSyncedAt is the real connector clock time from the sources
        // table (the same ground truth the staleness alerts below check),
        // surfaced here for the first time instead of only driving a binary
        // alert.
        syncedAt: nw?.ts ? new Date(nw.ts).toISOString() : null,
        sourceSyncedAt: monarchSrc?.last_sync_at ? new Date(monarchSrc.last_sync_at).toISOString() : null,
      };
    }
  } catch (err) {
    console.error('[wealth] failed:', err.message);
    errors.push({ service: 'wealth', error: err.message });
  }

  // Source-staleness alerts. The Monarch token expires periodically; when it
  // does the Mac sync fails silently, so surface "needs reconnecting" in the
  // briefing rather than letting net-worth quietly go stale. Threshold is
  // generous (40h) so a missed morning (Mac asleep) doesn't false-alarm.
  //
  // TWO separate sources are checked, not just 'monarch': the Mac-side CSV
  // importer (id 'monarch', hit by POST /api/import/monarch) and the MCP
  // auto-sync (id 'monarch_mcp_sync') are independent connectors with
  // independent last_sync_at/status. Checking only 'monarch' meant that once
  // the daily Mac sync started working again, its fresh last_sync_at made
  // this alert go permanently quiet — even while monarch_mcp_sync sat broken,
  // silently losing budget-pacing data (GetBudget has no Mac/CSV fallback the
  // way transactions/income do, so an MCP-only outage is otherwise invisible).
  const alerts = [];
  try {
    // monarchSrcForAlerts was already fetched once above (inside the wealth
    // block) — reuse it instead of querying the same source row twice.
    const [monarchSrc, monarchMcpSrc] = await Promise.all([
      monarchSrcForAlerts ? Promise.resolve(monarchSrcForAlerts) : sourcesStore.getSource('monarch'),
      sourcesStore.getSource('monarch_mcp_sync'),
    ]);
    if (monarchSrc) {
      const last = monarchSrc.last_sync_at ? new Date(monarchSrc.last_sync_at) : null;
      const ageH = last ? (Date.now() - last.getTime()) / 36e5 : Infinity;
      if (monarchSrc.status === 'error' || ageH > 40) {
        alerts.push({
          source: 'monarch',
          severity: ageH > 96 ? 'high' : 'warn',
          message: last
            ? `Monarch hasn't synced in ${Math.round(ageH)}h — the token may have expired. Reconnect: cd ~/claude/backend && node scripts/monarch-reconnect.js`
            : `Monarch has never synced. Reconnect: cd ~/claude/backend && node scripts/monarch-reconnect.js`,
        });
      }
    }
    if (monarchMcpSrc?.status === 'error') {
      alerts.push({
        source: 'monarch_mcp_sync',
        severity: 'warn',
        // Surface the ACTUAL captured error (e.g. Monarch's own "MCP is
        // temporarily paused" outage notice) when we have one, instead of a
        // generic guess — this is a different failure mode from a stale/
        // expired token and a different fix (nothing to reconnect; wait for
        // Monarch), so don't tell the user to reconnect when that's not it.
        message: monarchMcpSrc.last_error
          ? `Monarch MCP sync is failing: ${String(monarchMcpSrc.last_error).slice(0, 200)} — budget-vs-spending comparisons are unavailable until this clears (transactions/income keep flowing via the backup sync).`
          : 'Monarch MCP sync is failing — budget-vs-spending comparisons are unavailable until this clears (transactions/income keep flowing via the backup sync).',
      });
    }
  } catch (err) {
    console.error('[alerts] failed:', err.message);
  }

  // Daily-lock: if we already built a briefing earlier today, keep the same
  // "wisdom" picks (library highlight, daily quote, Notion page, and the Gemini
  // insights written about the quote/Notion) so they stay static all day and only
  // change at midnight. A non-empty fresh value still wins if the locked one was
  // blank (e.g. the first build failed to fetch it), so we never lock in nothing.
  const p = priorIsToday ? prior.content : null;
  const keep = (locked, fresh) => (locked != null && locked !== '' ? locked : fresh);

  // Quote + its insight (and the Notion quote+insight+text) must be locked as a
  // UNIT — locking them independently let the displayed quote and its commentary
  // come from different builds, so the insight could describe a different quote
  // than the one shown. Carry the whole pair from the prior build when it has a
  // real quote; otherwise take the whole pair fresh from this build.
  const lockedQuotePair = p && p.quote ? { quote: p.quote, quoteInsight: p.quoteInsight } : null;
  const freshQuotePair = { quote: quoteData.quote, quoteInsight: geminiResult?.quoteInsight ?? '' };
  const quotePair = lockedQuotePair || freshQuotePair;

  const lockedNotion = p && p.notionQuote ? { notionQuote: p.notionQuote, notionInsight: p.notionInsight, notionText: p.notionText, notionPageTitle: p.notionPageTitle } : null;
  const freshNotion = { notionQuote: geminiResult?.notionQuote ?? '', notionInsight: geminiResult?.notionInsight ?? '', notionText: notionData.text, notionPageTitle: notionData.pageTitle };
  const notionGroup = lockedNotion || freshNotion;

  // Daily forecast: today's grade (A/B/C day) + sleep-debt trajectory. Comes from
  // the ONE snapshot cut above — the snapshot already resolved the effective
  // workout and fed it to computeTodayForecast, so we neither recompute the
  // forecast nor re-resolve the workout here. Fall back to a direct compute only
  // if the snapshot itself failed to build.
  let todayForecast = brainSnapshot?.forecast?.value ?? null;
  if (!brainSnapshot) {
    try {
      todayForecast = await require('../intelligence/predict').computeTodayForecast({ recovery });
    } catch (err) {
      console.error('[todayForecast] failed:', err.message);
    }
  }

  // Fresh-before-replace invariant (audit fix, twin of notify/morning.js's
  // warmAndNotify gate): THIS build's own chiefBrief only ships when its OWN
  // quality is 'fresh' (brain/claimValidator.js's assessChiefBriefQuality).
  // A missing OR merely degraded generation must never overwrite a genuinely
  // good card — the earlier version of this carry-forward only triggered on
  // a null/invalid shape, so a schema-valid but degraded result (the exact
  // "Recovery is green at NN today." grounded-fallback case) shipped as-is,
  // looking indistinguishable from a real brief. The carry-forward target is
  // resolved by store/briefings.js's resolveLastGoodChiefBrief — the ONE
  // shared "what's last-known-good?" primitive every carry-forward call site
  // (this one, performScopedChiefBriefRebuild, the cache-hit serve) uses, so
  // it can never drift between them. Deliberately NOT
  // notify/morning.js's hasPublishableFreshBriefToday(prior): that predicate
  // reads `prior`'s OWN chiefBriefQuality, which reflects prior's own build
  // ATTEMPT, not whether prior's chiefBrief content is fit to display — a
  // `prior` that itself carried forward an earlier fresh brief (chiefBriefStale:
  // true) has a degraded quality but perfectly good content, and trusting
  // quality there is exactly the bug that let a SECOND consecutive
  // degraded/failed build delete an already-good, already-carried-forward
  // brief. resolveLastGoodChiefBrief scans backward through same-day history
  // instead of trusting prior's own quality stamp — never a stale cross-day
  // fallback either (yesterday's numbers/dates reading as today's is its own
  // kind of wrong).
  const thisAttemptFresh = geminiResult?.chiefBrief != null && geminiResult?.chiefBriefQuality?.status === 'fresh';
  const lastGood = thisAttemptFresh ? null : await briefingsStore.resolveLastGoodChiefBrief(prior, { tz: process.env.TZ || 'America/New_York' });
  const chiefBriefStale = !thisAttemptFresh && lastGood != null;
  if (chiefBriefStale) {
    console.error('[briefing build] this build\'s own chiefBrief was missing or degraded quality — carrying forward today\'s existing good brief instead.');
    errors.push({ service: 'chiefBrief', error: 'this build\'s attempt was missing or degraded quality; showing the existing good brief from earlier today' });
  }
  // The carried-forward fallback needs its own suppression pass: `lastGood`
  // may have been resolved from a row read at the START of this (potentially
  // 60-90s) build, so if the user answered the open question WHILE this
  // build was still running, this in-memory object predates that answer even
  // though the DB row (and every OTHER cached build) was already updated by
  // POST /briefing/context's atomic retirement. geminiResult.chiefBrief (the
  // fresh path) was already suppression-checked above right after generation.
  let finalChiefBrief = thisAttemptFresh ? geminiResult.chiefBrief : (chiefBriefStale ? lastGood.chiefBrief : null);
  if (!thisAttemptFresh && finalChiefBrief?.openQuestion) {
    try {
      const openQuestionsTz = process.env.TZ || 'America/New_York';
      finalChiefBrief = await suppressAnsweredOpenQuestion(finalChiefBrief, {
        localDate: localDateStr(openQuestionsTz, new Date()),
      });
    } catch (err) {
      console.error('[openQuestion dedup] failed (carried-forward brief):', err.message);
    }
  }
  // Neither a fresh new attempt nor a good same-day prior exists — an
  // explicit PENDING state (see the response's chiefBriefPending field
  // below), never brain/claimValidator.js's groundedFallbackSentence()
  // shown as if it were a completed brief. morningFocus comes from the SAME
  // LLM attempt as chiefBrief, so it follows the identical precedence — a
  // degraded attempt's morningFocus is just as unproven as its chiefBrief.
  const chiefBriefPending = finalChiefBrief == null;
  if (chiefBriefPending && geminiResult?.chiefBrief != null) {
    console.error(`[briefing build] this build's chiefBrief was ${geminiResult?.chiefBriefQuality?.status ?? 'unknown'}-quality and no good same-day card exists to carry forward — reporting pending, not shipping degraded prose.`);
  }
  const finalMorningFocus = thisAttemptFresh
    ? (geminiResult.morningFocus || '')
    : (chiefBriefStale ? (lastGood.morningFocus || '') : '');

  // Explicit period identity for finalChiefBrief's goal-completion claims
  // (truth-and-evidence contract, audit priority #1 — "Chief Brief says
  // every goal is completed while This Week's Focus shows unchecked goals,
  // and the UI does not identify the periods"). weeklyGoals.current.weekStart
  // is the LIVE current week (just fetched above); when finalChiefBrief was
  // carried forward from a prior build (chiefBriefStale), its own goal
  // claims may describe an EARLIER week's weekStart. Comparing the two
  // gives an honest, explicit flag instead of two surfaces silently
  // disagreeing with no way for the user to tell why.
  const goalsWeekStart = thisAttemptFresh
    ? (weeklyGoals?.current?.weekStart ?? null)
    : (chiefBriefStale ? (lastGood.goalsWeekStart ?? null) : null);
  const chiefBriefGoalsStale = Boolean(
    goalsWeekStart && weeklyGoals?.current?.weekStart && goalsWeekStart !== weeklyGoals.current.weekStart
  );

  const nowIso = new Date().toISOString();
  // The state-cut time + identity come from the ONE real snapshot (snapAsOf),
  // NOT an independently-minted id — so the saved brief and the morning push
  // provably reference the same cut. builtAt stays the response PRODUCTION time
  // (the client's "rebuild finished" poll signal); fieldsBuiltAt records that
  // every top-level field was derived at the snapshot cut.
  const snapshotAtIso = brainSnapshot?.asOf ?? snapAsOf.toISOString();
  const response = {
    date: dateLabel,
    // Response production time (also the "rebuild finished" poll signal). See
    // the timestamp-semantics note near stampFields().
    builtAt: nowIso,
    // A FULL build cuts a new state snapshot: snapshotAt is the snapshot's cut
    // time and every top-level field's derivation time is stamped to it.
    snapshotAt: snapshotAtIso,
    snapshotVersion: brainSnapshot?.version ?? require('../brain/snapshot').SNAPSHOT_VERSION,
    // The ACTUAL snapshot's id (not a route-minted one). The morning push carries
    // this same id so an in-app view and its notification can be proven to
    // reference one snapshot, not two independently-built versions of "this morning."
    snapshotId: brainSnapshot?.snapshotId ?? null,
    fieldsBuiltAt: stampFields({}, FULL_BUILD_FIELDS, snapshotAtIso),
    // The brain/invalidation bus's per-field version AT THE MOMENT this
    // snapshot was cut. The cache-hit path (this same function, above) reads
    // this back on a later request and compares it against the bus's
    // then-current versionOf() to decide precisely which cached fields a
    // mutation since this build has made stale — the version-driven
    // staleness check that replaces "always re-fetch and value-diff".
    fieldVersions: snapshotFieldVersions,
    localDate: brainSnapshot?.localDate ?? new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' }),
    timezone: process.env.TZ || 'America/New_York',
    morningFocus: finalMorningFocus,
    // Structured Chief-of-Staff brief (Beta): synthesis + ACTION/RISK/MOVE.
    // null when chiefBriefPending (below) is true — see that field's comment.
    chiefBrief: finalChiefBrief,
    // True when the card above is carried over from a prior build (this
    // build's own attempt was missing or degraded quality) rather than
    // freshly generated THIS build.
    chiefBriefStale,
    // True when NEITHER this build's own attempt NOR a fresh same-day prior
    // was available to show — chiefBrief is null, not
    // groundedFallbackSentence() text. The mobile client (BriefCard.tsx)
    // renders calm "Finishing today's brief…" copy in this state instead of
    // ever mistaking it for a completed brief.
    chiefBriefPending,
    // The local week (Sunday, YYYY-MM-DD) whose goals finalChiefBrief's
    // completion claims actually describe — see store/intentions.js's
    // weekStart(). Compare against weeklyGoals.current.weekStart below to
    // know whether they're the SAME period.
    goalsWeekStart,
    // True when finalChiefBrief's goal claims reference a DIFFERENT week
    // than weeklyGoals.current (the live current week) — e.g. a carried-
    // forward chiefBrief from before the week rolled over. Mobile shows an
    // explicit qualifier instead of letting "all goals done" (last week)
    // visually contradict this week's fresh unchecked goals.
    chiefBriefGoalsStale,
    // THE authoritative quality contract result for THIS build's own LLM
    // output (brain/claimValidator.js's assessChiefBriefQuality) — fresh,
    // degraded (grounded-fallback/underfilled/unresolved contradiction), or
    // failed (no usable shape at all). Always reflects this build's own
    // attempt, never the carried-forward card above: a stale card must never
    // be mistaken for a successful fresh build (see hasPublishableFreshBriefToday
    // in notify/morning.js). null only for builds that predate this contract.
    chiefBriefQuality: geminiResult?.chiefBriefQuality ?? null,
    weather,
    workout,
    // Raw getEffectiveWorkout() shape, persisted alongside the prompt-text
    // `workout` above purely for todayCommandCenter's plan-conflict guard —
    // see effectiveWorkoutRaw's definition above.
    effectiveWorkout: effectiveWorkoutRaw,
    calendar,
    workBusy: workBusy ?? [],
    urgentEmails: priorIsToday && p?.urgentEmails?.length ? p.urgentEmails : (geminiResult?.urgentEmails ?? []),
    // Quote + insight locked together (see quotePair above) so they always match.
    quote: quotePair.quote,
    quoteInsight: quotePair.quoteInsight,
    // Notion quote + insight + source text locked together as a unit too.
    notionQuote: notionGroup.notionQuote,
    notionInsight: notionGroup.notionInsight,
    notionText: notionGroup.notionText,
    notionPageTitle: notionGroup.notionPageTitle,
    leverageActions,
    insights,
    crossContextInsights,
    wealthInsights,
    healthInsights,
    recovery,
    healthComposites,
    todayForecast,
    forecasts,
    weeklyGoals,
    relevantHighlight: keep(p?.relevantHighlight, relevantHighlight),
    weeklyReview,
    wealth,
    wellbeingTheme: keep(p?.wellbeingTheme, wellbeingTheme || null),
    dailyQuote: keep(p?.dailyQuote, dailyQuote),
    alerts,
    signals,
  };

  // Wealth redesign (audit rec #5): ONE canonical Wealth landing projection,
  // built once here and reused as-is by the Wealth tab — no second,
  // independently-derived posture/pace/savings-rate on the client.
  try {
    response.wealthLanding = await require('../services/wealth-landing').buildWealthLandingProjection({
      tz: response.timezone,
      wealthInsights: wealthInsightsRawForLanding,
      // Reuse the SAME matched-pace value BrainSnapshot already resolved
      // above (buildBrainSnapshot -> computeDiscretionaryMatchedPace) —
      // previously this triggered a second, independent up-to-12-query
      // computation for the same build. Only pass an explicit value (even a
      // legitimate `null`) when BrainSnapshot itself succeeded — if it
      // failed entirely, leave this `undefined` so the projection still
      // computes its own pace fresh rather than being forced permanently
      // null by a failure in an unrelated part of the build.
      ...(brainSnapshot ? { spendingPace: brainSnapshot.wealth?.value?.spendingPace ?? null } : {}),
    });
  } catch (err) {
    console.error('[wealthLanding] full build failed:', err.message);
    response.wealthLanding = null;
  }

  // Today command-center projection (Today-tab redesign): ONE server-owned
  // selection over data already assembled above — no second snapshot, no new
  // LLM call, no mobile-side derivation. See brain/todayCommandCenter.js.
  try {
    response.todayCommandCenter = await require('../brain/todayCommandCenter').buildTodayCommandCenter({
      snapshotId: response.snapshotId, snapshotVersion: response.snapshotVersion,
      snapshotAt: response.snapshotAt, builtAt: response.builtAt, tz: response.timezone,
      chiefBrief: response.chiefBrief, chiefBriefStale: response.chiefBriefStale,
      chiefBriefPending: response.chiefBriefPending, chiefBriefQuality: response.chiefBriefQuality,
      goalsWeekStart: response.goalsWeekStart, chiefBriefGoalsStale: response.chiefBriefGoalsStale,
      forecasts: response.forecasts, todayForecast: response.todayForecast,
      healthInsights: response.healthInsights, wealthInsights: response.wealthInsights,
      weeklyReview: response.weeklyReview, wealth: response.wealth, recovery: response.recovery,
      effectiveWorkout: response.effectiveWorkout, dismissed: dismissedKeysSet,
    });
  } catch (err) {
    console.error('[todayCommandCenter] build failed:', err.message);
  }

  if (errors.length > 0) {
    response.errors = errors;
  }

  // publish=false (the automatic morning path's prepare step) returns the
  // built-but-UNPUBLISHED draft here: no persistence, no TTS prewarm, no
  // next-cycle priming. The caller (notify/morning.js's warmAndNotify) runs
  // its own final readiness + quality re-check against this exact draft and
  // only calls publishBriefingDraft() once that re-check still passes — never
  // "save then delete a premature row"; an unconfirmed draft is simply never
  // written anywhere.
  //
  // Quality gate BEFORE publish (audit fix, item 3): this used to publish
  // unconditionally whenever publish=true — which is every manual rebuild
  // (POST /briefing/rebuild), forced refresh (GET /briefing?refresh=1), and
  // cache-miss GET /briefing, none of which passed publish=false. A build
  // whose own attempt was missing/degraded (thisAttemptFresh false) could
  // still be saved as the new canonical `daily` row — including the
  // chiefBriefPending:true/chiefBrief:null shape when no fresh same-day prior
  // existed to carry forward (the exact "first manual rebuild came back
  // blank" production bug). The SAME thisAttemptFresh check that already
  // decides whether to carry forward prior content (above) now also decides
  // whether to publish at all: a degraded/pending attempt is recorded as a
  // build attempt (the caller/build-job ledger sees it), never saved over the
  // existing fresh canonical briefing (or written as a blank one when none
  // existed yet).
  if (publish) {
    if (thisAttemptFresh) {
      try {
        await publishBriefingDraft(response);
      } catch (err) {
        // Persistence failure (audit fix, item 4): publishBriefingDraft's
        // save is now awaited and can throw. Never report this build as
        // published — the caller (the manual-rebuild route's build-job
        // status, or notify/morning.js) must see a retryable failure, not a
        // silent success with an unconfirmed row.
        console.error('[briefing build] publish failed — NOT marking as published (no push, no morning-complete marker):', err.message);
        response.publishFailed = true;
      }
    } else {
      console.log(`[briefing build] this attempt was ${response.chiefBriefQuality?.status ?? 'unknown'}-quality — NOT publishing as the canonical daily briefing (chiefBriefStale=${chiefBriefStale}, chiefBriefPending=${chiefBriefPending}); recorded as a build attempt only, existing canonical content (if any) is untouched.`);
    }
  }

  // Unambiguous displayed-content-vs-attempt-state contract (Chief Brief
  // regression fix, requirement #7) — see brain/chiefBriefContract.js.
  const { buildChiefBriefContract, attemptStateFromQuality } = require('../brain/chiefBriefContract');
  Object.assign(response, buildChiefBriefContract({
    chiefBrief: response.chiefBrief,
    source: chiefBriefStale ? 'last_good' : 'fresh',
    localDate: thisAttemptFresh ? response.localDate : (lastGood?.localDate ?? response.localDate),
    builtAt: thisAttemptFresh ? response.builtAt : (lastGood?.builtAt ?? null),
    snapshotId: thisAttemptFresh ? response.snapshotId : (lastGood?.snapshotId ?? null),
    attemptState: attemptStateFromQuality(geminiResult?.chiefBriefQuality?.status ?? null, geminiResult?.chiefBrief != null),
    attemptedAt: response.builtAt,
    reasonCodes: geminiResult?.chiefBriefQuality?.reasonCodes ?? [],
    persistenceFailed: Boolean(response.publishFailed),
  }));

  return response;
}

/**
 * Thrown by publishBriefingDraft when the post-save read-back doesn't prove
 * the exact row is retrievable/canonical-quality. Every existing caller
 * already treats a thrown publishBriefingDraft as a retryable persistence
 * failure (no push, no dedup marker, no morning-complete marker) — see
 * buildFreshBriefing's catch below and notify/morning.js's warmAndNotify —
 * so this reuses that same fail-closed path rather than needing new callers.
 */
class PublishReadbackError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PublishReadbackError';
    this.details = details;
  }
}

/**
 * The "publish" half of the prepare -> validate -> publish lifecycle: persist
 * the briefing for history/spine, prove the EXACT persisted row is actually
 * retrievable and publishable (morning-notification lifecycle fix — a push
 * must never reference a row that turns out missing/mismatched/degraded on
 * read-back), pre-warm Chief's spoken narration, and schedule the
 * next-build-cycle housekeeping. Split out of buildFreshBriefing so the
 * automatic morning path can build an unpublished draft, run its own final
 * readiness/quality check against it, and only invoke this once that check
 * still passes. Every other caller (manual rebuild, GET /api/briefing) calls
 * this immediately as part of buildFreshBriefing, exactly as before.
 *
 * @returns {Promise<{briefingId, snapshotId, snapshotVersion, localDay,
 *   generatedAt, builtAt, qualityStatus, readbackVerified:true}>} the
 *   verified publication receipt — the only thing proving this build is
 *   safe to push a notification about (never the in-memory draft itself).
 */
async function publishBriefingDraft(response) {
  // Persist the briefing for history, and capture today's data into the spine.
  // AWAITED (audit fix, item 4): every caller already writes
  // `await publishBriefingDraft(...)` as though persistence had completed by
  // the time it returns — actually awaiting the save is what makes that true.
  // A failure here now PROPAGATES (throws) instead of being silently
  // swallowed, so the caller (buildFreshBriefing / notify/morning.js's
  // warmAndNotify / the manual-rebuild build-job) can correctly report a
  // retryable failed build instead of a false "published" success.
  const saved = await briefingsStore.saveBriefing({ kind: 'daily', content: response });

  // Read-back verification: read the EXACT row back by its own primary key
  // and prove it's the row we think we just wrote — never trust the INSERT
  // (or the in-memory draft) as its own proof. This is what makes "ready"
  // mean "the exact persisted row passed verification," not merely that
  // generation or the INSERT returned.
  const tz = response.timezone || process.env.TZ || 'America/New_York';
  const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const row = await briefingsStore.findById(saved.id);
  const rowLocalDay = row ? new Date(row.generated_at).toLocaleDateString('en-CA', { timeZone: tz }) : null;

  const problems = [];
  if (!row) {
    problems.push('row_not_found');
  } else {
    if (row.kind !== 'daily') problems.push('wrong_kind');
    if (String(row.id) !== String(saved.id)) problems.push('id_mismatch');
    if ((row.content?.snapshotId ?? null) !== (response.snapshotId ?? null)) problems.push('snapshot_id_mismatch');
    if (rowLocalDay !== todayLocal) problems.push('local_day_mismatch');
    if (!row.content?.chiefBrief) problems.push('missing_chief_brief');
    if (row.content?.chiefBriefQuality?.status !== 'fresh') problems.push('quality_not_fresh');
    if (!briefingsStore.isPublishableRow(row.content)) problems.push('not_publishable');
  }
  if (problems.length) {
    throw new PublishReadbackError(
      `publish read-back verification failed for briefing ${saved.id}: ${problems.join(', ')}`,
      { briefingId: saved.id, problems }
    );
  }

  // Pre-warm Chief's spoken narration so the first tap of "Listen" plays
  // instantly instead of waiting on synthesis. Fire-and-forget from THIS
  // function's perspective (nothing here awaits it, so it never delays the
  // response). Deliberately CHIEF ONLY — Wisdom used to be prewarmed here
  // too (sequenced after Chief), but two independent background-prewarm
  // trigger paths (this one and, until removed, a boot-time backfill) could
  // each be mid-sequence at once with nothing coordinating between them:
  // production logs showed simultaneous cache MISS for both kinds and two
  // concurrent Interactions calls to the same TTS model, each timing out.
  // Wisdom now only ever synthesizes on an explicit user Listen tap
  // (routes/audio.js), which is itself protected by brief-audio.js's
  // process-wide serialization gate against colliding with a live Chief
  // prewarm or another Listen tap.
  require('../services/brief-audio').prewarmDaily(response)
    .catch((err) => console.error('[brief audio prewarm] failed:', err.message));

  // Deliberately OUTSIDE this build's lifecycle (see primeNextBuildCycle's own
  // header comment): scheduled via setImmediate so it starts only after this
  // function has already returned `response` and the caller has it in hand —
  // nothing this build serves waits on it, and nothing it does can retroactively
  // change the brief object that was just constructed and persisted above.
  setImmediate(() => {
    primeNextBuildCycle().catch((err) => console.error('[prime next build] failed:', err.message));
  });

  const receipt = {
    briefingId: saved.id,
    snapshotId: response.snapshotId ?? null,
    snapshotVersion: response.snapshotVersion ?? null,
    localDay: rowLocalDay,
    generatedAt: saved.generated_at,
    builtAt: response.builtAt ?? null,
    qualityStatus: row.content.chiefBriefQuality?.status ?? null,
    readbackVerified: true,
  };
  // Attach to the in-memory draft too, so a caller that only has `response`
  // in hand (buildFreshBriefing's own publish=true callers, including the
  // force/eager morning path) can still reach the verified receipt without
  // this function's return value ever being threaded through them.
  response.publicationReceipt = receipt;
  return receipt;
}

/**
 * Background housekeeping that runs AFTER a full build has already cut its
 * snapshot, assembled its response, and persisted it — a full ingest (every
 * connector, not just the pre-cut eight_sleep_api pull), analyze(), experiment
 * evaluation, cross-context regeneration, and proactive nudges. This is
 * intentionally NOT part of buildFreshBriefing's return path (see the
 * setImmediate call site): it exists to prime the metrics spine and findings
 * for the NEXT build/request, not to feed back into the brief that was just
 * served. It does NOT recompute wealth (that runs pre-cut, before every full
 * build — see the "Lifecycle" comment above) and it must never mutate an
 * already-persisted `briefings` row.
 *
 * If something in here writes a recovery-relevant metric (e.g. this full
 * ingest pulls a belated Eight Sleep reading the pre-cut eight_sleep_api-only
 * pull missed), that write goes through store/metrics.js's insertMetrics,
 * which independently bumps the recovery_change trigger on the invalidation
 * bus when the score materially moved (see store/metrics.js). The brief this
 * function ran after does NOT retroactively change — but the very next
 * request (cache-hit path, above) compares its stamped fieldVersions against
 * the bus and self-heals precisely the fields that moved, rather than
 * silently continuing to serve them. Exported for tests.
 */
async function primeNextBuildCycle() {
  const results = await runIngest();
  const summary = results
    .map((r) => (r.error ? `${r.id}:err` : `${r.id}:${r.metrics}m/${r.documents}d`))
    .join(' ');
  console.log(`[ingest] ${summary}`);
  // Embed new documents (best-effort), then refresh findings.
  await embedPending({ maxBatches: 4 }).catch((e) => {
    console.error('[embed] failed:', e.message);
  });

  const s = await analyze();
  if (s) console.log(`[analyze] ${s.trends} trends, ${s.correlations} correlations, ${s.actions} actions`);

  // Propose experiments from unconfirmed correlations; evaluate due ones.
  await Promise.all([
    experiments.proposeExperiments().catch((e) => console.error('[propose]', e.message)),
    experiments.evaluateDue()
      .then(async (evaluated) => {
        // A verdict is the payoff of a multi-week self-test — push it to the
        // phone the moment it lands instead of letting it sit silently.
        for (const exp of evaluated || []) {
          if (!exp?.verdict) continue;
          const icon = exp.verdict === 'confirmed' ? '✓ Confirmed' : exp.verdict === 'refuted' ? '✗ Refuted' : '~ Inconclusive';
          const pct = exp.result?.pctChange != null ? ` (${exp.result.pctChange > 0 ? '+' : ''}${Math.round(exp.result.pctChange * 100)}%)` : '';
          try {
            const nudgesStore = require('../store/nudges');
            const devicesStore = require('../store/devices');
            const { sendPush } = require('../notify/expo');
            const dedupKey = `experiment_verdict:${exp.id}`;
            const recent = await nudgesStore.recentlySentKeys(7);
            if (recent.has(dedupKey)) continue;
            const id = await nudgesStore.recordNudge({
              dedupKey,
              title: `🧪 Experiment verdict: ${icon}`,
              body: `${exp.hypothesis}${pct}`,
              priority: 0.8,
              basis: { type: 'experiment_verdict', id: exp.id, verdict: exp.verdict },
              status: 'pending',
            });
            // null means another concurrent caller already claimed this
            // exact nudge (recordNudge's atomic dedup guard) — don't
            // push a second time.
            if (id == null) continue;
            const tokens = await devicesStore.listActiveTokens();
            if (tokens.length) {
              const r = await sendPush(tokens, { title: `🧪 Experiment verdict: ${icon}`, body: `${exp.hypothesis}${pct}`, data: { type: 'experiment_verdict' } });
              for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
              await nudgesStore.markStatus(id, 'sent');
            }
          } catch (e) {
            console.error('[verdict push] failed:', e.message);
          }
        }
        return evaluated;
      })
      .catch((e) => console.error('[evaluate]', e.message)),
  ]);

  // Synthesize cross-domain relationships into plain-language insights, then run
  // a proactive push so a strong NEW connection reaches the phone unprompted
  // (deduped + quiet-hours aware inside runNudges).
  await require('../intelligence/crossContext').generateCrossContext()
    .catch((e) => console.error('[crossContext]', e.message));
  await require('../notify/run').runNudges({ suppressCheckin: true })
    .catch((e) => console.error('[proactive nudge]', e.message));
}
async function performScopedChiefBriefRebuild(prior, opts = {}) {
  const { repairReason = null } = opts;
  const ctx = await buildQuickChiefBriefContext(prior);

  // Canonical facts for the claim validator — same authorities as the full
  // build (see that call site), so the scoped rebuild enforces the identical
  // recovery/workout/completion invariants. Best-effort.
  let chiefFacts = null;
  try {
    const factsTz = process.env.TZ || 'America/New_York';
    const { canonicalFactsFrom, canonicalSpendingMtd } = require('../brain/snapshot');
    const [recForFacts, effForFacts, commitmentsForFacts, spendingMtd, experimentsForFacts, resolvedContextForFacts] = await Promise.all([
      require('../intelligence/recovery').liveRecovery().catch(() => null),
      getEffectiveWorkout({ tz: factsTz }).catch(() => null),
      require('../store/commitments').listActive({ limit: 20 }).catch(() => []),
      canonicalSpendingMtd(new Date(), factsTz).catch(() => null),
      require('../store/experiments').listExperiments().catch(() => []),
      // Same resolver the full build reads off its BrainSnapshot cut — the
      // scoped rebuild doesn't build a full snapshot, so this is its own
      // (cheap, DB-only) resolveContext() call.
      require('../intelligence/context-resolver').resolveContext({ tz: factsTz }).catch(() => null),
    ]);
    // Context Understanding Layer: same compiled-over-raw preference as the
    // full build (see that call site) — reuses resolvedContextForFacts just
    // fetched above for chiefFacts, no extra read. Audit fix (item 2): only
    // the subset of ctx.annotationsRows partitionRawContext can't match to a
    // compiled assertion is re-appended as raw fallback — same rule as the
    // full build, so the scoped rebuild can't hand the model a compiled
    // correction AND the raw text it corrected either.
    if (resolvedContextForFacts) {
      try {
        const { summarizeResolvedContext, partitionRawContext } = require('../intelligence/context-resolver');
        const compiled = summarizeResolvedContext(resolvedContextForFacts, { purpose: 'general' });
        if (compiled) {
          const { unmatched } = partitionRawContext(resolvedContextForFacts, ctx.annotationsRows || []);
          const unmatchedRaw = unmatched.length
            ? unmatched.map((a) => `${a.label}${a.note ? ` (${a.note})` : ''}`).slice(0, 5).join('; ')
            : '';
          ctx.annotationsContext = unmatchedRaw ? `${compiled}\n(raw notes, for reference): ${unmatchedRaw}` : compiled;
        }
      } catch (e) { console.error('[chief-brief rebuild] resolved-context summary failed:', e.message); }
    }
    chiefFacts = canonicalFactsFrom({
      recovery: recForFacts,
      effectiveWorkout: effForFacts,
      // The scoped rebuild only re-words the brief; it validates against the
      // SAME forecast + experiments the shown brief already reflects (carried
      // from the prior full build), so a re-worded sentence can't contradict the
      // forecast lean or an experiment verdict either.
      forecast: prior.content?.todayForecast ?? null,
      goals: ctx.liveGoals,
      commitments: commitmentsForFacts,
      experiments: experimentsForFacts,
      wealth: { spendingMtd },
      localDate: new Date().toLocaleDateString('en-CA', { timeZone: factsTz }),
      recoveryDrivers: ctx.recoveryDriverLabels,
      resolvedContext: resolvedContextForFacts,
      nightlyContextHistory: ctx.nightlyContextHistory,
    });
    // Same EvidenceClaim wiring as the full build (see that call site's
    // identical comment) — closes the gap where the scoped rebuild's
    // chiefFacts never carried .claims, silently no-opping
    // checkAssociationOverclaim for this path too.
    if (chiefFacts) chiefFacts.claims = require('../brain/evidenceClaim').buildEvidenceClaims(chiefFacts);
  } catch (e) { console.error('[chief-brief rebuild] chiefFacts assembly failed:', e.message); }

  // Same best-effort prompt context the full build feeds in (see that call
  // site) — the deterministic suppression below is the actual enforcement.
  let answeredQuestionsContext = '';
  try {
    const openQuestionsTz = process.env.TZ || 'America/New_York';
    const answeredToday = await openQuestionsStore.answeredOn(localDateStr(openQuestionsTz, new Date()));
    answeredQuestionsContext = formatAnsweredQuestionsContext(answeredToday);
  } catch (err) {
    console.error('[chief-brief rebuild][openQuestion context] failed:', err.message);
  }

  const chiefResult = await generateChiefBrief(
    ctx.emails, ctx.dayName, ctx.workout, ctx.calendar, ctx.wellbeingContext, ctx.annotationsContext,
    ctx.recoveryContext, ctx.experimentsContext, ctx.selfModel, ctx.leverageContext, ctx.workBusy,
    ctx.strengthContext, ctx.spendingContext, ctx.continuityContext, ctx.cashflowContext,
    ctx.progressContext, ctx.weeklyGoalsContext, ctx.chaptersContext, ctx.dayOffContext,
    /* attentionContext */ '', ctx.liveGoals, chiefFacts, ctx.recoveryDriversContext,
    /* calendarSourcesAvailable */ { workBusy: true, calendar: true }, answeredQuestionsContext,
    ctx.nightlyContextHistoryContext
  );

  // Same deterministic "one question" suppression the full build runs (see
  // intelligence/open-question-policy.js) — this scoped rebuild re-runs the
  // LLM from scratch with no memory of what was just answered a minute ago,
  // which is exactly the bug this route used to have: the full build applied
  // this check but the scoped rebuild never did, so answering the question
  // and immediately tapping the Chief Brief ↻ rebuild could bring it right
  // back.
  if (chiefResult.chiefBrief?.openQuestion) {
    try {
      const openQuestionsTz = process.env.TZ || 'America/New_York';
      const todayKey = localDateStr(openQuestionsTz, new Date());
      chiefResult.chiefBrief = await suppressAnsweredOpenQuestion(chiefResult.chiefBrief, { localDate: todayKey });
      // Same canonical-instance minting the full build does (see that call
      // site's comment) — this scoped rebuild only has TODAY's calendar
      // data (ctx.calendar/ctx.workBusy, carried from the prior full
      // build's own snapshot), so it can only bind a question about TODAY's
      // meeting load; one about tomorrow's simply won't match here and
      // stays a plain non-subject-bound question (the full build covers
      // that case).
      if (chiefResult.chiefBrief?.openQuestion) {
        const classifiedOverridesToday = chiefFacts?.resolvedContext
          ? require('../intelligence/context-resolver').matchCalendarClassifications(chiefFacts.resolvedContext, {
              calendar: ctx.calendar, workBusy: ctx.workBusy, targetLocalDate: todayKey,
            })
          : [];
        const todayLoad = computeCalendarLoad({
          workBusy: ctx.workBusy, calendar: ctx.calendar,
          sourcesAvailable: { workBusy: true, calendar: true },
          classifiedOverrides: classifiedOverridesToday,
        });
        chiefResult.chiefBrief = await bindOpenQuestionInstance(chiefResult.chiefBrief, {
          localDate: todayKey,
          subjectContext: { todayLoad, todayKey, todayWorkBusy: ctx.workBusy },
        });
      }
    } catch (err) {
      console.error('[chief-brief rebuild][openQuestion dedup] failed:', err.message);
    }
  }

  // Fresh-before-replace invariant (audit fix) — identical contract to the
  // full build (see that call site's comment): this rebuild's OWN chiefBrief
  // only ships when its OWN quality is fresh. A degraded scoped rebuild must
  // never overwrite the good card the user already has — "the scoped ↻
  // failed" should read as "still today's, unchanged", not as a worse brief
  // silently replacing a good one. Uses the SAME resolveLastGoodChiefBrief
  // primitive as the full build and the cache-hit recovery block (never
  // notify/morning.js's hasPublishableFreshBriefToday(prior) — see the full
  // build's identical comment for why that predicate is the wrong tool
  // here: it trusts `prior`'s OWN quality stamp, not whether prior's content
  // is actually usable, which is exactly what let a SECOND consecutive
  // failed repair delete an already-carried-forward good brief).
  const thisAttemptFresh = chiefResult.chiefBrief != null && chiefResult.chiefBriefQuality?.status === 'fresh';
  const lastGood = thisAttemptFresh ? null : await briefingsStore.resolveLastGoodChiefBrief(prior, { tz: process.env.TZ || 'America/New_York' });
  const chiefBriefStale = !thisAttemptFresh && lastGood != null;
  const errors = Array.isArray(prior.content.errors) ? prior.content.errors.filter((e) => e.service !== 'chiefBrief') : [];
  if (chiefBriefStale) {
    console.error('[chief-brief rebuild] this attempt was missing or degraded quality — keeping the existing good card unchanged.');
    errors.push({ service: 'chiefBrief', error: 'this rebuild attempt was missing or degraded quality; the existing good brief was left unchanged' });
  }
  // Same carried-forward-fallback race as the full build: `lastGood` may
  // have been resolved from a row read before the LLM call above — if the
  // user answered the question WHILE that call was in flight, this
  // in-memory object can predate the answer even though the DB row was
  // already updated. chiefResult.chiefBrief (the fresh path) was already
  // suppression-checked above right after generation.
  let finalChiefBrief = thisAttemptFresh ? chiefResult.chiefBrief : (chiefBriefStale ? lastGood.chiefBrief : null);
  if (!thisAttemptFresh && finalChiefBrief?.openQuestion) {
    try {
      const openQuestionsTz = process.env.TZ || 'America/New_York';
      finalChiefBrief = await suppressAnsweredOpenQuestion(finalChiefBrief, {
        localDate: localDateStr(openQuestionsTz, new Date()),
      });
    } catch (err) {
      console.error('[chief-brief rebuild][openQuestion dedup] failed (carried-forward brief):', err.message);
    }
  }
  // Neither this attempt nor a good same-day prior exists — explicit
  // pending, never groundedFallbackSentence() text (see the full build's
  // identical comment).
  const chiefBriefPending = finalChiefBrief == null;
  if (chiefBriefPending && chiefResult.chiefBrief != null) {
    console.error(`[chief-brief rebuild] this attempt was ${chiefResult.chiefBriefQuality?.status ?? 'unknown'}-quality and no good same-day card exists to carry forward — reporting pending, not shipping degraded prose.`);
  }
  const finalMorningFocus = thisAttemptFresh
    ? (chiefResult.morningFocus || '')
    : (chiefBriefStale ? (lastGood.morningFocus || '') : '');

  // Same explicit goal-period identity as the full build (see that call
  // site's identical comment) — ctx.goalsWeekStart is the LIVE current week
  // (buildQuickChiefBriefContext just fetched it for this request).
  const goalsWeekStart = thisAttemptFresh
    ? (ctx.goalsWeekStart ?? null)
    : (chiefBriefStale ? (lastGood.goalsWeekStart ?? null) : null);
  const chiefBriefGoalsStale = Boolean(
    goalsWeekStart && ctx.goalsWeekStart && goalsWeekStart !== ctx.goalsWeekStart
  );

  const rebuildNow = new Date().toISOString();
  const content = {
    ...prior.content,
    chiefBrief: finalChiefBrief,
    morningFocus: finalMorningFocus,
    chiefBriefStale,
    chiefBriefPending,
    goalsWeekStart,
    chiefBriefGoalsStale,
    // See the full build's identical field for the contract — always this
    // rebuild's OWN attempt, never the carried-forward card.
    chiefBriefQuality: chiefResult.chiefBriefQuality ?? null,
    errors,
    // builtAt = response PRODUCTION time, and stays the client's "rebuild
    // finished" poll signal (mobile useBriefing polls until builtAt advances),
    // so it always moves — its meaning and compatibility are preserved.
    builtAt: rebuildNow,
    // snapshotAt is deliberately NOT advanced: this scoped rebuild recut ONLY
    // the chief brief; the underlying state snapshot (recovery, workout,
    // wealth, forecast, …) was not re-derived, so it must keep the prior
    // build's snapshot time. This is the honest-timestamp fix — a scoped
    // rebuild no longer makes every untouched card look freshly derived.
    snapshotAt: prior.content.snapshotAt ?? prior.content.builtAt ?? null,
    snapshotVersion: prior.content.snapshotVersion ?? require('../brain/snapshot').SNAPSHOT_VERSION,
    // Same reasoning as snapshotAt: the snapshot IDENTITY is unchanged by a
    // scoped rebuild, so the id is carried forward (not regenerated).
    snapshotId: prior.content.snapshotId ?? null,
    // Only the chief brief + morningFocus were actually re-derived now.
    fieldsBuiltAt: stampFields(prior.content.fieldsBuiltAt, ['chiefBrief', 'morningFocus'], rebuildNow),
  };

  // Never insert a new row on a non-fresh attempt (Chief Brief regression
  // fix, Backend requirements #4/#5 — the exact root cause of the
  // "reopen the app and the good brief is gone" bug): the OLD behavior saved
  // this row unconditionally, which for the goals_stale caller (its failed
  // attempt used to force finalChiefBrief to null) inserted a brand-new
  // chiefBrief:null row as the newest daily briefing — subsequent
  // latestBriefing('daily') calls then served THAT poisoned row forever,
  // never the still-good one underneath it. A successful (fresh) repair may
  // publish updated content; a failed one leaves the previously-published
  // row completely untouched and only records the attempt in the durable
  // ledger below (never in the briefings table).
  let persistenceFailed = false;
  if (thisAttemptFresh) {
    try {
      await briefingsStore.saveBriefing({ kind: 'daily', content });
    } catch (err) {
      console.error('[chief-brief rebuild] save failed:', err.message);
      persistenceFailed = true;
    }
  } else {
    console.log(`[chief-brief rebuild] this attempt was ${chiefResult.chiefBriefQuality?.status ?? 'unknown'}-quality — NOT publishing as a new canonical daily row (chiefBriefStale=${chiefBriefStale}); the existing published content is untouched.`);
  }

  // Durable loop-protection ledger for the automatic repair callers (Part
  // 2's goals-staleness repair, and the trainingDayState-contract repair) —
  // replaces the old goalsRepairAttempt/planConflictRepairAttempt markers
  // that used to live INSIDE the saved briefing content (which no longer
  // even gets a new row on failure — see store/chiefBriefRepairLedger.js).
  // Untouched for the manual endpoint (repairReason null): a user-initiated
  // retry has no automatic-loop-protection concern.
  if (repairReason) {
    try {
      await require('../store/chiefBriefRepairLedger').recordAttempt({
        repairReason,
        succeeded: thisAttemptFresh,
        contextKey: repairReason === 'goals_stale' ? (ctx.goalsWeekStart ?? null) : null,
        reasonCodes: chiefResult.chiefBriefQuality?.reasonCodes ?? [],
      });
    } catch (err) {
      console.error('[chief-brief rebuild] repair ledger write failed:', err.message);
    }
  }

  // Unambiguous displayed-content-vs-attempt-state contract (Chief Brief
  // regression fix, requirement #7) — see brain/chiefBriefContract.js.
  const { buildChiefBriefContract, attemptStateFromQuality } = require('../brain/chiefBriefContract');
  Object.assign(content, buildChiefBriefContract({
    chiefBrief: finalChiefBrief,
    source: chiefBriefStale ? 'last_good' : 'fresh',
    localDate: content.localDate ?? null,
    builtAt: thisAttemptFresh ? rebuildNow : (lastGood?.builtAt ?? null),
    snapshotId: content.snapshotId ?? null,
    attemptState: attemptStateFromQuality(chiefResult.chiefBriefQuality?.status ?? null, chiefResult.chiefBrief != null),
    attemptedAt: rebuildNow,
    reasonCodes: chiefResult.chiefBriefQuality?.reasonCodes ?? [],
    persistenceFailed,
  }));

  // Recompute the Today command center against this rebuild's own fresh
  // chiefBrief/goalsWeekStart — everything else (forecasts, insights,
  // wealth, recovery) is carried forward from `prior.content` unchanged,
  // same as the rest of `content` above.
  let wealthLanding = prior.content.wealthLanding ?? null;
  try {
    wealthLanding = await require('../services/wealth-landing').buildWealthLandingProjection({ tz: process.env.TZ || 'America/New_York' });
  } catch (err) {
    console.error('[wealthLanding] scoped rebuild failed:', err.message);
  }

  let todayCommandCenter = prior.content.todayCommandCenter ?? null;
  try {
    // This path doesn't already fetch dismissedKeys() anywhere else (it only
    // re-derives chiefBrief/morningFocus) — one cheap extra SELECT, only on
    // a scoped rebuild (infrequent), so "On My Radar" here reflects the same
    // dismiss state the other two call sites already apply.
    let dismissedForRadar = new Set();
    try { dismissedForRadar = await require('../store/dismissedInsights').dismissedKeys(); } catch { /* fail-open: nothing filtered */ }
    todayCommandCenter = await require('../brain/todayCommandCenter').buildTodayCommandCenter({
      snapshotId: content.snapshotId, snapshotVersion: content.snapshotVersion,
      snapshotAt: content.snapshotAt, builtAt: content.builtAt,
      tz: process.env.TZ || 'America/New_York',
      chiefBrief: content.chiefBrief, chiefBriefStale: content.chiefBriefStale,
      chiefBriefPending: content.chiefBriefPending, chiefBriefQuality: content.chiefBriefQuality,
      goalsWeekStart: content.goalsWeekStart, chiefBriefGoalsStale: content.chiefBriefGoalsStale,
      forecasts: content.forecasts, todayForecast: content.todayForecast,
      healthInsights: content.healthInsights, wealthInsights: content.wealthInsights,
      weeklyReview: content.weeklyReview, wealth: content.wealth, recovery: content.recovery,
      effectiveWorkout: content.effectiveWorkout, dismissed: dismissedForRadar,
    });
  } catch (err) {
    console.error('[todayCommandCenter] scoped rebuild build failed:', err.message);
  }

  return { content, todayCommandCenter, wealthLanding };
}

function createBriefingRouter({ port }) {
  const router = express.Router();

// Fast, scoped retry for JUST the Chief-of-Staff card — added after a live
// silent-fallback bug (see briefing-ai.js's shape-validation logging and the
// chiefBriefStale flag below) kept showing yesterday's brief with no way to
// force a quick re-try short of the full 60-90s rebuild. Recomputes only the
// context generateChiefBrief needs (see buildQuickChiefBriefContext above)
// and touches ONLY chiefBrief/morningFocus/chiefBriefStale in the saved
// content — every other field (weather, wealth, insights, etc.) is untouched.
//
// Extracted from the POST /briefing/chief-brief/rebuild handler so a SECOND
// caller — the cache-hit serve path's automatic stale-goal repair (Today-tab
// cleanup, Part 2) — can trigger the identical scoped rebuild without a second,
// drifting reimplementation. `prior` is the caller's already-fetched latest
// daily briefing row; this never fetches it itself.
//
// @param {object} prior a `store/briefings.js` row `{content, generated_at}`.
// @param {object} [opts]
// @param {string|null} [opts.repairReason] 'goals_stale' | 'plan_conflict' | null
//   (null = the manual ↻ endpoint). When set, records the attempt's outcome
//   in store/chiefBriefRepairLedger.js (rebuild-loop protection for the
//   automatic callers — a user-initiated manual retry has no such concern).
//   When this attempt is missing/degraded, EVERY caller carries forward the
//   newest same-local-day PUBLISHABLE Chief Brief (store/briefings.js's
//   resolveLastGoodChiefBrief — never simply `prior`, which may itself be
//   mid-repair or already-corrupted) rather than show nothing. A non-fresh
//   attempt never inserts a new briefings row (see the save block below) —
//   only a genuinely fresh attempt is ever published.
// @returns {Promise<{content: object, todayCommandCenter: object|null}>}
router.post('/briefing/chief-brief/rebuild', asyncHandler(async (req, res) => {
  const prior = await briefingsStore.latestBriefing('daily');
  if (!prior?.content) {
    return res.status(409).json({ error: 'no briefing built yet — load the briefing first' });
  }
  const { content, todayCommandCenter, wealthLanding } = await performScopedChiefBriefRebuild(prior);
  res.json({ ...content, todayCommandCenter, wealthLanding, cached: false });
}));

// Durable build-job contract (audit fix, item 5): the mobile client used to
// infer "the rebuild finished" purely from GET /briefing's `builtAt`
// advancing past the trigger timestamp — a build that failed or came back
// with a degraded/blank Chief Brief still advances `builtAt` on every
// attempt, so a poll-by-timestamp client silently treated failure as
// success. This returns 202 + a durable build-job id/state (see
// store/morningBuildJobs.js, migration 061) that survives a process restart
// or a different Railway instance answering the status poll — the client
// polls GET /briefing/rebuild/status?buildId=..., never builtAt.
router.post('/briefing/rebuild', asyncHandler(async (req, res) => {
  const buildJobs = require('../store/morningBuildJobs');
  const tz = process.env.TZ || 'America/New_York';
  const day = buildJobs.localDay(new Date(), tz);

  const client = await require('../db').pool.connect();
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [REBUILD_LOCK_ID]);
  if (!rows[0].acquired) {
    client.release();
    // Reuse the existing advisory lock for mutual exclusion: another build
    // (manual or automatic) already owns it — return ITS active job instead
    // of quietly doing nothing, so the caller can still poll something real.
    const active = await buildJobs.activeJobForDay(day, tz).catch(() => null);
    if (active) return res.status(202).json({ buildId: active.id, state: active.state, alreadyRunning: true });
    return res.status(202).json({ buildId: null, state: 'building', alreadyRunning: true });
  }

  const attemptNumber = (await buildJobs.attemptsToday(day, tz).catch(() => 0)) + 1;
  const job = await buildJobs.createJob({ trigger: 'manual', state: 'building', attemptNumber, localDay: day, tz });
  res.status(202).json({ buildId: job.id, state: job.state });

  const release = async () => {
    try { await client.query('SELECT pg_advisory_unlock($1)', [REBUILD_LOCK_ID]); } catch { /* connection may already be gone */ }
    try { client.release(); } catch { /* already released */ }
  };

  // Direct call — same process, no reason to round-trip through our own HTTP
  // server. buildFreshBriefing itself now only calls publishBriefingDraft
  // when this attempt's OWN quality is 'fresh' (see that function) — a
  // degraded/failed/pending attempt is never saved as the canonical daily
  // briefing, so the job below is marked 'ready' ONLY when that actually
  // happened, never merely because the HTTP call didn't throw.
  (async () => {
    try {
      const result = await buildFreshBriefing({ force: true });
      const qualityStatus = result?.chiefBriefQuality?.status ?? null;
      if (result?.publishFailed) {
        await buildJobs.updateJob(job.id, {
          state: 'failed', qualityStatus, snapshotId: result?.snapshotId ?? null,
          errorMessage: 'persistence_failed — the draft was fresh but saving it did not succeed',
        });
      } else if (qualityStatus === 'fresh') {
        const latest = await require('../store/briefings').latestBriefing('daily').catch(() => null);
        await buildJobs.updateJob(job.id, {
          state: 'ready', qualityStatus, snapshotId: result?.snapshotId ?? null,
          publishedBriefingId: latest?.id ?? null,
        });
      } else {
        await buildJobs.updateJob(job.id, {
          state: 'failed', qualityStatus, snapshotId: result?.snapshotId ?? null,
          reasonCodes: result?.chiefBriefQuality?.reasonCodes ?? [],
        });
      }
    } catch (err) {
      console.error('[bg rebuild] failed:', err.message);
      await buildJobs.updateJob(job.id, { state: 'failed', errorMessage: err.message }).catch((e) => console.error('[bg rebuild] job update failed:', e.message));
    } finally {
      await release();
    }
  })();
}));

// Status poll for a build job (see POST /briefing/rebuild above). Returns
// the specific job by id when given, or today's newest job otherwise — the
// durable identity the mobile client polls instead of comparing `builtAt`.
router.get('/briefing/rebuild/status', asyncHandler(async (req, res) => {
  const buildJobs = require('../store/morningBuildJobs');
  const { buildId } = req.query;
  let job = buildId ? await buildJobs.getJob(String(buildId)) : await buildJobs.latestJobForDay();
  if (!job) return res.status(404).json({ error: 'no_build_job', message: 'No build has been triggered today.' });
  // Bug report ("it builds the brief, I close the app, reopen it, and
  // nothing is there"): a job can be orphaned "in flight" forever if the
  // process that owned it crashed before ever marking it terminal — the
  // client's own 45s give-up timer is a UI-side bound, but the SERVER
  // reporting "still building" indefinitely is what fed that timer bad
  // evidence in the first place. Durably resolve a genuinely stale one to
  // 'failed' here so every future poll (and activeJobForDay's "is a build
  // already running" check) sees the honest terminal state, not a zombie.
  if (buildJobs.isJobStale(job)) {
    job = (await buildJobs.updateJob(job.id, {
      state: 'failed',
      errorMessage: 'stale_in_flight — no update received within the expected build window; treating as abandoned',
    }).catch((e) => { console.error('[briefing status] failed to resolve stale build job:', e.message); return null; })) || job;
  }
  res.json({
    buildId: job.id,
    localDay: job.local_day,
    trigger: job.trigger,
    state: job.state,
    attemptNumber: job.attempt_number,
    snapshotId: job.snapshot_id,
    qualityStatus: job.quality_status,
    reasonCodes: job.reason_codes,
    publishedBriefingId: job.published_briefing_id,
    errorMessage: job.error_message,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  });
}));

// Exact-snapshot retrieval (morning-notification lifecycle fix, item B): the
// ONLY way a client resolves "the specific briefing a push notification
// referenced" — never the latest cache, never a fresh LLM build, never a
// substitute "latest daily" row. Reuses the SAME canonical publishability
// selector (store/briefings.js's isPublishableRow) every other surface
// already trusts rather than duplicating quality logic here.
// The canonical openWeeklyReview mobile action's server-side counterpart —
// fetches the EXACT weekly review by stable id (preferred) or weekStart
// (fallback), never by title text or array position. Used whenever a
// caller (push notification, a stale cached Today payload) doesn't already
// have the review inline and needs to fetch it directly, without
// regenerating it (regeneration is a separate, explicit weekly cron/manual
// action — this route only ever reads what's already persisted).
router.get('/briefing/weekly-review', asyncHandler(async (req, res) => {
  const { id, weekStart } = req.query;
  if (!id && !weekStart) return res.status(400).json({ error: 'missing_identifier' });
  const row = id
    ? await briefingsStore.findById(id)
    : await briefingsStore.findWeeklyReviewByWeekStart(weekStart);
  if (!row || row.kind !== 'weekly') {
    return res.status(404).json({ error: 'not_found', id: id ?? null, weekStart: weekStart ?? null });
  }
  res.json({ ...row.content, generatedAt: row.generated_at, id: row.id, weekStart: dateOnly(row.period_start) });
}));

router.get('/briefing/by-snapshot/:snapshotId', asyncHandler(async (req, res) => {
  const { snapshotId } = req.params;
  const row = await briefingsStore.findBySnapshotId('daily', snapshotId);
  if (!row || row.kind !== 'daily') {
    return res.status(404).json({ error: 'not_found', snapshotId });
  }
  const content = row.content || {};
  const qualityStatus = content.chiefBriefQuality?.status ?? null;
  if (qualityStatus === 'degraded' || qualityStatus === 'failed') {
    return res.status(409).json({ error: 'degraded', snapshotId, quality: qualityStatus });
  }
  if (!briefingsStore.isPublishableRow(content)) {
    return res.status(409).json({ error: 'not_publishable', snapshotId });
  }
  res.json(content);
}));

  router.get('/briefing', asyncHandler(async (req, res) => {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    if (!force) return res.json(await buildFreshBriefing({ force: false }));
    // Same advisory lock as POST /briefing/rebuild and the automatic morning
    // trigger (notify/morning.js) — a forced rebuild here must not race a
    // rebuild already in progress elsewhere. If one is running, degrade to
    // serving cache rather than starting a second concurrent rebuild.
    const client = await require('../db').pool.connect();
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [REBUILD_LOCK_ID]);
    if (!rows[0].acquired) {
      client.release();
      return res.json(await buildFreshBriefing({ force: false }));
    }
    try {
      res.json(await buildFreshBriefing({ force: true }));
    } finally {
      try { await client.query('SELECT pg_advisory_unlock($1)', [REBUILD_LOCK_ID]); } catch { /* connection may already be gone */ }
      try { client.release(); } catch { /* already released */ }
    }
  }));

  return router;
}

module.exports = {
  createBriefingRouter, buildFreshBriefing, publishBriefingDraft, PublishReadbackError, REBUILD_LOCK_ID,
  // Exported for the timestamp-semantics + recovery-materiality regression tests.
  stampFields, recoveryMateriallyChanged, FULL_BUILD_FIELDS,
  // Exported so tests can prove primeNextBuildCycle runs standalone, AFTER
  // buildFreshBriefing has already returned/persisted, and never mutates an
  // already-persisted brief.
  primeNextBuildCycle,
  workoutPromptShape, TRACKED_CACHE_FIELDS, REGISTRY_TO_BRIEF_FIELD,
  dateOnly,
};
