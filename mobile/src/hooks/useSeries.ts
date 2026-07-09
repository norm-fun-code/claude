import { useEffect, useState } from 'react';
import { authHeaders, fetchWithTimeout } from '../config';

export interface SeriesPoint { ts: string; value: number; }

// Every history/trend card on the Health and Wealth tabs shares this one
// hook (HealthCard calls it 5x, RecoveryCard 2x, WealthCard 1x) — leaving a
// tab and coming back within a few minutes re-mounts them all and re-pulls
// identical 14-30 day history each time. Cache the fetch by URL for a short
// TTL, and cache the in-flight PROMISE too so truly concurrent callers (e.g.
// HealthCard's 5 simultaneous mounts) share one request instead of each
// firing its own — same pattern as the backend's services/monarch-wealth.js.
const SERIES_CACHE_MS = 3 * 60 * 1000;
const seriesCache = new Map<string, { at: number; promise: Promise<SeriesPoint[]> }>();

function fetchSeries(url: string): Promise<SeriesPoint[]> {
  const hit = seriesCache.get(url);
  if (hit && Date.now() - hit.at < SERIES_CACHE_MS) return hit.promise;
  const promise = fetchWithTimeout(url, { headers: authHeaders() }, 12000)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (Array.isArray(d?.rows)
      ? d.rows.filter((p: any) => Number.isFinite(Number(p.value))).map((p: any) => ({ ts: p.ts, value: Number(p.value) }))
      : []))
    .catch((err) => { seriesCache.delete(url); throw err; });
  seriesCache.set(url, { at: Date.now(), promise });
  return promise;
}

// Fetches a { rows: [{ts, value}] } time-series (the shape /api/metrics/history and
// /api/recovery/history both return) and exposes the raw points + a values array
// ready for MiniBars. Pass null to skip the fetch.
export function useSeries(url: string | null) {
  const [rows, setRows] = useState<SeriesPoint[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!url) { setRows([]); return; }
    let cancelled = false;
    setLoading(true);
    fetchSeries(url)
      .then((next) => { if (!cancelled) setRows(next); })
      .catch(() => { /* offline — leave prior */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [url]);

  return { rows, values: rows.map((r) => r.value), loading };
}
