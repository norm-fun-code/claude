import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BRIEFING_URL, BRIEFING_REBUILD_URL, CHIEF_BRIEF_REBUILD_URL, authHeaders, fetchWithTimeout } from '../config';

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
  spendingThisWeek: number;
  discretionaryThisWeek?: number | null;
  incomeThisWeek: number;
  cashflowThisWeek: number;
  spendingThisMonth?: number;
  incomeThisMonth?: number;
  cashflowThisMonth?: number;
  discretionaryThisMonth?: number | null;
  syncedAt?: string | null;
}

export interface Alert {
  source: string;
  severity: 'warn' | 'high';
  message: string;
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
}

export interface Recovery {
  score: number | null;
  band: 'green' | 'yellow' | 'red' | null;
  parts: Record<string, number>;
  detail: string | null;
  rawHrv?: number | null;
  rawRhr?: number | null;
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
  experiments?: {
    completed: CompletedExperiment[];
    running: RunningExperiment[];
  };
  weather: Weather | null;
  workout: Workout;
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
}

export function useBriefing(): BriefingState {
  const [data, setData] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
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
  }, []);

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

  // Non-blocking rebuild: POST /api/briefing/rebuild returns in <1s (the actual
  // rebuild runs as a localhost loopback on the server, bypassing Railway's proxy
  // timeout). We then poll GET /api/briefing every 8s until builtAt is newer than
  // the trigger timestamp, then set the data and stop polling.
  const triggerRebuild = useCallback(async () => {
    if (rebuilding) return;
    setRebuilding(true);
    setError(null);
    if (rebuildPollRef.current) clearTimeout(rebuildPollRef.current);

    const triggeredAt = Date.now();
    try {
      const res = await fetchWithTimeout(
        BRIEFING_REBUILD_URL,
        { method: 'POST', headers: authHeaders() },
        10000
      );
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
    } catch (err: unknown) {
      setRebuilding(false);
      setError(err instanceof Error ? err.message : 'Rebuild trigger failed');
      return;
    }

    let attempts = 0;
    const MAX_ATTEMPTS = 22; // ~180s max polling window

    const poll = async () => {
      if (attempts++ >= MAX_ATTEMPTS) {
        setRebuilding(false);
        setError('Rebuild timed out — try again or check the server');
        return;
      }
      try {
        const res = await fetchWithTimeout(BRIEFING_URL, { headers: authHeaders() }, 12000);
        if (res.ok) {
          const json: BriefingData = await res.json();
          if (json.builtAt && new Date(json.builtAt).getTime() > triggeredAt) {
            setData(json);
            setRebuilding(false);
            AsyncStorage.setItem(CACHE_KEY, JSON.stringify(json)).catch(() => {});
            return;
          }
        }
      } catch {
        // Ignore individual poll errors; next attempt will retry.
      }
      rebuildPollRef.current = setTimeout(poll, 8000);
    };

    // First poll after 12s — rebuild needs at least ~10s to process external sources.
    rebuildPollRef.current = setTimeout(poll, 12000);
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
  };
}
