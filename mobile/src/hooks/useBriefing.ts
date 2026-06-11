import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BRIEFING_URL, authHeaders, fetchWithTimeout } from '../config';

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

export interface Recovery {
  score: number | null;
  band: 'green' | 'yellow' | 'red' | null;
  parts: Record<string, number>;
  detail: string | null;
}

export interface HealthComposite {
  type: string;
  title: string;
  detail: string | null;
  evidence?: Record<string, unknown>;
}

export interface BriefingData {
  date: string;
  weather: Weather | null;
  workout: Workout;
  calendar: CalendarEvent[];
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
  wealthInsights?: Insight[];
  healthInsights?: Insight[];
  recovery?: Recovery | null;
  healthComposites?: HealthComposite[];
  forecasts: Forecast[];
  weeklyGoals?: WeeklyGoals | null;
  relevantHighlight: RelevantHighlight | null;
  weeklyReview: WeeklyReview | null;
  wealth: Wealth | null;
  markets?: Markets | null;
  dailyQuote?: string | null;
  alerts?: Alert[];
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
  refetch: () => void;      // force a full LLM rebuild (?refresh=1)
  reload: () => void;       // serve the warm server cache instantly
  refetchLive: () => void;  // reload alias — reserved for a future partial-refresh endpoint
}

export function useBriefing(): BriefingState {
  const [data, setData] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const fetchBriefing = useCallback(async (force = false) => {
    // Cancel any request already in flight; we only want the newest one.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const myReqId = ++reqIdRef.current;

    setLoading(true);
    setError(null);

    try {
      // Default load uses the server cache (instant); pull-to-refresh forces fresh.
      const url = force ? `${API_URL}?refresh=1` : API_URL;
      // Use a longer timeout for forced rebuilds (LLM can take 60-90s server-side).
      // Cache fetches are instant; give them a short timeout so a stalled request
      // fails fast and the app can show a retry option.
      const timeoutMs = force ? 120000 : 15000;
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: authHeaders(),
        signal: controller.signal,
      }, timeoutMs);

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

  return {
    data,
    loading,
    error,
    refetch: () => fetchBriefing(true),      // force LLM rebuild (?refresh=1)
    reload: () => fetchBriefing(false),       // serve the warm morning cache instantly
    refetchLive: () => fetchBriefing(false),  // alias — future: hit /api/briefing/live
  };
}
