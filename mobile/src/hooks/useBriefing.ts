import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BRIEFING_URL, authHeaders } from '../config';

const API_URL = BRIEFING_URL;
const CACHE_KEY = 'normos.briefing.v1';

export interface WeatherHour {
  time: string;
  temp: number;
  condition: string;
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
  incomeThisWeek: number;
  cashflowThisWeek: number;
}

export interface Alert {
  source: string;
  severity: 'warn' | 'high';
  message: string;
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
  quote: string;
  notionText: string;
  notionPageTitle: string;
  leverageActions: LeverageAction[];
  insights: Insight[];
  wealthInsights?: Insight[];
  healthInsights?: Insight[];
  forecasts: Forecast[];
  relevantHighlight: RelevantHighlight | null;
  weeklyReview: WeeklyReview | null;
  wealth: Wealth | null;
  markets?: Markets | null;
  dailyQuote?: string | null;
  alerts?: Alert[];
  errors?: { service: string; error: string }[];
}

export interface BriefingState {
  data: BriefingData | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useBriefing(): BriefingState {
  const [data, setData] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBriefing = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);

    try {
      // Default load uses the server cache (instant); pull-to-refresh forces fresh.
      const url = force ? `${API_URL}?refresh=1` : API_URL;
      const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const json: BriefingData = await response.json();
      setData(json);
      // Persist so the next app open shows this instantly (no spinner / cold start).
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(json)).catch(() => {});
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
    } finally {
      setLoading(false);
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

  return { data, loading, error, refetch: () => fetchBriefing(true) };
}
