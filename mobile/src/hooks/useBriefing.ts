import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BRIEFING_URL, BRIEFING_REBUILD_URL, BRIEFING_REBUILD_STATUS_URL, CHIEF_BRIEF_REBUILD_URL, authHeaders, fetchWithTimeout } from '../config';
import type { BuildJobState } from '../lib/chiefBriefState';

const API_URL = BRIEFING_URL;
const CACHE_KEY = 'normos.briefing.v1';

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

export interface Recovery {
  score: number | null;
  band: 'green' | 'yellow' | 'red' | null;
  parts: Record<string, number>;
  detail: string | null;
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
  summary: string;
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

  // One cheap, best-effort read of today's durable build job — ONLY called
  // when a fetch came back with no Chief Brief, to answer the single question
  // the briefing payload itself can't: is a build still running, or is this a
  // finished failure? A 404 (no job today, e.g. the automatic morning path)
  // clears to null rather than erroring, and the card then falls back to the
  // server's own chiefBriefQuality verdict. Never sets `error` — this is
  // supplementary diagnosis, and failing to reach it must not turn a
  // successfully-loaded briefing into an error state.
  const probeBuildState = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(BRIEFING_REBUILD_STATUS_URL, { headers: authHeaders() }, 8000);
      if (!res.ok) { setBuildState(null); setBuildFailure(null); return; }
      const status: { state?: string; reasonCodes?: string[]; errorMessage?: string | null } = await res.json();
      setBuildState((status.state as BuildJobState) ?? null);
      setBuildFailure({
        reasonCodes: Array.isArray(status.reasonCodes) ? status.reasonCodes : null,
        persistenceFailed: typeof status.errorMessage === 'string' && status.errorMessage.includes('persistence_failed'),
      });
    } catch {
      // Unreachable status endpoint tells us nothing — leave the card to its
      // quality-verdict / time-bound fallbacks rather than guessing.
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
      setData(json);
      // Persist so the next app open shows this instantly (no spinner / cold start).
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(json)).catch(() => {});
      // The fetch succeeded but there's no Chief Brief to show. That is either
      // "a build is still running" or "a build finished and failed" — the
      // briefing payload alone can't say which, and guessing "still running"
      // is what produced an indefinitely pulsing skeleton over a build that
      // had failed hours earlier. Ask the build-job endpoint exactly once.
      // Any brief present (fresh OR carried-forward) means there's nothing to
      // diagnose, so clear rather than leave a stale verdict on screen.
      if (json?.chiefBrief == null) {
        probeBuildState();
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

  // On open: hydrate instantly from the last saved briefing (survives app close),
  // then quietly refresh in the background. Pull-to-refresh forces a fresh fetch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached && !cancelled) setData(JSON.parse(cached));
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
            // content (the status poll itself is metadata-only).
            const briefRes = await fetchWithTimeout(BRIEFING_URL, { headers: authHeaders() }, 12000);
            if (briefRes.ok) {
              const json: BriefingData = await briefRes.json();
              setData(json);
              AsyncStorage.setItem(CACHE_KEY, JSON.stringify(json)).catch(() => {});
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
      setData(json);
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(json)).catch(() => {});
      // A scoped retry that came back with a usable card clears the stale
      // failure verdict; one that didn't leaves the card to explain why from
      // this build's own chiefBriefQuality (already in `json`).
      if (json?.chiefBrief != null) { setBuildState(null); setBuildFailure(null); }
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
    triggerRebuild,                           // preferred: non-blocking rebuild with polling
    chiefBriefRefreshing,
    refreshChiefBrief,
    buildState,
    buildFailure,
  };
}
