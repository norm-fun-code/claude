import React from 'react';
import { FullScreenSheet } from './FullScreenSheet';
import { WorkoutsPanel } from './WorkoutsPanel';

interface Props {
  visible: boolean;
  onClose: () => void;
  hrv: number | null;
  isDark: boolean;
  recoveryBand: 'green' | 'yellow' | 'red' | null;
  recoveryScore: number | null;
}

/**
 * Health tab redesign (audit rec #4) — the Training drill-in. Hosts the
 * EXISTING detailed workout UI (WorkoutsPanel: weekly schedule, warm-up,
 * working sets, set entry, exercise/workout completion, swap/override,
 * activity logging, progression) completely unchanged — this screen is pure
 * navigation, not a rewrite of the workout engine. WorkoutsPanel keeps its
 * own persistence/hydration exactly as it already worked on the old Health
 * landing page; only WHERE it renders moved, not what it does or how it
 * reads/writes state.
 */
export function TrainingScreen({ visible, onClose, hrv, isDark, recoveryBand, recoveryScore }: Props) {
  return (
    <FullScreenSheet visible={visible} title="Training" onClose={onClose}>
      <WorkoutsPanel hrv={hrv} isDark={isDark} recoveryBand={recoveryBand} recoveryScore={recoveryScore} />
    </FullScreenSheet>
  );
}
