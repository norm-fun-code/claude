import { useState, useEffect, useCallback } from 'react';
import AppleHealthKit, {
  HealthKitPermissions,
  HealthValue,
} from 'react-native-health';
import { HEALTH_INGEST_URL } from '../config';

// Persist on-device HealthKit readings to the NormOS spine. Canonical metric
// names match backend/src/ingest/health.js. Fire-and-forget: never block the UI.
async function pushHealthData(rows: { metric: string; value: number; unit: string }[]) {
  const payload = rows.filter((r) => r.value != null && Number.isFinite(r.value));
  if (payload.length === 0) return;
  try {
    await fetch(HEALTH_INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  if (hrv >= 30) return 'yellow';
  return 'red';
}

function getSleepQuality(hours: number | null): string | null {
  if (hours === null) return null;
  if (hours >= 7.5) return 'Good';
  if (hours >= 6) return 'Fair';
  return 'Poor';
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
      let steps: number | null = null;
      let activeCalories: number | null = null;
      let pending = 5;

      function checkDone() {
        pending -= 1;
        if (pending === 0) {
          setData({
            hrv,
            hrvStatus: getHRVStatus(hrv),
            restingHR,
            sleepHours,
            sleepQuality: getSleepQuality(sleepHours),
            steps,
            activeCalories,
            loading: false,
            error: null,
          });

          // Persist these readings so they accumulate as history.
          pushHealthData([
            { metric: 'hrv', value: hrv as number, unit: 'ms' },
            { metric: 'resting_hr', value: restingHR as number, unit: 'bpm' },
            { metric: 'sleep_hours', value: sleepHours as number, unit: 'hours' },
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

      // Sleep analysis — sum asleep minutes from last night
      AppleHealthKit.getSleepSamples(
        {
          startDate: getYesterdayNight().toISOString(),
          endDate: now,
        },
        (err, results: HealthValue[]) => {
          if (!err && results && results.length > 0) {
            // Filter to actual sleep stages (not INBED)
            const asleepSamples = results.filter(
              (s: any) => s.value === 'ASLEEP' || s.value === 'DEEP' || s.value === 'CORE' || s.value === 'REM'
            );
            if (asleepSamples.length > 0) {
              const totalMs = asleepSamples.reduce((sum, s) => {
                const start = new Date(s.startDate).getTime();
                const end = new Date(s.endDate).getTime();
                return sum + Math.max(0, end - start);
              }, 0);
              sleepHours = Math.round((totalMs / (1000 * 60 * 60)) * 10) / 10;
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
