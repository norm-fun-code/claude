import React from 'react';
import { FullScreenSheet } from './FullScreenSheet';
import { HealthCard } from './HealthCard';
import { RecoveryCard } from './RecoveryCard';
import { ForecastCard } from './ForecastCard';
import { TodayForecastCard } from './TodayForecastCard';
import { CheckinHistoryCard } from './CheckinHistoryCard';
import type { Recovery, HealthComposite, TodayForecast, Forecast, Insight } from '../hooks/useBriefing';
import type { HealthData } from '../hooks/useHealthData';

interface Props {
  visible: boolean;
  onClose: () => void;
  recovery: Recovery | null | undefined;
  composites: HealthComposite[];
  recoveryBuiltAt?: string;
  health: HealthData;
  canonicalVo2: { value: number; asOf?: string | null } | null;
  todayForecast: TodayForecast | null | undefined;
  forecasts: Forecast[];
  checkinHistoryInsights: Insight[];
}

/**
 * Health tab redesign (audit rec #4) — Health history drill-in: health
 * metrics + trends, source freshness, historical recovery, and the
 * forward-looking forecast content the landing page no longer carries (it
 * duplicated Today's synthesis of the same recovery band/score). Every card
 * here is REUSED unchanged from the old Health landing page — only its
 * location moved, per the redesign's "move specialist depth out of the daily
 * landing page, never delete it" requirement.
 */
export function HealthHistoryScreen({
  visible, onClose, recovery, composites, recoveryBuiltAt, health, canonicalVo2,
  todayForecast, forecasts, checkinHistoryInsights,
}: Props) {
  return (
    <FullScreenSheet visible={visible} title="Health history" onClose={onClose}>
      <RecoveryCard recovery={recovery} composites={composites} builtAt={recoveryBuiltAt} />
      <HealthCard health={health} canonicalVo2={canonicalVo2} />
      <TodayForecastCard forecast={todayForecast} />
      <ForecastCard forecasts={forecasts} />
      <CheckinHistoryCard insights={checkinHistoryInsights} />
    </FullScreenSheet>
  );
}
