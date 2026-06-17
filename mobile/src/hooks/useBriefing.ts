import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BRIEFING_URL, BRIEFING_REBUILD_URL, authHeaders, fetchWithTimeout } from '../config';

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

export interface Newsletter {
  name: string;
  title: string;
  summary: string;
}

export interface UrgentEmail {
  from: string;
  subject: string;
  action: string;
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

export interface MarketIndex {
  label: string;
  symbol: string;
  price: number;
  change: number;
  changePct: number;
}

export interface MarketHeadline {
  title: string;
  url: string | null;
  source: string;
}

export interface Markets {
  brief?: string | null;
  sources?: MarketHeadline[];
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
}

export interface BriefingData {
  date: string;
  builtAt?: string;
  morningFocus?: string;
  chiefBrief?: ChiefBrief | null;
  experiments?: {
    completed: CompletedExperiment[];
    running: RunningExperiment[];
  };
  weather: Weather | null;
  workout: Workout;
  calendar: CalendarEvent[];
  workBusy?: WorkBusyBlock[];
  newsletters: Newsletter[];
  urgentEmails: UrgentEmail[];
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
  weeklyReview: WeeklyReview | null;
  wealth: Wealth | null;
  markets?: Markets | null;
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
  refetch: () => void;        // force a full fresh server rebuild (60-90s, blocks)
  reload: () => void;         // pull the (already-warm) server cache instantly
  refetchLive: () => void;    // mid-day partial: markets + email briefs only (fast)
  triggerRebuild: () => void; // non-blocking rebuild — responds in <1s, then polls
}

type FetchMode = 'cache' | 'rebuild' | 'live';

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

  const fetchBriefing = useCallback(async (mode: FetchMode | boolean = 'cache') => {
    // Back-compat: earlier callers passed force booleans.
    if (mode === true) mode = 'rebuild';
    if (mode === false) mode = 'cache';
    // Cancel any request already in flight; we only want the newest one.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const myReqId = ++reqIdRef.current;

    setLoading(true);
    setError(null);

    try {
      // 'cache' loads the warm server cache (instant). 'rebuild' forces the
      // full 60-90s build. 'live' refreshes just markets + email briefs on the
      // server and merges them into the cached briefing — the only sections
      // that meaningfully change during the day.
      const url =
        mode === 'rebuild' ? `${API_URL}?refresh=1`
        : mode === 'live' ? `${API_URL}/live`
        : API_URL;
      // Mode-specific timeouts: LLM rebuilds take 60-90s; cache hits are instant
      // so a short timeout lets stalled requests fail fast.
      const timeoutMs = mode === 'rebuild' ? 120000 : mode === 'cache' ? 15000 : 45000;
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: authHeaders(),
        signal: controller.signal,
      }, timeoutMs);

      // 409 from /live means no briefing has been built yet today — fall back
      // to a normal cached load (which builds one if none exists).
      if (response.status === 409 && mode === 'live') {
        if (myReqId === reqIdRef.current) fetchBriefing('cache');
        return;
      }
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
      if (!cancelled) fetchBriefing(false);
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
      fetchBriefing(false); // abort-and-replace handles any interrupted request
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

  return {
    data,
    loading,
    error,
    rebuilding,
    refetch: () => fetchBriefing('rebuild'),  // force full rebuild (blocks ~60-90s, use triggerRebuild instead)
    reload: () => fetchBriefing('cache'),     // serve the warm morning cache instantly
    refetchLive: () => fetchBriefing('live'), // markets + email briefs only
    triggerRebuild,                           // preferred: non-blocking rebuild with polling
  };
}
