// Apple Health historical backfill.
//
// Queries HealthKit for up to N days of history using bulk date-range queries
// (one call per metric type, not one per day), then groups results client-side
// by calendar day and uploads them in batches to /api/ingest/health with per-row
// `ts` fields. The backend's upsert semantics make this safe to re-run.
import { useState, useCallback } from 'react';
import AppleHealthKit, { HealthValue, HealthKitPermissions } from 'react-native-health';
import { HEALTH_INGEST_URL, ANALYZE_URL, authHeaders } from '../config';

export type BackfillStatus = 'idle' | 'running' | 'done' | 'error';

export interface BackfillState {
  status: BackfillStatus;
  progress: string;
  daysLoaded: number;
  rowsUploaded: number;
  error: string | null;
  start: (daysBack?: number) => void;
}

const PERMISSIONS: HealthKitPermissions = {
  permissions: {
    read: [
      AppleHealthKit.Constants.Permissions.HeartRateVariability,
      AppleHealthKit.Constants.Permissions.RestingHeartRate,
      AppleHealthKit.Constants.Permissions.SleepAnalysis,
      AppleHealthKit.Constants.Permissions.Steps,
      AppleHealthKit.Constants.Permissions.ActiveEnergyBurned,
    ],
    write: [],
  },
};

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Noon UTC on a YYYY-MM-DD — matches backend dayAnchorTs so upsert keys align.
function noonUTC(dateStr: string): string {
  return `${dateStr}T12:00:00.000Z`;
}

function mergedHours(samples: { startDate: string; endDate: string }[]): number {
  const spans = samples
    .map((s) => [new Date(s.startDate).getTime(), new Date(s.endDate).getTime()])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0, curStart = -1, curEnd = -1;
  for (const [a, b] of spans) {
    if (a > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = a; curEnd = b;
    } else if (b > curEnd) {
      curEnd = b;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total / 3600000;
}

function sleepScore(total: number | null, deep: number | null, rem: number | null): number | null {
  if (!total || total <= 0) return null;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const comps: { v: number; w: number }[] = [{ v: clamp(total / 8), w: 0.5 }];
  if (deep !== null) comps.push({ v: clamp(deep / 1.5), w: 0.25 });
  if (rem !== null) comps.push({ v: clamp(rem / 1.75), w: 0.25 });
  const wsum = comps.reduce((s, c) => s + c.w, 0);
  return Math.round(comps.reduce((s, c) => s + c.v * (c.w / wsum), 0) * 100);
}

// Promisify a HealthKit call that takes a callback(err, result).
function hk<T>(fn: (cb: (err: any, r: T) => void) => void): Promise<T | null> {
  return new Promise((resolve) => fn((err, r) => resolve(err ? null : r)));
}

export function useHealthBackfill(): BackfillState {
  const [status, setStatus] = useState<BackfillStatus>('idle');
  const [progress, setProgress] = useState('');
  const [daysLoaded, setDaysLoaded] = useState(0);
  const [rowsUploaded, setRowsUploaded] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async (daysBack = 365) => {
    setStatus('running');
    setProgress('Initializing HealthKit…');
    setDaysLoaded(0);
    setRowsUploaded(0);
    setError(null);

    // initHealthKit uses a different callback shape (err only, no result).
    const initOk = await new Promise<boolean>((resolve) =>
      AppleHealthKit.initHealthKit(PERMISSIONS, (err) => resolve(!err))
    );
    if (!initOk) {
      setStatus('error');
      setError('HealthKit unavailable — run on a physical device with Apple Watch');
      return;
    }

    const endDate = new Date().toISOString();
    const startMs = Date.now() - daysBack * 86400000;
    const startDate = new Date(startMs).toISOString();
    // Sleep window needs an extra day so we capture the first night's samples.
    const sleepStart = new Date(startMs - 86400000).toISOString();

    setProgress('Fetching HRV samples…');
    const hrvRaw = await hk<HealthValue[]>((cb) =>
      AppleHealthKit.getHeartRateVariabilitySamples({ startDate, endDate, unit: 'millisecond' } as any, cb)
    ) ?? [];

    setProgress('Fetching resting heart rate samples…');
    const rhrRaw = await hk<HealthValue[]>((cb) =>
      (AppleHealthKit as any).getRestingHeartRateSamples({ startDate, endDate }, cb)
    ) ?? [];

    setProgress('Fetching sleep samples…');
    const sleepRaw = await hk<HealthValue[]>((cb) =>
      AppleHealthKit.getSleepSamples({ startDate: sleepStart, endDate }, cb)
    ) ?? [];

    setProgress('Fetching step count samples…');
    const stepRaw = await hk<HealthValue[]>((cb) =>
      (AppleHealthKit as any).getDailyStepCountSamples({ startDate, endDate }, cb)
    ) ?? [];

    setProgress('Fetching active energy samples…');
    const energyRaw = await hk<HealthValue[]>((cb) =>
      AppleHealthKit.getActiveEnergyBurned({ startDate, endDate } as any, cb)
    ) ?? [];

    setProgress('Aggregating by day…');

    // HRV: overnight samples only (9pm–9am) to stay consistent with Eight
    // Sleep readings. Daytime Apple Watch spot readings run higher and inflate
    // the baseline, making normal overnight readings look like dips.
    // Assign each overnight sample to the morning it woke up on (the endDate's
    // local date), so a reading at 3am on Jun 13 is filed under Jun 13.
    const hrvByDay = new Map<string, number[]>();
    for (const s of hrvRaw) {
      const sampleDate = new Date(s.startDate);
      const hour = sampleDate.getHours();
      const isOvernight = hour >= 21 || hour < 9;
      if (!isOvernight) continue;
      // Assign to the local date of the END of the overnight window (morning).
      const endDate = new Date((s as any).endDate ?? s.startDate);
      const d = localDateStr(endDate.getHours() < 12 ? endDate : sampleDate);
      if (!hrvByDay.has(d)) hrvByDay.set(d, []);
      hrvByDay.get(d)!.push(s.value * 1000);
    }

    // RHR: last reading per day
    const rhrByDay = new Map<string, number>();
    for (const s of rhrRaw) {
      const d = localDateStr(new Date((s as any).startDate));
      rhrByDay.set(d, Math.round(s.value));
    }

    // Steps: getDailyStepCountSamples can return multiple entries per day when
    // multiple sources (iPhone + Watch, or multiple apps) each report their count.
    // Take the MAX per day — the highest value is the consolidated total;
    // individual source values are always ≤ the consolidated aggregate.
    const stepsByDay = new Map<string, number>();
    for (const s of stepRaw) {
      const d = localDateStr(new Date(s.startDate));
      stepsByDay.set(d, Math.max(stepsByDay.get(d) ?? 0, Math.round(s.value)));
    }

    // Active energy: sum individual workout samples per day
    const energyByDay = new Map<string, number>();
    for (const s of energyRaw) {
      const d = localDateStr(new Date(s.startDate));
      energyByDay.set(d, (energyByDay.get(d) ?? 0) + s.value);
    }

    // Sleep: assign each session to the local date its endDate falls on.
    // Overnight sleep (starts 10pm, ends 6am) → assigned to the morning date.
    const isAsleepStage = (v: string) =>
      ['ASLEEP', 'DEEP', 'CORE', 'REM', 'ASLEEPDEEP', 'ASLEEPCORE', 'ASLEEPREM'].includes(v);
    const isDeep = (v: string) =>
      v === 'DEEP' || v === 'ASLEEPDEEP' || v === 'SLEEP_DEEP';
    const isREM = (v: string) =>
      v === 'REM' || v === 'ASLEEPREM' || v === 'SLEEP_REM';

    const sleepByDay = new Map<string, (typeof sleepRaw[number])[]>();
    for (const s of sleepRaw) {
      const d = localDateStr(new Date((s as any).endDate));
      if (!sleepByDay.has(d)) sleepByDay.set(d, []);
      sleepByDay.get(d)!.push(s);
    }

    // Collect all days with any data
    const allDays = new Set([
      ...hrvByDay.keys(),
      ...rhrByDay.keys(),
      ...stepsByDay.keys(),
      ...energyByDay.keys(),
      ...sleepByDay.keys(),
    ]);

    const rows: { metric: string; value: number; unit: string; ts: string }[] = [];
    const round1 = (n: number) => Math.round(n * 10) / 10;

    for (const day of allDays) {
      const ts = noonUTC(day);

      const hrvVals = hrvByDay.get(day);
      if (hrvVals?.length) {
        const avg = Math.round(hrvVals.reduce((a, b) => a + b, 0) / hrvVals.length);
        rows.push({ metric: 'hrv', value: avg, unit: 'ms', ts });
      }

      const rhr = rhrByDay.get(day);
      if (rhr != null) rows.push({ metric: 'resting_hr', value: rhr, unit: 'bpm', ts });

      const steps = stepsByDay.get(day);
      if (steps != null) rows.push({ metric: 'steps', value: steps, unit: 'count', ts });

      const energy = energyByDay.get(day);
      if (energy != null) rows.push({ metric: 'active_energy', value: Math.round(energy), unit: 'kcal', ts });

      const sessions = sleepByDay.get(day) ?? [];
      const asleep = sessions.filter((s: any) => isAsleepStage(s.value));
      if (asleep.length) {
        const total = round1(mergedHours(asleep as any));
        const deep = asleep.filter((s: any) => isDeep(s.value));
        const rem = asleep.filter((s: any) => isREM(s.value));
        const deepH = deep.length ? round1(mergedHours(deep as any)) : null;
        const remH = rem.length ? round1(mergedHours(rem as any)) : null;
        const score = sleepScore(total, deepH, remH);
        if (total > 0) {
          rows.push({ metric: 'sleep_hours', value: total, unit: 'hours', ts });
          if (deepH !== null) rows.push({ metric: 'deep_sleep_hours', value: deepH, unit: 'hours', ts });
          if (remH !== null) rows.push({ metric: 'rem_sleep_hours', value: remH, unit: 'hours', ts });
          if (score !== null) rows.push({ metric: 'sleep_score', value: score, unit: 'score', ts });
        }
      }
    }

    // Upload in 1000-row chunks (backend handles up to 5000; stay conservative
    // for request size on mobile connections).
    const CHUNK = 1000;
    let uploaded = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      setProgress(`Uploading ${Math.min(i + CHUNK, rows.length)} / ${rows.length} data points…`);
      try {
        await fetch(HEALTH_INGEST_URL, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(chunk),
        });
        uploaded += chunk.length;
      } catch {
        // Non-fatal — upsert is idempotent, user can retry
      }
    }

    // Re-run analysis so the new data flows into findings and correlations.
    setProgress('Rebuilding insights from new data…');
    try {
      await fetch(ANALYZE_URL, { method: 'POST', headers: authHeaders() });
    } catch { /* non-critical */ }

    setDaysLoaded(allDays.size);
    setRowsUploaded(uploaded);
    setStatus('done');
    setProgress(`${allDays.size} days loaded · ${uploaded.toLocaleString()} data points`);
  }, []);

  return { status, progress, daysLoaded, rowsUploaded, error, start };
}
