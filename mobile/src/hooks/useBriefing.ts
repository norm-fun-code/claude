import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BRIEFING_URL, BRIEFING_REBUILD_URL, BRIEFING_REBUILD_STATUS_URL, BRIEFING_BY_SNAPSHOT_URL, CHIEF_BRIEF_REBUILD_URL, authHeaders, fetchWithTimeout } from '../config';
import type { BuildJobState } from '../lib/chiefBriefState';
import { resolvePendingSince } from '../lib/chiefBriefState';
import { mergeBriefingResponse, migrateV1Cache, isValidPushSnapshot } from '../lib/briefingMerge';

const API_URL = BRIEFING_URL;
// v2 (Chief Brief regression fix): normos.briefing.v1 used to act as BOTH
// "the most recent raw server response" and "the last-known-good display
// state" — the same key a destructive setData(json) wrote to directly. v2 is
// written to ONLY via mergeBriefingResponse's output, never a raw response,
// so whatever's cached here is always already last-good-safe. See
// migrateV1Cache for one-time recovery of an already-poisoned v1 cache.
const CACHE_KEY = 'normos.briefing.v2';
const CACHE_KEY_V1 = 'normos.briefing.v1';
// Bug report: "it builds the brief, I close the app, reopen it, and nothing
// is there" — persisted so the "give up after 45s and offer Retry" fail-safe
// (chiefBriefState.ts's hasBeenPendingTooLong) survives an app close/reopen.
// BriefCard remounts on every relaunch (and every tab switch), so a
// component-local "first render with no brief" timestamp got a fresh 45
// seconds on every single reopen — the fail-safe could never fire across the
// one action a waiting user is most likely to take. See resolvePendingSince.
const PENDING_SINCE_KEY = 'normos.chiefBrief.pendingSince.v1';

export interface WeatherHour {
  time: string;
  temp: number;
  condition: string;
  uvIndex?: number | null;
  precipChance?: number | null;
}

export interface Weather {
  temp: number;
  feelsLike: number;
  condition: string;
  high: number | null;
  low: number | null;
  humidity: number;
  uvIndex: number | null;
  sunrise: string | null;
  sunset: string | null;
  hourly: WeatherHour[];
  source: string;
}

export interface Workout {
  day: string;
  type: string;
  duration: string | null;
  hrTarget: string | null;
  protein: string;
  hrvNote: string;
}

export interface CalendarEvent {
  title: string;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
  location: string | null;
  description: string | null;
}

export interface WorkBusyBlock {
  start: string;
  end: string;
}

export interface Insight {
  type: string;
  title: string;
  detail: string | null;
  confidence: number | null;
  domains?: string[];
  // Stable key the server stamps on each insight; echoed back to dismiss it.
  dismissKey?: string;
  // Structured, non-prose backing for this insight (e.g. the 'fitness'
  // insight's { current, per90, n, asOf } — see brain/evidenceClaim.js's
  // truth-and-evidence contract). Shape varies by insight type; read
  // defensively.
  evidence?: Record<string, unknown>;
}

export interface LeverageAction {
  title: string;
  detail: string | null;
}

export interface RelevantHighlight {
  title: string | null;
  author: string | null;
  content: string;
  url: string | null;
  reason?: string | null;        // specific "why now" when the match is genuine
  relevance?: 'high' | 'medium' | 'low';
}

export interface Forecast {
  title: string;
  detail: string | null;
  probability: number | null;
  status: string | null; // on_track | at_risk | off_track | on_pace | stalled | insufficient_data
}

export interface WeeklyGoalItem {
  text: string;
  achieved: boolean;
}

export interface WeeklyGoalWeek {
  weekStart: string;
  context: string | null;
  goals: WeeklyGoalItem[];
}

export interface WeeklyGoals {
  current: WeeklyGoalWeek | null;
  prior: WeeklyGoalWeek | null;
}

export interface WeeklyReview {
  headline: string;
  narrative: string;
  crossDomain?: string;
  domainReads?: { health?: string; wealth?: string; focus?: string };
  wins?: string[];
  watchouts?: string[];
  focus?: string[];
  metrics?: { label: string; thisWeek: number; lastWeek: number | null; change: number | null; goodWhen: string | null }[];
  generatedAt?: string;
  // Stable identity (backend/src/store/briefings.js's persisted row) — the
  // canonical openWeeklyReview action fetches/identifies a review by these,
  // never by headline text or array position. Optional so a review cached
  // from before these fields existed still renders (falls back to opening
  // whatever's already in the payload).
  id?: number;
  weekStart?: string;
}

export interface Wealth {
  netWorth: number | null;
  netWorthChange: number | null;
  // The exact averaging window netWorthChange was computed over (audit
  // priority #1, truth-and-evidence contract) — an honest date range instead
  // of a hardcoded "~30 days" label.
  netWorthChangeFrom?: string | null;
  netWorthChangeTo?: string | null;
  spendingThisWeek: number;
  discretionaryThisWeek?: number | null;
  incomeThisWeek: number;
  cashflowThisWeek: number;
  spendingThisMonth?: number;
  incomeThisMonth?: number;
  cashflowThisMonth?: number;
  discretionaryThisMonth?: number | null;
  // Calendar month-to-date discretionary spend — distinct from the ROLLING
  // 30-day discretionaryThisMonth above (audit priority #1 bug 7: MTD and
  // rolling-30d figures must retain explicit, separate windows).
  spendingMtd?: number | null;
  mtdSince?: string | null;
  // syncedAt is the net-worth metric's own AS-OF data date. sourceSyncedAt is
  // when Monarch itself actually last ran a sync (from the sources table) —
  // a genuinely different fact (audit priority #1 bug 9: "brief built" time
  // doesn't distinguish per-source sync times). Neither is the same as the
  // top-level BriefingData.builtAt, which is just when this API response was
  // produced.
  syncedAt?: string | null;
  sourceSyncedAt?: string | null;
}

// Wealth redesign (audit rec #5; severity/reliability cleanup) — the ONE
// canonical Wealth landing-page projection (backend/src/services/
// wealth-landing.js). The Wealth tab reads ONLY this shape; every number
// here is already fully derived server-side (severity, savings rate, plan
// pace, net-worth direction, ranking, materiality, dismissal/reactivation)
// — the client must never recompute any of it.
//
// Deterministic severity contract, shared by the summary, exception rows,
// Today radar, and Recommended Action:
//   critical    — credible urgent financial risk requiring immediate action
//   action      — meaningful unresolved issue with a concrete action
//   review      — unusual activity worth confirming, not yet confirmed
//   explained   — anomaly already explained (auto or user-confirmed)
//   on_track    — no material unresolved issue
//   unavailable — source data stale/incomplete/disconnected
export type WealthSeverity = 'critical' | 'action' | 'review' | 'explained' | 'on_track' | 'unavailable';

export interface WealthChangeCard {
  dismissKey?: string;
  type: string;
  title: string;
  detail: string | null;
  attentionClass: 'action_required' | 'watch' | 'positive' | 'informational';
  severity: WealthSeverity;
  actionable: boolean;
  evidence: Record<string, unknown> | null;
  explainedBy: { merchant: string; amount: number; day: string } | null;
}

export interface WealthRecommendedAction {
  kind: 'adjust_pace' | 'review_budget' | 'review_transaction' | 'move_cash' | 'cash_critical' | 'review';
  title: string;
  detail: string | null;
  dismissKey?: string | null;
  askPrompt: string;
}

export interface WealthLanding {
  asOf: string;
  severity: WealthSeverity;
  summary: string;
  // Wealth hierarchy redesign — the household's overall monthly trajectory
  // (spending pace + savings rate + plan pace + data completeness),
  // deliberately independent of `severity`/`exceptionCount` above: a healthy
  // trajectory must read as healthy even when a category or two stands out.
  // See backend/src/services/wealth-landing.js's derivePositionConclusion.
  // Optional so a landing payload cached from before this field existed
  // still renders (falls back to `summary`).
  positionConclusion?: { headline: string; provisional: boolean };
  // Count of unresolved per-category exceptions (action + review severities)
  // — the same counts summary/severity were computed from, so the secondary
  // "N categories stand out" affordance can never disagree with them.
  exceptionCount?: number;
  numbers: {
    mtdDiscretionary: {
      amount: number;
      // Matched-pace baseline — how this MTD figure compares to the median of
      // the same elapsed-fraction-of-month spend across trailing complete
      // months. null whenever there isn't enough comparable history (fewer
      // than 3 eligible months) — never a manufactured "typical" baseline.
      comparison: {
        coverageTier: 'typical' | 'recent' | 'insufficient';
        monthsUsed: number;
        monthsConsidered: number;
        medianBaseline: number;
        vsMedian: { dollars: number; pct: number | null };
        paceLabel: 'below_typical' | 'near_typical' | 'above_typical' | 'well_above_typical';
        previousMonthAmount: number | null;
        vsPreviousMonth: { dollars: number; pct: number | null } | null;
        drivers: { category: string; currentAmount: number; matchedMedian: number; excessDollars: number; pct: number | null }[];
        monthsBreakdown: { monthsAgo: number; ym: string; matchedDay: number; amount: number; eligible: boolean }[];
      } | null;
    } | null;
    savingsRate: { ratePct: number; income: number; spending: number; windowDays: number; healthy: boolean } | null;
    netWorth: {
      amount: number; asOf: string | null;
      // No projected year-end figure — see wealth-landing.js's comment: a
      // linear extrapolation of a short trailing slope is misleading, not
      // just optimistic. Use numbers.planPace for progress vs. the plan.
      trend: { monthlyChange: number; direction: 'growing' | 'declining'; material: boolean } | null;
    } | null;
    planPace: { planLiquidAtPace: number; delta: number; ahead: boolean; pctYearElapsed: number } | null;
    cashBuffer: { amount: number; thin: boolean; critical: boolean } | null;
  };
  whatChanged: WealthChangeCard[];
  recommendedAction: WealthRecommendedAction | null;
  sourceHealth: {
    configured: boolean; healthy: boolean; freshestHoursAgo: number | null;
    rows: { id: string; hoursAgo: number | null; isStale: boolean; lastError: string | null }[];
    qualification: string | null;
  };
  spendingDetail: { category: string; amount: number }[];
}

export interface Alert {
  source: string;
  severity: 'warn' | 'high';
  message: string;
}

export interface BriefSignalBlock {
  id: string;
  source: string;
  date: string | null;
  start: string | null;
  end: string | null;
}

export interface BriefSignal {
  key: string;
  question: string;
  context: string;
  severity: number;
  // Present on durable subject-keyed signals (e.g. calendar_load:<date>) —
  // echoed back on answer so the server can record what the underlying
  // signal looked like without re-fetching source data in the answer route.
  fingerprint?: string;
  // Canonical subject provenance ("give every question a canonical
  // subject") — the exact local date and calendar block(s) this question
  // describes, computed server-side when the question was generated. Echoed
  // back verbatim on answer (see BriefSignalsCard) so a classification
  // correction ("that's a Sabbath block, not meetings") can bind to the
  // EXACT block it was about, without the server having to reconstruct it
  // from the answer text later — see routes/annotations.js's POST
  // /briefing/context.
  subjectLocalDate?: string;
  blocks?: BriefSignalBlock[];
}

// Centralized presentation semantics (backend intelligence/recoveryPresentation.js)
// — the single source every surface (Health, Today, workout pill, Chief
// Brief, Ask, voice) renders from, so a near-green score (e.g. 59) never
// reads as alarming just because it shares recovery.band's canonical
// 'yellow' value with a genuinely moderate day. `band` here is the SAME
// canonical value as Recovery.band — never redefine or recompute it,
// always read it from this object (or Recovery.band directly).
export interface RecoveryPresentation {
  tier: 'ready' | 'solid_near_green' | 'moderate' | 'low';
  label: string;
  color: 'green' | 'warmGreen' | 'amber' | 'red';
  band: 'green' | 'yellow' | 'red';
  guidance: string;
  riskFlags: string[];
}

export interface Recovery {
  score: number | null;
  band: 'green' | 'yellow' | 'red' | null;
  parts: Record<string, number>;
  detail: string | null;
  presentation?: RecoveryPresentation | null;
  rawHrv?: number | null;
  rawRhr?: number | null;
  // True when this reading is a SUBJECTIVE self-report proxy (no Eight Sleep
  // reading last night — see backend intelligence/recovery.js's
  // selfReportRecovery), not a device-derived measurement. `parts` is never
  // populated for a proxy reading (no genuine percentile components to
  // show); render `category` + "provisional" instead of implying the same
  // precision as a real reading (truth-and-evidence contract, audit
  // priority #1).
  proxy?: boolean;
  // Categorical summary for a proxy reading ('Good' | 'Fair' | 'Poor'),
  // derived directly from the self-report — never a manufactured
  // percentile sub-score.
  category?: string;
  // The actual self-report this proxy reading is based on.
  quality?: number | null;
  hours?: number | null;
}

export interface HealthComposite {
  type: string;
  title: string;
  detail: string | null;
  evidence?: Record<string, unknown>;
}

export interface CompletedExperiment {
  id: number;
  hypothesis: string;
  verdict: 'confirmed' | 'refuted' | 'inconclusive';
  pctChange: number | null;
  effectSize: number | null;
  baselineMean: number | null;
  testMean: number | null;
  n: { baseline: number; test: number } | null;
  endDate: string | null;
}

export interface RunningExperiment {
  id: number;
  hypothesis: string;
  protocol: string | null;
  startDate: string | null;
  endDate: string | null;
  daysLeft: number | null;
}

export interface ChiefBrief {
  synthesis: string;
  action: string;
  risk: string;
  move: string;
  // The one thing the brief is genuinely unsure about today — usually empty
  // (restraint); a specific inline question when present, answerable to correct
  // the read and teach the next brief.
  openQuestion?: string;
  // Server-computed identity for openQuestion (see backend's
  // intelligence/open-question-policy.js) — echo this back verbatim in
  // POST /briefing/context's `fingerprint` field when answering. The
  // server's own answered_open_questions ledger (keyed off the question
  // TEXT, not this value) is what actually prevents a repeat; this is a
  // correctness aid for the durable record, not required for suppression
  // to work correctly.
  openQuestionFingerprint?: string | null;
  // Server-owned canonical identity for THIS instance of openQuestion (see
  // backend's intelligence/open-question-policy.js's
  // bindOpenQuestionInstance / store/openQuestionInstances.js) — minted
  // fresh every time a surviving openQuestion is generated (full build or
  // scoped rebuild). Send this back verbatim as `questionId` in POST
  // /briefing/context when answering: the server loads any structured
  // subject (e.g. which exact calendar block a meeting-load question was
  // about) from ITS OWN row by this id — never reconstructed from the
  // answer text or trusted from other client-supplied fields. Absent (or
  // null) on a briefing cached from before this field existed, or when the
  // server couldn't establish an id (see bindOpenQuestionInstance's
  // fail-safe) — the answer still submits, just without subject binding,
  // identical to the pre-this-fix behavior.
  openQuestionId?: string | null;
  // A first-person line affirming something real and specific from today's
  // data (a streak, a trend holding up, a win) — generated fresh each day,
  // not the old static "I show up with joy and courage" filler. Optional so
  // a briefing cached from before this field existed still renders.
  affirmation?: string;
}

export interface TodayForecast {
  capacity: {
    grade: 'A' | 'B' | 'C';
    band: 'green' | 'yellow' | 'red';
    headline: string;
    detail: string;
    prescription: string;
    presentation?: RecoveryPresentation | null;
  } | null;
  sleepDebt: {
    debtHours: number;
    nights: number;
    detail: string;
  } | null;
  tomorrow?: {
    band: 'green' | 'yellow' | 'red';
    projectedScore: number;
    detail: string;
    lever: string;
    confidence: number;
    presentation?: RecoveryPresentation | null;
    // Set only when something you said about today/tomorrow (voice or typed)
    // was relevant enough to add a caveat — most days this is absent.
    contextNote?: string;
  } | null;
}

// Today command-center projection (Today-tab redesign) — see backend
// brain/todayCommandCenter.js. ONE server-owned selection over canonical
// data; the client renders this verbatim and must never independently
// decide what's important, recompute risk, or resolve conflicts itself.
// Optional/possibly-absent everywhere: a briefing payload hydrated from an
// older AsyncStorage cache (written before this field existed) simply won't
// have it, and every consumer must degrade gracefully rather than crash.
export interface TodayNow {
  stableId: string;
  headline: string | null;
  detail: string | null;
  evidence?: Record<string, unknown>;
}

export interface TodayAction {
  stableId: string;
  title: string;
  rationale: string | null;
  commitmentPayload?: { text: string } | null;
}

export interface TodayRisk {
  stableId: string;
  title: string;
  rationale: string;
  severity?: string;
  evidence?: Record<string, unknown>;
}

export interface SinceMorningItem {
  stableId: string;
  occurredAt: string | null;
  // Both are the event's own explicitly-approved user-facing copy (never the
  // Attention Policy's internal decision reason/scores/gates — see backend
  // brain/todayCommandCenter.js's buildSinceMorning + store/attention.js's
  // sinceMorningForUser). summary = what changed; detail = why it matters /
  // the supporting fact.
  summary: string;
  detail: string;
  destination: string;
}

// A compact, resolvable "the plan disagrees with itself" state (Today-tab
// cleanup, Part 1) — e.g. the headline calls today a rest day while the
// action recommends a hard session. Rendered as a compact resolution
// (Keep rest day / Do X) instead of guessing which side is right; resolving
// writes an explicit workout override through the existing infrastructure.
export interface PlanConflict {
  stableId: string;
  direction: 'rest_vs_workout' | 'workout_vs_rest';
  question: string;
  effectiveWorkoutLabel: string | null;
  scheduledWorkoutLabel: string | null;
  options: Array<{ id: string; label: string; workoutId: string | null }>;
}

// Typed deep-link contract ("On My Radar" → domain tabs). `surface` is what
// navigateFromToday switches to; `entityType`/`entityId`/`anchor` are best-
// effort — a destination screen that doesn't (yet) support anchoring simply
// falls back to `fallbackRoute` (== `surface`, i.e. the top of that tab)
// rather than crash or silently do nothing.
export interface RadarDestination {
  surface: 'health' | 'wealth' | 'review' | 'today';
  entityType: string | null;
  entityId: string | null;
  anchor: string | null;
  snapshotId: string | null;
  fallbackRoute: string;
  // Present only when surface === 'review' — the canonical openWeeklyReview
  // action's identity, threaded straight through from the review row
  // (backend/src/brain/radar.js's weeklyReviewCandidate) rather than
  // re-derived from entityId/headline text.
  reviewId?: number | null;
  weekStart?: string | null;
}

// "On My Radar" — server-ranked replacement for the old fixed three-tile
// preview row (see brain/radar.js). 0-2 cards normally, never a guaranteed
// one-per-domain slot; each card carries everything the detail sheet needs
// to render without a second fetch.
//
// `attentionClass` is the ONE authoritative semantic status the server
// declares — mobile renders it consistently (see radarPresentation.ts) and
// never re-derives severity from `priority` or from card position. A
// 'positive' card is genuinely good news and must never render as a warning.
export type RadarAttentionClass = 'action_required' | 'watch' | 'ready' | 'positive' | 'informational';

export interface RadarEvidenceItem {
  label: string;
  value: string;
}

export interface RadarCard {
  stableId: string;
  domain: string;
  entityId: string | null;
  snapshotId: string | null;
  priority: number;
  status: string;
  attentionClass: RadarAttentionClass | string;
  headline: string;
  whyNow: string | null;
  evidenceSummary: string | null;
  evidenceItems: RadarEvidenceItem[] | null;
  asOf: string | null;
  actionLabel: string;
  destination: RadarDestination;
  dismissable?: boolean;
  dismissKey?: string;
}

export interface TodayCommandCenter {
  snapshotId: string | null;
  snapshotVersion: number | null;
  snapshotAt: string | null;
  builtAt: string | null;
  now: TodayNow;
  action: TodayAction | null;
  planConflict?: PlanConflict | null;
  risk: TodayRisk | null;
  sinceMorning: SinceMorningItem[];
  radar: RadarCard[];
}

export interface BriefingData {
  date: string;
  // builtAt = when this RESPONSE was produced (the rebuild-finished poll signal).
  // It advances on EVERY build, including a scoped Chief Brief rebuild that recut
  // nothing else — so it must NOT be used to label when a tab's data was derived
  // (that would make every card say "Built just now" after a text-only rebuild).
  builtAt?: string;
  // snapshotAt = when the underlying STATE snapshot was cut. Advances only on a
  // full build; a scoped rebuild carries it forward. Use THIS for a tab/card's
  // "as of" label.
  snapshotAt?: string;
  // fieldsBuiltAt[field] = when that specific field was last actually derived, so
  // a card can show the derivation time relevant to the data IT renders.
  fieldsBuiltAt?: Record<string, string>;
  // fieldVersions[field] = the backend invalidation bus's version for that
  // field AT THE TIME this content was derived (see backend brain/invalidation.js).
  // Not currently read by the client — present so the type accurately reflects
  // the API contract; a future cache-aware client could use it the same way
  // the backend's own cache-hit path does (compare against a live version to
  // detect drift since this payload was produced).
  fieldVersions?: Record<string, number>;
  snapshotId?: string;
  snapshotVersion?: number;
  // The LOCAL calendar day (YYYY-MM-DD) this content was actually built for
  // — present on every build since the Context Understanding Layer (see
  // backend routes/briefing.js's `response.localDate`). Lets a card compare
  // against "today" to know whether it's showing genuinely current content
  // or a carried-over cached build from a prior day (e.g. Wisdom after
  // midnight, before the next rebuild has landed) and label it honestly.
  localDate?: string;
  // The canonical IANA timezone `localDate` above was computed in (backend
  // routes/briefing.js's `response.timezone`, always process.env.TZ — the
  // app owner's home-base zone, never the phone's). Push-snapshot validation
  // (briefingMerge.ts's isValidPushSnapshot) must compare "is this still
  // today" using THIS zone, not the phone's current physical timezone — a
  // phone that's traveled to a different zone than home has a different
  // local midnight, and comparing against the wrong zone can reject a
  // genuinely current snapshot (or, in principle, accept a stale one).
  timezone?: string;
  morningFocus?: string;
  chiefBrief?: ChiefBrief | null;
  // True when the chiefBrief above is carried over from a prior build (this
  // build's generation failed or returned an invalid shape) rather than
  // freshly generated — lets the card say so instead of silently looking
  // like a successful rebuild that just didn't change anything.
  chiefBriefStale?: boolean;
  // True when NEITHER this build's own attempt NOR a fresh same-day prior
  // was available — chiefBrief above is null. The client shows calm
  // "Finishing…" copy in this state rather than either rendering nothing or
  // a deterministic fallback sentence mistaken for a completed brief (audit
  // fix, item C).
  chiefBriefPending?: boolean;
  // THE authoritative quality contract result for THIS build's own chiefBrief
  // attempt (backend brain/claimValidator.js's assessChiefBriefQuality) —
  // 'fresh' | 'degraded' | 'failed', plus non-prose diagnostics. Always
  // describes this build's own attempt, never a carried-forward card (see
  // chiefBriefStale) — null on a cached build that predates this contract.
  chiefBriefQuality?: { status?: 'fresh' | 'degraded' | 'failed'; [key: string]: unknown } | null;
  // The local week (Sunday, YYYY-MM-DD — see backend store/intentions.js's
  // weekStart()) whose goals chiefBrief's completion claims actually
  // describe. Compare against weeklyGoals.current.weekStart to know
  // whether they're the SAME period (truth-and-evidence contract, audit
  // priority #1 — "Chief Brief says every goal is completed while This
  // Week's Focus shows unchecked goals, and the UI does not identify the
  // periods").
  goalsWeekStart?: string | null;
  // True when chiefBrief's goal claims reference a DIFFERENT week than
  // weeklyGoals.current (the live current week) — e.g. a carried-forward
  // chiefBrief from before the week rolled over. Show an explicit qualifier
  // instead of letting "all goals done" (an earlier week) visually
  // contradict this week's fresh unchecked goals.
  chiefBriefGoalsStale?: boolean;
  // Unambiguous displayed-content-vs-attempt-state contract (Chief Brief
  // regression fix). `chiefBriefProvenance` describes WHAT chiefBrief above
  // actually is (null exactly when chiefBrief is null); `chiefBriefAttempt`
  // describes the health of the LATEST build/repair attempt, entirely
  // independently — a failed/degraded attempt can report failure here while
  // chiefBriefProvenance keeps pointing at still-good displayed content.
  chiefBriefProvenance?: {
    source: 'fresh' | 'last_good';
    localDate: string | null;
    builtAt: string | null;
    snapshotId: string | null;
  } | null;
  chiefBriefAttempt?: {
    state: 'none' | 'queued' | 'building' | 'fresh' | 'degraded' | 'failed';
    attemptedAt: string | null;
    reasonCodes: string[];
    persistenceFailed: boolean;
  } | null;
  experiments?: {
    completed: CompletedExperiment[];
    running: RunningExperiment[];
  };
  weather: Weather | null;
  workout: Workout;
  // Raw backend/src/services/workout.js getEffectiveWorkout() shape — THE
  // canonical "what's today's effective session" authority (manual override
  // > recovery-based auto-downgrade > static weekly plan). Already shipped by
  // routes/briefing.js (todayCommandCenter's plan-conflict guard consumes it
  // server-side) but was never surfaced to the mobile client's own type until
  // the Health tab redesign needed it for the Training summary card — reading
  // this exact field (not re-deriving it) is what keeps Health and Today
  // provably describing the same session (Health tab redesign, audit rec #4).
  effectiveWorkout?: {
    source: 'override' | 'auto_downgrade' | 'scheduled';
    workoutId: string | null;
    label: string;
    duration?: string | null;
    hrTarget?: string | null;
    protein?: string | null;
    isHard?: boolean;
    scheduledWorkoutId?: string | null;
    scheduledLabel?: string | null;
    recoveryBand?: string | null;
  } | null;
  calendar: CalendarEvent[];
  workBusy?: WorkBusyBlock[];
  financeSummary: string[];
  quoteInsight: string;
  notionInsight: string;
  notionQuote?: string;
  quote: string;
  notionText: string;
  notionPageTitle: string;
  leverageActions: LeverageAction[];
  insights: Insight[];
  crossContextInsights?: Insight[];
  wealthInsights?: Insight[];
  wealthLanding?: WealthLanding | null;
  // True when `wealthLanding` was carried forward from a prior response
  // (briefingMerge.ts) because the incoming response transiently lacked it —
  // never a signal that the DATA itself is stale, only that this particular
  // fetch didn't refresh it.
  wealthLandingStale?: boolean;
  healthInsights?: Insight[];
  recovery?: Recovery | null;
  healthComposites?: HealthComposite[];
  todayForecast?: TodayForecast | null;
  forecasts: Forecast[];
  weeklyGoals?: WeeklyGoals | null;
  relevantHighlight: RelevantHighlight | null;
  wellbeingTheme?: string | null;
  weeklyReview: WeeklyReview | null;
  wealth: Wealth | null;
  todayCommandCenter?: TodayCommandCenter | null;
  dailyQuote?: string | null;
  alerts?: Alert[];
  signals?: BriefSignal[];
  errors?: { service: string; error: string }[];
  // Set by the server when the cache is older than BRIEFING_CACHE_MIN (default 3h).
  // The app shows a "Rebuild briefing" CTA instead of silently serving stale data.
  stale?: boolean;
  cached?: boolean;
  cachedAgeMin?: number;
}

export interface BriefingState {
  data: BriefingData | null;
  loading: boolean;
  error: string | null;
  rebuilding: boolean;        // async rebuild in progress (fire-and-forget + polling)
  reload: () => void;         // pull the (already-warm) server cache instantly
  // Resolve a tapped morning-briefing push to its EXACT persisted snapshot
  // (morning-notification lifecycle fix) — never a generic reload.
  openFromPush: (identity: { briefingId?: string | null; snapshotId?: string | null; localDay?: string | null; builtAt?: string | null }) => void;
  triggerRebuild: () => void; // non-blocking rebuild — responds in <1s, then polls
  chiefBriefRefreshing: boolean;    // scoped chief-brief-only retry in progress
  refreshChiefBrief: () => void;    // fast, scoped retry — seconds, not the full rebuild
  // Today's durable build-job state, when one is known — lets the Chief Brief
  // card distinguish "a build is genuinely running" from "a build finished and
  // failed", instead of treating every empty-brief-without-a-fetch-error as
  // still loading. null when no job row exists for today.
  buildState: BuildJobState;
  // Safe, non-prose diagnostics for the failure the card explains.
  buildFailure: { reasonCodes: string[] | null; persistenceFailed: boolean } | null;
  // Durable (survives app close/reopen) epoch-ms anchor for "how long have we
  // had no Chief Brief" — see chiefBriefState.ts's hasBeenPendingTooLong/
  // resolvePendingSince. null while a brief is present.
  pendingSince: number | null;
}

export function useBriefing(): BriefingState {
  const [data, setData] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  // Server truth about whether a build is ACTUALLY running right now, so the
  // Chief Brief card can tell "still working" apart from "finished and
  // failed". Without this the card could only infer in-flight from the
  // absence of a client fetch error, so a build that completed hours ago with
  // an unusable Chief Brief (HTTP 200, chiefBrief: null) pulsed a skeleton
  // forever. null = no job row for today, which is NOT evidence of a build in
  // flight (the automatic morning path doesn't mint job rows).
  const [buildState, setBuildState] = useState<BuildJobState>(null);
  const [buildFailure, setBuildFailure] = useState<{ reasonCodes: string[] | null; persistenceFailed: boolean } | null>(null);
  // Durable anchor for "how long have we had no Chief Brief to show" — see
  // PENDING_SINCE_KEY above and chiefBriefState.ts's resolvePendingSince.
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  // Aborts any prior in-flight request when a new one starts, so foregrounding
  // can't leave two briefing fetches racing to setData (stale-data flash).
  const controllerRef = useRef<AbortController | null>(null);
  // Monotonic request id: only the latest request is allowed to write state.
  const reqIdRef = useRef(0);
  // Timestamp of the last SUCCESSFUL fetch, to throttle the chatty AppState
  // 'active' events (Control Center, Face ID, permission sheets, etc.). We key
  // off success, not start, so an interrupted fetch (e.g. you refreshed then
  // locked the phone before it finished) is always recoverable on foreground.
  const lastOkRef = useRef(0);
  // Poll timer for async rebuild — cleared on unmount and on new rebuild start.
  const rebuildPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while openFromPush is resolving a tapped notification's exact
  // snapshot (morning-notification lifecycle fix, item C). fetchBriefing
  // no-ops while this is set, so a concurrent generic fetch (e.g. the
  // cold-launch hydration effect, which can start before or after a
  // terminated-app notification tap is processed) can never race or
  // overwrite the push-targeted result — openFromPush itself calls
  // fetchBriefing as its OWN fallback once it's done, so nothing is lost.
  const pushResolvingRef = useRef(false);

  // One cheap, best-effort read of today's durable build job — ONLY called
  // when a fetch came back with no Chief Brief, to answer the single question
  // the briefing payload itself can't: is a build still running, or is this a
  // finished failure? A 404 (no job today, e.g. the automatic morning path)
  // clears to null rather than erroring, and the card then falls back to the
  // server's own chiefBriefQuality verdict. Never sets `error` — this is
  // supplementary diagnosis, and failing to reach it must not turn a
  // successfully-loaded briefing into an error state.
  //
  // Race-safe (Chief Brief regression fix, mobile requirement #9): `forReqId`
  // is the fetchBriefing request this probe was launched for. If a NEWER
  // request has already landed and updated state by the time this probe's
  // response arrives, this late result is discarded — a late failed status
  // probe must never blank/downgrade content a newer successful request
  // already delivered.
  const probeBuildState = useCallback(async (forReqId: number) => {
    try {
      const res = await fetchWithTimeout(BRIEFING_REBUILD_STATUS_URL, { headers: authHeaders() }, 8000);
      if (forReqId !== reqIdRef.current) return;
      if (!res.ok) { setBuildState(null); setBuildFailure(null); return; }
      const status: { state?: string; reasonCodes?: string[]; errorMessage?: string | null } = await res.json();
      if (forReqId !== reqIdRef.current) return;
      setBuildState((status.state as BuildJobState) ?? null);
      setBuildFailure({
        reasonCodes: Array.isArray(status.reasonCodes) ? status.reasonCodes : null,
        persistenceFailed: typeof status.errorMessage === 'string' && status.errorMessage.includes('persistence_failed'),
      });
    } catch {
      // Unreachable status endpoint tells us nothing — leave the card to its
      // quality-verdict / time-bound fallbacks rather than guessing.
      if (forReqId !== reqIdRef.current) return;
      setBuildState(null);
      setBuildFailure(null);
    }
  }, []);

  // Loads the warm server cache — instant, no LLM, no rebuild. The other two
  // refresh mechanisms (triggerRebuild's full async rebuild, refreshChiefBrief's
  // scoped retry below) have their own dedicated implementations; this one only
  // ever does the cheap cache read (refresh-mechanism consolidation — see the
  // product review's "five refresh concepts is four too many").
  const fetchBriefing = useCallback(async () => {
    // A push-targeted exact-snapshot resolution is in flight — it always
    // wins; it calls fetchBriefing itself as its own fallback once resolved
    // or given up on, so nothing here is lost by no-oping now.
    if (pushResolvingRef.current) return;
    // Cancel any request already in flight; we only want the newest one.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const myReqId = ++reqIdRef.current;

    setLoading(true);
    setError(null);

    try {
      const response = await fetchWithTimeout(API_URL, {
        method: 'GET',
        headers: authHeaders(),
        signal: controller.signal,
      }, 15000);

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const json: BriefingData = await response.json();
      // Ignore a stale response that a newer request has superseded.
      if (myReqId !== reqIdRef.current) return;
      lastOkRef.current = Date.now(); // mark a real success for the foreground throttle
      // Non-destructive merge (Chief Brief regression fix): a response with
      // no usable Chief Brief must never overwrite an existing same-day
      // last-good one — see mergeBriefingResponse. Applies identically to
      // cold-launch background refresh and pull/reload (this is the ONE
      // fetchBriefing call site for both).
      let merged: BriefingData = json;
      setData((prev) => {
        merged = mergeBriefingResponse(prev, json);
        return merged;
      });
      // Persist so the next app open shows this instantly (no spinner / cold start).
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(merged)).catch(() => {});
      // The fetch succeeded but there's no Chief Brief to show (even after
      // merge — i.e. no last-good card existed to protect either). That is
      // either "a build is still running" or "a build finished and failed" —
      // the briefing payload alone can't say which, and guessing "still
      // running" is what produced an indefinitely pulsing skeleton over a
      // build that had failed hours earlier. Ask the build-job endpoint
      // exactly once. Any brief present (fresh OR carried-forward) means
      // there's nothing to diagnose, so clear rather than leave a stale
      // verdict on screen.
      if (merged?.chiefBrief == null) {
        probeBuildState(myReqId);
      } else {
        setBuildState(null);
        setBuildFailure(null);
      }
    } catch (err: unknown) {
      // An aborted request isn't a real error — a newer one took over.
      if (err instanceof Error && err.name === 'AbortError') return;
      if (myReqId !== reqIdRef.current) return;
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
    } finally {
      // Only the latest request controls the spinner.
      if (myReqId === reqIdRef.current) setLoading(false);
    }
  }, [probeBuildState]);

  // Resolve a tapped "Your morning briefing is ready" notification to the
  // EXACT persisted briefing it referenced (morning-notification lifecycle
  // fix, item C) — never a generic reload, which used to show whatever
  // stale/cached envelope happened to be on screen ("Built 23h ago" above an
  // indefinite skeleton) instead of the fresh brief the push promised.
  //
  // Bounded short poll (1.5s between attempts, up to 15s total): the backend
  // only ever sends this push AFTER its own read-back verification succeeds
  // (see notify/morning.js's warmAndNotify + routes/briefing.js's
  // publishBriefingDraft), so a 404/409 here should be rare and transient
  // (replication/read-visibility lag) — never a reason to trigger a full
  // LLM rebuild. If the exact snapshot never resolves, mismatches, or turns
  // out to describe a PRIOR local day (a delayed push tapped late), this
  // falls back to a normal current-day load instead of ever showing
  // yesterday's content as if it were today's.
  const openFromPush = useCallback(async (identity: {
    briefingId?: string | null; snapshotId?: string | null; localDay?: string | null; builtAt?: string | null;
  }) => {
    const { snapshotId } = identity;
    if (!snapshotId) return fetchBriefing();

    pushResolvingRef.current = true;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const myReqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);

    const deadline = Date.now() + 15000;
    let content: BriefingData | null = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetchWithTimeout(
          `${BRIEFING_BY_SNAPSHOT_URL}/${encodeURIComponent(snapshotId)}`,
          { method: 'GET', headers: authHeaders(), signal: controller.signal },
          10000
        );
        if (res.ok) { content = await res.json(); break; }
        // 404 (not found yet — read-visibility lag) / 409 (not yet
        // publishable) are the only statuses worth a bounded retry; anything
        // else, stop immediately rather than hammer a real error.
        if (res.status !== 404 && res.status !== 409) break;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          pushResolvingRef.current = false;
          setLoading(false);
          return;
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    // Compare "is this still today" against the CANONICAL timezone this
    // snapshot's own localDate was computed in (content.timezone), never the
    // phone's raw current clock — a phone in a different timezone than the
    // app's home-base zone (mid-flight, traveling) has a different local
    // midnight, and the two would disagree near either zone's boundary.
    const tzForComparison = content?.timezone || 'America/New_York';
    const todayLocalDate = new Date().toLocaleDateString('en-CA', { timeZone: tzForComparison });
    if (!isValidPushSnapshot(content, snapshotId, todayLocalDate)) {
      pushResolvingRef.current = false;
      setLoading(false);
      return fetchBriefing();
    }

    const verified = content as BriefingData;
    lastOkRef.current = Date.now();
    // Atomic replace, not mergeBriefingResponse: this is a VERIFIED exact
    // snapshot (proven via the by-snapshot endpoint's own publishability
    // check), not an unverified generic response — the carry-forward
    // protection mergeBriefingResponse exists for is the opposite problem
    // (a generic response that might be WORSE than what's on screen).
    setData(verified);
    AsyncStorage.setItem(CACHE_KEY, JSON.stringify(verified)).catch(() => {});
    if (verified.chiefBrief == null) {
      probeBuildState(myReqId);
    } else {
      setBuildState(null);
      setBuildFailure(null);
    }
    pushResolvingRef.current = false;
    setLoading(false);
  }, [fetchBriefing, probeBuildState]);

  // On open: hydrate instantly from the last saved briefing (survives app close),
  // then quietly refresh in the background. Pull-to-refresh forces a fresh fetch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cachedV2 = await AsyncStorage.getItem(CACHE_KEY);
        if (cachedV2) {
          // Same same-local-day guard the v1->v2 migration below already
          // applies (migrateV1Cache — the function is generic over shape,
          // not actually v1-specific). Right after midnight, before
          // fetchBriefing() below resolves, this cached v2 blob can still be
          // yesterday's — without this check it would render as today's
          // Chief Brief with no staleness signal for however long the
          // network fetch takes.
          const parsedV2: BriefingData = JSON.parse(cachedV2);
          // Compare against the CACHED build's own canonical timezone (the
          // zone `localDate` on this exact cached payload was computed in),
          // not the phone's current clock — see openFromPush above for why.
          const todayLocalDate = new Date().toLocaleDateString('en-CA', { timeZone: parsedV2?.timezone || 'America/New_York' });
          const dayChecked = migrateV1Cache(parsedV2, todayLocalDate);
          if (dayChecked && !cancelled) setData(dayChecked);
        } else {
          // One-time v1 -> v2 migration (Chief Brief regression fix): an
          // already-poisoned v1 cache (chiefBrief: null written over a
          // previously-good card by the pre-fix client) must not surface as
          // today's brief — migrateV1Cache drops it while keeping the rest
          // of the cached payload (Today/Radar/weather) usable instantly.
          const cachedV1Raw = await AsyncStorage.getItem(CACHE_KEY_V1);
          if (cachedV1Raw) {
            const v1: BriefingData = JSON.parse(cachedV1Raw);
            const todayLocalDate = new Date().toLocaleDateString('en-CA', { timeZone: v1?.timezone || 'America/New_York' });
            const migrated = migrateV1Cache(v1, todayLocalDate);
            if (migrated && !cancelled) setData(migrated);
            AsyncStorage.removeItem(CACHE_KEY_V1).catch(() => {});
          }
        }
      } catch {
        // ignore corrupt cache
      }
      // Refresh in the background; if we already showed cached data, don't flash a spinner.
      if (!cancelled) fetchBriefing();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchBriefing]);

  // Durable "how long have we had no Chief Brief" anchor (see PENDING_SINCE_KEY
  // above). Reacts to `data?.chiefBrief` so it's re-evaluated after every
  // fetch/rebuild/push-resolution path that can set `data`, without needing to
  // duplicate this logic at each of those call sites. Idempotent when brief
  // stays absent across repeated polls: resolvePendingSince reuses the
  // already-stored timestamp for the same local day rather than resetting it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hasBrief = data?.chiefBrief != null;
      if (hasBrief) {
        if (!cancelled) setPendingSince(null);
        AsyncStorage.removeItem(PENDING_SINCE_KEY).catch(() => {});
        return;
      }
      const tz = data?.timezone || 'America/New_York';
      const todayLocalDate = new Date().toLocaleDateString('en-CA', { timeZone: tz });
      let stored: { day: string; ts: number } | null = null;
      try {
        const raw = await AsyncStorage.getItem(PENDING_SINCE_KEY);
        if (raw) stored = JSON.parse(raw);
      } catch {
        stored = null; // corrupt entry — treat as none, re-anchor fresh below
      }
      const ts = resolvePendingSince(stored, false, todayLocalDate, Date.now());
      if (!cancelled) setPendingSince(ts);
      AsyncStorage.setItem(PENDING_SINCE_KEY, JSON.stringify({ day: todayLocalDate, ts })).catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [data?.chiefBrief, data?.timezone]);

  // When the app returns to the foreground, quietly freshen the briefing so a
  // refresh that iOS suspended on backgrounding doesn't leave stale data. The
  // 'active' event is chatty (Control Center, Face ID, share sheets…), so
  // throttle to avoid firing a 45s-capable request on every trivial transition.
  useEffect(() => {
    const FOREGROUND_THROTTLE_MS = 60000;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      // Skip only if we recently SUCCEEDED. If the last fetch was interrupted
      // (e.g. refreshed then locked the phone), lastOkRef is stale so we recover.
      if (Date.now() - lastOkRef.current < FOREGROUND_THROTTLE_MS) return;
      fetchBriefing(); // abort-and-replace handles any interrupted request
    });
    return () => sub.remove();
  }, [fetchBriefing]);

  // Clean up poll timer on unmount so it can't fire after the component is gone.
  useEffect(() => {
    return () => {
      if (rebuildPollRef.current) clearTimeout(rebuildPollRef.current);
    };
  }, []);

  // Non-blocking rebuild: POST /api/briefing/rebuild returns 202 + a durable
  // build-job id/state immediately (the actual rebuild runs as a localhost
  // loopback on the server, bypassing Railway's proxy timeout). We then poll
  // GET /api/briefing/rebuild/status?buildId=... until the job reaches a
  // terminal state — NEVER by comparing builtAt, which a failed/degraded
  // attempt advances just as readily as a real success (the exact bug this
  // replaces: a blank Chief Brief with a fresh builtAt used to read as
  // "rebuild succeeded"). The last-known-good `data` is left untouched for
  // the whole poll — only a job that reaches 'ready' replaces it.
  const triggerRebuild = useCallback(async () => {
    if (rebuilding) return;
    setRebuilding(true);
    setError(null);
    // A build we just asked for IS in flight — clear any prior failure verdict
    // immediately so the card shows progress rather than the old failure while
    // the first status poll is still 5s out.
    setBuildState('building');
    setBuildFailure(null);
    if (rebuildPollRef.current) clearTimeout(rebuildPollRef.current);

    let buildId: string | null = null;
    try {
      const res = await fetchWithTimeout(
        BRIEFING_REBUILD_URL,
        { method: 'POST', headers: authHeaders() },
        10000
      );
      // 202 is the durable-job contract's normal response (both a fresh
      // trigger and "another build already owns this" carry a pollable id).
      if (!res.ok && res.status !== 202) {
        throw new Error(`Server returned ${res.status}`);
      }
      const json = await res.json().catch(() => ({} as { buildId?: string })) as { buildId?: string };
      buildId = json.buildId ?? null;
    } catch (err: unknown) {
      setRebuilding(false);
      setBuildState(null); // never leave a phantom 'building' after a failed trigger
      setError(err instanceof Error ? err.message : 'Rebuild trigger failed');
      return;
    }

    let attempts = 0;
    const MAX_ATTEMPTS = 36; // ~180s max polling window (5s cadence)

    const poll = async () => {
      if (attempts++ >= MAX_ATTEMPTS) {
        setRebuilding(false);
        // Stop claiming a build is in flight once we've given up watching it —
        // otherwise the card would keep showing a skeleton indefinitely, the
        // exact failure mode this whole contract exists to prevent.
        setBuildState(null);
        setError('Rebuild timed out — try again or check the server');
        return;
      }
      try {
        const url = buildId
          ? `${BRIEFING_REBUILD_STATUS_URL}?buildId=${encodeURIComponent(buildId)}`
          : BRIEFING_REBUILD_STATUS_URL;
        const res = await fetchWithTimeout(url, { headers: authHeaders() }, 12000);
        if (res.ok) {
          const status: { buildId?: string; state?: string; reasonCodes?: string[]; errorMessage?: string | null } = await res.json();
          if (!buildId && status.buildId) buildId = status.buildId;
          setBuildState((status.state as BuildJobState) ?? null);
          if (status.state === 'ready') {
            // The job published a genuinely fresh brief — fetch the actual
            // content (the status poll itself is metadata-only). Still
            // merged (not a raw setData) for consistency — a 'ready' job's
            // own chiefBrief is always usable, so the merge is a no-op here,
            // but going through the SAME merge point everywhere means there
            // is exactly one place this rule can ever be implemented.
            const briefRes = await fetchWithTimeout(BRIEFING_URL, { headers: authHeaders() }, 12000);
            if (briefRes.ok) {
              const json: BriefingData = await briefRes.json();
              let merged: BriefingData = json;
              setData((prev) => { merged = mergeBriefingResponse(prev, json); return merged; });
              AsyncStorage.setItem(CACHE_KEY, JSON.stringify(merged)).catch(() => {});
            }
            setBuildFailure(null);
            setRebuilding(false);
            return;
          }
          if (status.state === 'failed') {
            // A degraded/failed/unpersisted attempt — the existing `data`
            // (last known good, or none) is left exactly as it was; never
            // rendered as if this attempt had succeeded. The card reads
            // buildState/buildFailure to explain WHY rather than spinning.
            setBuildFailure({
              reasonCodes: Array.isArray(status.reasonCodes) ? status.reasonCodes : null,
              persistenceFailed: typeof status.errorMessage === 'string' && status.errorMessage.includes('persistence_failed'),
            });
            setRebuilding(false);
            setError('Rebuild did not produce a usable brief — tap to try again.');
            return;
          }
          // 'queued' | 'building' | 'retry_wait' | 'waiting_for_sleep' — keep polling.
        }
      } catch {
        // Ignore individual poll errors; next attempt will retry.
      }
      rebuildPollRef.current = setTimeout(poll, 5000);
    };

    // First poll after 5s — the status row exists immediately (created
    // before the 202 response), unlike the old builtAt-diffing approach
    // which had to wait out most of the build before a poll meant anything.
    rebuildPollRef.current = setTimeout(poll, 5000);
  }, [rebuilding]);

  const [chiefBriefRefreshing, setChiefBriefRefreshing] = useState(false);

  // Fast, scoped retry for just the Chief-of-Staff card — POST responds
  // directly in a few seconds (no polling needed, unlike triggerRebuild's
  // 60-90s full build) since the server only recomputes that one section.
  const refreshChiefBrief = useCallback(async () => {
    if (chiefBriefRefreshing) return;
    setChiefBriefRefreshing(true);
    try {
      const res = await fetchWithTimeout(CHIEF_BRIEF_REBUILD_URL, { method: 'POST', headers: authHeaders() }, 20000);
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const json: BriefingData = await res.json();
      // Non-destructive merge (Chief Brief regression fix): a failed scoped
      // retry must retain whatever last-good card was already on screen —
      // see mergeBriefingResponse. (The server itself already carries
      // forward last-good content in `json` on a failed repair — see
      // routes/briefing.js's performScopedChiefBriefRebuild — this is
      // defense-in-depth against a stale/poisoned client cache.)
      let merged: BriefingData = json;
      setData((prev) => { merged = mergeBriefingResponse(prev, json); return merged; });
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(merged)).catch(() => {});
      // A scoped retry that came back with a usable card clears the stale
      // failure verdict; one that didn't leaves the card to explain why from
      // this attempt's own chiefBriefQuality (already in `merged`).
      if (merged?.chiefBrief != null) { setBuildState(null); setBuildFailure(null); }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Chief-brief refresh failed');
    } finally {
      setChiefBriefRefreshing(false);
    }
  }, [chiefBriefRefreshing]);

  return {
    data,
    loading,
    error,
    rebuilding,
    reload: fetchBriefing, // serve the warm morning cache instantly
    openFromPush,                              // resolve a tapped morning-briefing push to its exact snapshot
    triggerRebuild,                           // preferred: non-blocking rebuild with polling
    chiefBriefRefreshing,
    refreshChiefBrief,
    buildState,
    buildFailure,
    pendingSince,
  };
}
