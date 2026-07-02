import { useState, useEffect, useCallback } from 'react';
import AppleHealthKit, {
  HealthKitPermissions,
  HealthValue,
} from 'react-native-health';
import { HEALTH_INGEST_URL, SLEEP_TODAY_URL, authHeaders, fetchWithTimeout } from '../config';

// Persist on-device HealthKit readings to the NormOS spine. Canonical metric
// names match backend/src/ingest/health.js. Fire-and-forget: never block the UI.
async function pushHealthData(rows: { metric: string; value: number; unit: string }[]) {
  const payload = rows.filter((r) => r.value != null && Number.isFinite(r.value));
  if (payload.length === 0) return;
  try {
    await fetch(HEALTH_INGEST_URL, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
  } catch {
    // offline / backend down — the next refresh will resend
  }
}

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
// Noon-UTC of a local date — matches the backend's dayAnchorTs so per-day rows
// upsert onto the same key the daily live sync uses.
function noonUTC(dateStr: string): string {
  return `${dateStr}T12:00:00.000Z`;
}

// Re-fetch and persist COMPLETE daily totals for the last `daysBack` days of the
// CUMULATIVE metrics (steps, active energy). Why this exists: the per-open live
// sync below only ever writes "today", which is a partial running total until
// midnight. Without this, every past day stays frozen at whatever partial count
// it had when you last opened the app that day — systematically far below your
// true daily total (e.g. 3,951 stored vs 10,948 real). Pushing the last week of
// finalized daily totals (with explicit per-day timestamps) lets the backend's
// GREATEST upsert lock in each day's real total once the day is over. Today is
// still partial, but analyze drops the current day from cumulative trends.
async function finalizeRecentCumulativeDays(daysBack = 30): Promise<void> {
  const hk = <T,>(fn: (cb: (err: any, r: T) => void) => void): Promise<T | null> =>
    new Promise((resolve) => fn((err, r) => resolve(err ? null : r)));

  const rows: { metric: string; value: number; unit: string; ts: string }[] = [];

  // STEPS — query each day individually with getStepCount. Critical: do NOT use
  // getDailyStepCountSamples — its native impl buckets by 60-min periods AND
  // splits by source (HKStatisticsOptionSeparateBySource), so you get hourly,
  // per-device fragments, not a daily total. getStepCount uses
  // predicateForSamplesOnDay + CumulativeSum with NO source split — the
  // deduplicated daily total that matches the Apple Health app. The day
  // predicate uses the DEVICE's local (e.g. EST) calendar day, so attribution
  // is correct. One call per day (cheap HealthKit queries), run in parallel.
  const dayStarts: Date[] = [];
  for (let i = 0; i < daysBack; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(12, 0, 0, 0); // noon local — unambiguously inside the target day
    dayStarts.push(d);
  }
  const stepResults = await Promise.all(
    dayStarts.map((d) =>
      hk<HealthValue>((cb) =>
        AppleHealthKit.getStepCount({ date: d.toISOString(), includeManuallyAdded: true } as any, cb)
      )
    )
  );
  stepResults.forEach((res, i) => {
    if (res && Number.isFinite(res.value) && res.value > 0) {
      rows.push({ metric: 'steps', value: Math.round(res.value), unit: 'count', ts: noonUTC(localDateStr(dayStarts[i])) });
    }
  });

  // ACTIVE ENERGY — same per-day approach via getActiveEnergyBurned bounded to
  // each local day, summed. (Active energy is Watch-authored and not
  // source-duplicated like steps, so summing the day's samples is correct.)
  const energyResults = await Promise.all(
    dayStarts.map((d) => {
      const start = new Date(d); start.setHours(0, 0, 0, 0);
      const end = new Date(d); end.setHours(23, 59, 59, 999);
      return hk<HealthValue[]>((cb) =>
        AppleHealthKit.getActiveEnergyBurned({ startDate: start.toISOString(), endDate: end.toISOString() } as any, cb)
      );
    })
  );
  energyResults.forEach((samples, i) => {
    if (Array.isArray(samples) && samples.length) {
      const total = samples.reduce((s, r) => s + (Number(r.value) || 0), 0);
      if (total > 0) rows.push({ metric: 'active_energy', value: Math.round(total), unit: 'kcal', ts: noonUTC(localDateStr(dayStarts[i])) });
    }
  });

  if (!rows.length) return;
  try {
    await fetch(HEALTH_INGEST_URL, { method: 'POST', headers: authHeaders(), body: JSON.stringify(rows) });
  } catch {
    // offline — next app open retries
  }
}

export type HRVStatus = 'green' | 'yellow' | 'red' | 'unknown';

export interface HealthData {
  hrv: number | null;
  hrvStatus: HRVStatus;
  restingHR: number | null;
  sleepHours: number | null;
  sleepQuality: string | null;
  deepSleepHours: number | null;
  remSleepHours: number | null;
  sleepScore: number | null;
  steps: number | null;
  activeCalories: number | null;
  vo2Max: number | null;
  vo2MaxCategory: string | null;
  loading: boolean;
  error: string | null;
}

// Apple's VO2 max fitness classification for adult males (mL/kg/min).
// VO2 max updates only during outdoor workouts so we show the most recent
// reading rather than a daily value.
function getVo2Category(vo2: number): string {
  if (vo2 >= 55) return 'Very High';
  if (vo2 >= 48) return 'High';
  if (vo2 >= 42) return 'Above Average';
  if (vo2 >= 36) return 'Average';
  if (vo2 >= 30) return 'Below Average';
  return 'Low';
}

const PERMISSIONS: HealthKitPermissions = {
  permissions: {
    read: [
      AppleHealthKit.Constants.Permissions.HeartRateVariability,
      AppleHealthKit.Constants.Permissions.RestingHeartRate,
      AppleHealthKit.Constants.Permissions.SleepAnalysis,
      AppleHealthKit.Constants.Permissions.Steps,
      AppleHealthKit.Constants.Permissions.ActiveEnergyBurned,
      AppleHealthKit.Constants.Permissions.HeartRate,
      AppleHealthKit.Constants.Permissions.Vo2Max,
    ],
    write: [],
  },
};

function getHRVStatus(hrv: number | null): HRVStatus {
  if (hrv === null) return 'unknown';
  if (hrv >= 50) return 'green';
  if (hrv >= 35) return 'yellow';
  return 'red';
}

function getSleepQuality(hours: number | null): string | null {
  if (hours === null) return null;
  if (hours >= 7.5) return 'Good';
  if (hours >= 6) return 'Fair';
  return 'Poor';
}

// A source-agnostic sleep score (0–100) computed from the stage data HealthKit
// exposes — works whether the samples come from Eight Sleep, Apple Watch, etc.
// (HealthKit doesn't expose a device's own "score" like Eight Sleep's 86; only
// the underlying stages/durations are queryable, so we compute our own.)
// Weighting: 50% total duration (vs 8h target), 25% deep (vs 1.5h), 25% REM
// (vs 1.75h). If stages aren't reported, falls back to scoring on duration only.
function getSleepScore(
  totalHours: number | null,
  deepHours: number | null,
  remHours: number | null
): number | null {
  if (totalHours === null || totalHours <= 0) return null;
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const durationPart = clamp01(totalHours / 8);
  // Weight only the stages the source actually reports, then renormalize — so a
  // device that reports deep but not REM (or neither) isn't penalized 25% for
  // data it never recorded.
  const components: { value: number; weight: number }[] = [{ value: durationPart, weight: 0.5 }];
  if (deepHours !== null) components.push({ value: clamp01(deepHours / 1.5), weight: 0.25 });
  if (remHours !== null) components.push({ value: clamp01(remHours / 1.75), weight: 0.25 });
  const wsum = components.reduce((a, c) => a + c.weight, 0);
  const score = components.reduce((a, c) => a + c.value * (c.weight / wsum), 0);
  return Math.round(score * 100);
}

// Total hours covered by a set of time intervals, merging overlaps so two
// sources recording the same night (e.g. Eight Sleep + Apple Watch) don't
// double-count and inflate the total. Each sample needs startDate/endDate.
function mergedHours(samples: { startDate: string; endDate: string }[]): number {
  const spans = samples
    .map((s) => [new Date(s.startDate).getTime(), new Date(s.endDate).getTime()])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [a, b] of spans) {
    if (a > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else if (b > curEnd) {
      curEnd = b;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total / (1000 * 60 * 60);
}

function getStartOfDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function getYesterdayNight(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(18, 0, 0, 0); // 6pm yesterday to catch evening sleep start
  return d;
}

export function useHealthData(): HealthData & { refetch: () => void; lastFetched: Date | null } {
  const [data, setData] = useState<HealthData>({
    hrv: null,
    hrvStatus: 'unknown',
    restingHR: null,
    sleepHours: null,
    sleepQuality: null,
    deepSleepHours: null,
    remSleepHours: null,
    sleepScore: null,
    steps: null,
    activeCalories: null,
    vo2Max: null,
    vo2MaxCategory: null,
    loading: false,
    error: null,
  });
  // Separate state so the loading=true render is never batched away with the
  // loading=false update — HealthKit callbacks can fire fast enough that React 18
  // would otherwise batch both into a single render, making the spinner invisible.
  const [loading, setLoading] = useState(false);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    setData((prev) => ({ ...prev, error: null }));

    try {
      AppleHealthKit.initHealthKit(PERMISSIONS, (initErr) => {
        if (initErr) {
          setData((prev) => ({ ...prev, error: 'HealthKit unavailable — connect your Apple Watch on device' }));
          setLoading(false);
          return;
        }

      const today = getStartOfDay();
      const startDate = today.toISOString();
      const now = new Date().toISOString();

      let hrv: number | null = null;
      let restingHR: number | null = null;
      let sleepHours: number | null = null;
      let deepSleepHours: number | null = null;
      let remSleepHours: number | null = null;
      let steps: number | null = null;
      let activeCalories: number | null = null;
      let vo2Max: number | null = null;
      // Eight Sleep sleep score only — HRV and RHR on the Health card use Apple
      // Watch so you can see live intraday readings during the day. Recovery card
      // and all coaching logic still use Eight Sleep for overnight accuracy.
      let eightSleepScore: number | null = null;
      // Server-side sleep for nights HealthKit has nothing (no pod, watch not
      // worn to bed) — the /api/sleep/today fetch below returns Eight Sleep or,
      // failing that, the manual sleep check-in. Display fallback ONLY: never
      // pushed back via pushHealthData, so it can't loop into the spine.
      let serverSleepHours: number | null = null;
      let pending = 7;

      function checkDone() {
        pending -= 1;
        if (pending === 0) {
          const finalHrv = hrv;           // Apple Watch — live intraday reading
          const finalRhr = restingHR;     // Apple Watch — live intraday reading
          const finalSleepScore = eightSleepScore ?? getSleepScore(sleepHours, deepSleepHours, remSleepHours);
          const displaySleep = sleepHours ?? serverSleepHours;
          setData({
            hrv: finalHrv,
            hrvStatus: getHRVStatus(finalHrv),
            restingHR: finalRhr,
            sleepHours: displaySleep,
            sleepQuality: getSleepQuality(displaySleep),
            deepSleepHours,
            remSleepHours,
            sleepScore: finalSleepScore,
            steps,
            activeCalories,
            vo2Max,
            vo2MaxCategory: vo2Max !== null ? getVo2Category(vo2Max) : null,
            loading: false,
            error: null,
          });
          setLoading(false);
          setLastFetched(new Date());

          // Persist these readings so they accumulate as history. Sleep stages +
          // score post only when present, so a watch without stage data doesn't
          // write nulls (pushHealthData drops non-finite values anyway).
          pushHealthData([
            { metric: 'hrv', value: hrv as number, unit: 'ms' },
            { metric: 'resting_hr', value: restingHR as number, unit: 'bpm' },
            { metric: 'sleep_hours', value: sleepHours as number, unit: 'hours' },
            { metric: 'deep_sleep_hours', value: deepSleepHours as number, unit: 'hours' },
            { metric: 'rem_sleep_hours', value: remSleepHours as number, unit: 'hours' },
            { metric: 'sleep_score', value: finalSleepScore as number, unit: 'score' },
            { metric: 'steps', value: steps as number, unit: 'count' },
            { metric: 'active_energy', value: activeCalories as number, unit: 'kcal' },
            // vo2_max is pushed above with actual workout timestamps for trend history
          ]);
        }
      }

      // HRV — live Apple Watch reading, shown on the Health card as informational
      // device data. NOTE: the recovery SCORE does not use this; recovery is
      // source-locked to your manually-entered Eight Sleep overnight numbers
      // (see recovery.js) so the baseline comparison stays night-vs-night.
      AppleHealthKit.getHeartRateVariabilitySamples(
        { unit: 'millisecond', startDate, endDate: now } as any,
        (err, results: HealthValue[]) => {
          if (!err && results && results.length > 0) {
            const avg = results.reduce((sum, r) => sum + r.value, 0) / results.length;
            // Values come back in seconds regardless of unit option — convert to ms
            hrv = Math.round(avg * 1000);
          }
          checkDone();
        }
      );

      // Resting heart rate — returns array, pick most recent
      AppleHealthKit.getRestingHeartRate(
        { startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), endDate: now },
        (err, results: HealthValue | HealthValue[]) => {
          if (!err && results) {
            if (Array.isArray(results) && results.length > 0) {
              const sorted = [...results].sort(
                (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
              );
              restingHR = Math.round(sorted[0].value);
            } else if (!Array.isArray(results) && (results as HealthValue).value) {
              restingHR = Math.round((results as HealthValue).value);
            }
          }
          checkDone();
        }
      );

      // Sleep analysis — total asleep time plus Deep/REM breakdown from last
      // night's stages (works with Eight Sleep, Apple Watch, etc. — whatever
      // wrote the samples into HealthKit).
      AppleHealthKit.getSleepSamples(
        {
          startDate: getYesterdayNight().toISOString(),
          endDate: now,
        },
        (err, results: HealthValue[]) => {
          if (!err && results && results.length > 0) {
            const isStage = (v: string, ...names: string[]) =>
              names.some((n) => v === n || v === `ASLEEP${n}` || v === `SLEEP_${n}`);
            // Any genuine asleep stage (exclude INBED / AWAKE) for the total.
            const asleep = results.filter(
              (s: any) => ['ASLEEP', 'DEEP', 'CORE', 'REM', 'ASLEEPDEEP', 'ASLEEPCORE', 'ASLEEPREM'].includes(s.value)
            );
            if (asleep.length > 0) {
              const round1 = (h: number) => Math.round(h * 10) / 10;
              // Merge overlapping intervals so multiple sources don't double-count.
              sleepHours = round1(mergedHours(asleep as any));
              const deep = asleep.filter((s: any) => isStage(s.value, 'DEEP'));
              const rem = asleep.filter((s: any) => isStage(s.value, 'REM'));
              // Only set stage totals if the source actually reports them.
              if (deep.length) deepSleepHours = round1(mergedHours(deep as any));
              if (rem.length) remSleepHours = round1(mergedHours(rem as any));
            }
          }
          checkDone();
        }
      );

      // Steps today
      AppleHealthKit.getStepCount(
        { date: startDate },
        (err, result: HealthValue) => {
          if (!err && result) {
            steps = Math.round(result.value);
          }
          checkDone();
        }
      );

      // Active calories today
      AppleHealthKit.getActiveEnergyBurned(
        { startDate, endDate: now },
        (err, results: HealthValue[]) => {
          if (!err && results && results.length > 0) {
            activeCalories = Math.round(
              results.reduce((sum, r) => sum + r.value, 0)
            );
          }
          checkDone();
        }
      );

      // VO2 max — only updated during outdoor workouts, so query last 90 days.
      // Push ALL readings with their actual workout dates so the trend chart
      // has real historical data (not just today's re-push of the latest value).
      AppleHealthKit.getVo2MaxSamples(
        { startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), endDate: now } as any,
        (err, results: HealthValue[]) => {
          if (!err && results && results.length > 0) {
            const sorted = [...results].sort(
              (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
            );
            vo2Max = Math.round(sorted[0].value * 10) / 10;
            pushHealthData(
              sorted.map(r => ({
                metric: 'vo2_max',
                value: Math.round(r.value * 10) / 10,
                unit: 'mL/kg/min',
                ts: r.startDate,
              }))
            );
          }
          checkDone();
        }
      );

      // Fetch Eight Sleep sleep score for the nightly summary row (server falls
      // back to the manual sleep check-in when the pod wasn't slept on). HRV and
      // RHR intentionally NOT overridden here — they come from Apple Watch above.
      fetchWithTimeout(SLEEP_TODAY_URL, { headers: authHeaders() }, 6000)
        .then((r) => r.json())
        .then((d: any) => {
          if (d?.metrics?.sleep_score) eightSleepScore = Math.round(d.metrics.sleep_score);
          if (Number.isFinite(d?.metrics?.sleep_hours)) serverSleepHours = d.metrics.sleep_hours;
        })
        .catch(() => {})
        .finally(() => checkDone());

      // Finalize the last 30 days of COMPLETE daily step/energy totals so past
      // days aren't stuck at the partial count from whenever the app was last
      // opened — 30 days covers both the recent AND prior trend windows so the
      // "down X%" comparison is apples-to-apples. Fire-and-forget.
      finalizeRecentCumulativeDays(30).catch(() => {});
      });
    } catch (e) {
      setData((prev) => ({ ...prev, error: 'HealthKit unavailable on this device' }));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { ...data, loading, refetch: fetchData, lastFetched };
}
