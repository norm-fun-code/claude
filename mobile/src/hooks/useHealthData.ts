import { useState, useEffect, useCallback } from 'react';
import AppleHealthKit, {
  HealthKitPermissions,
  HealthValue,
} from 'react-native-health';

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
    loading: true,
    error: null,
  });

  const fetchData = useCallback(() => {
    setData((prev) => ({ ...prev, loading: true, error: null }));

    AppleHealthKit.initHealthKit(PERMISSIONS, (initErr) => {
      if (initErr) {
        setData((prev) => ({
          ...prev,
          loading: false,
          error: 'HealthKit permission denied or unavailable',
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
        }
      }

      // HRV — most recent sample
      AppleHealthKit.getHeartRateVariabilitySamples(
        { startDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), endDate: now },
        (err, results: HealthValue[]) => {
          if (!err && results && results.length > 0) {
            const sorted = [...results].sort(
              (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
            );
            hrv = Math.round(sorted[0].value);
          }
          checkDone();
        }
      );

      // Resting heart rate
      AppleHealthKit.getRestingHeartRate(
        { date: now },
        (err, result: HealthValue) => {
          if (!err && result) {
            restingHR = Math.round(result.value);
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
            // Filter to "asleep" stages (value === 3 is ASLEEP in HK)
            const asleepSamples = results.filter(
              (s) => s.value === 3 || s.value === 4 || s.value === 5
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
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { ...data, refetch: fetchData };
}
