import React from 'react';
import { FullScreenSheet } from './FullScreenSheet';
import { RecoveryCard } from './RecoveryCard';
import { ForecastCard } from './ForecastCard';
import { TodayForecastCard } from './TodayForecastCard';
import { CheckinHistoryCard } from './CheckinHistoryCard';
import type { Recovery, HealthComposite, TodayForecast, Forecast, Insight } from '../hooks/useBriefing';

interface Props {
  visible: boolean;
  onClose: () => void;
  recovery: Recovery | null | undefined;
  composites: HealthComposite[];
  recoveryBuiltAt?: string;
  todayForecast: TodayForecast | null | undefined;
  forecasts: Forecast[];
  checkinHistoryInsights: Insight[];
}

/**
 * Health tab redesign (audit rec #4) — Health history drill-in: historical
 * recovery and the forward-looking forecast content the landing page
 * doesn't carry (it duplicated Today's synthesis of the same recovery
 * band/score). HealthCard (HRV/RHR/sleep/steps/VO2) has since graduated to
 * the Health landing page itself, right under the recovery hero — it's no
 * longer duplicated here.
 */
export function HealthHistoryScreen({
  visible, onClose, recovery, composites, recoveryBuiltAt,
  todayForecast, forecasts, checkinHistoryInsights,
}: Props) {
  return (
    <FullScreenSheet visible={visible} title="Health history" onClose={onClose}>
      <RecoveryCard recovery={recovery} composites={composites} builtAt={recoveryBuiltAt} />
      <TodayForecastCard forecast={todayForecast} />
      <ForecastCard forecasts={forecasts} />
      <CheckinHistoryCard insights={checkinHistoryInsights} />
    </FullScreenSheet>
  );
}
