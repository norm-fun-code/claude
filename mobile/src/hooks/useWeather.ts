import { useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WEATHER_URL, authHeaders, fetchWithTimeout } from '../config';
import type { Weather } from './useBriefing';

const CACHE_KEY = 'normos.weather.v1';

export interface WeatherState {
  weather: Weather | null;
  loading: boolean;
  refresh: () => void; // force a fresh server pull (the card's refresh button)
}

/**
 * Standalone weather, decoupled from the full briefing so the Today card can
 * show (and refresh) weather in well under a second instead of waiting on the
 * 15-40s LLM briefing. Hydrates instantly from cache, then freshens in the
 * background; `refresh()` forces a server-side re-pull (?refresh=1).
 *
 * `seed` (the briefing's weather, if it arrived first) is used as an initial
 * value so the card is never empty when briefing data beats this fetch.
 */
export function useWeather(seed: Weather | null = null): WeatherState {
  const [weather, setWeather] = useState<Weather | null>(seed);
  const [loading, setLoading] = useState(false);
  const reqIdRef = useRef(0);

  const fetchWeather = useCallback(async (force = false) => {
    const myReqId = ++reqIdRef.current;
    setLoading(true);
    try {
      const url = force ? `${WEATHER_URL}?refresh=1` : WEATHER_URL;
      const res = await fetchWithTimeout(url, { headers: authHeaders() }, 12000);
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const { weather: w } = await res.json();
      if (myReqId !== reqIdRef.current) return; // superseded
      if (w) {
        setWeather(w);
        AsyncStorage.setItem(CACHE_KEY, JSON.stringify(w)).catch(() => {});
      }
    } catch {
      /* keep whatever we have (cache/seed) */
    } finally {
      if (myReqId === reqIdRef.current) setLoading(false);
    }
  }, []);

  // On mount: hydrate from cache (instant), then freshen in the background.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached && !cancelled) setWeather((prev) => prev ?? JSON.parse(cached));
      } catch {
        /* ignore corrupt cache */
      }
      if (!cancelled) fetchWeather(false);
    })();
    return () => { cancelled = true; };
  }, [fetchWeather]);

  // If the briefing's weather lands and we still have nothing, adopt it.
  useEffect(() => {
    if (seed) setWeather((prev) => prev ?? seed);
  }, [seed]);

  return { weather, loading, refresh: () => fetchWeather(true) };
}
