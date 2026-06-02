import { useState, useEffect, useCallback } from 'react';
import AppleHealthKit, {
  HealthKitPermissions,
  HealthValue,
} from 'react-native-health';
import { HEALTH_INGEST_URL, authHeaders } from '../config';

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
  loading: boolean;
  error: string | null;
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

export function useHealthData(): HealthData & { refetch: () => void } {
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
    loading: false,
    error: null,
  });

  const fetchData = useCallback(() => {
    setData((prev) => ({ ...prev, loading: true, error: null }));

    try {
      AppleHealthKit.initHealthKit(PERMISSIONS, (initErr) => {
        if (initErr) {
          setData((prev) => ({
            ...prev,
            loading: false,
            error: 'HealthKit unavailable — connect your Apple Watch on device',
          }));
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
      let pending = 5;

      function checkDone() {
        pending -= 1;
        if (pending === 0) {
          const sleepScore = getSleepScore(sleepHours, deepSleepHours, remSleepHours);
          setData({
            hrv,
            hrvStatus: getHRVStatus(hrv),
            restingHR,
            sleepHours,
            sleepQuality: getSleepQuality(sleepHours),
            deepSleepHours,
            remSleepHours,
            sleepScore,
            steps,
            activeCalories,
            loading: false,
            error: null,
          });

          // Persist these readings so they accumulate as history. Sleep stages +
          // score post only when present, so a watch without stage data doesn't
          // write nulls (pushHealthData drops non-finite values anyway).
          pushHealthData([
            { metric: 'hrv', value: hrv as number, unit: 'ms' },
            { metric: 'resting_hr', value: restingHR as number, unit: 'bpm' },
            { metric: 'sleep_hours', value: sleepHours as number, unit: 'hours' },
            { metric: 'deep_sleep_hours', value: deepSleepHours as number, unit: 'hours' },
            { metric: 'rem_sleep_hours', value: remSleepHours as number, unit: 'hours' },
            { metric: 'sleep_score', value: sleepScore as number, unit: 'score' },
            { metric: 'steps', value: steps as number, unit: 'count' },
            { metric: 'active_energy', value: activeCalories as number, unit: 'kcal' },
          ]);
        }
      }

      // HRV — daily average of today's samples (matches what Apple shows in Health app)
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
      });
    } catch (e) {
      setData((prev) => ({
        ...prev,
        loading: false,
        error: 'HealthKit unavailable on this device',
      }));
    }
  }, []);

  // No auto-fetch on mount — only refreshes on pull-to-refresh
  return { ...data, refetch: fetchData };
}
