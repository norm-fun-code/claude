import { useEffect, useState } from 'react';
import { authHeaders, fetchWithTimeout } from '../config';

export interface SeriesPoint { ts: string; value: number; }

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
    fetchWithTimeout(url, { headers: authHeaders() }, 12000)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const next = Array.isArray(d.rows)
          ? d.rows.filter((p: any) => Number.isFinite(Number(p.value))).map((p: any) => ({ ts: p.ts, value: Number(p.value) }))
          : [];
        setRows(next);
      })
      .catch(() => { /* offline — leave prior */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [url]);

  return { rows, values: rows.map((r) => r.value), loading };
}
