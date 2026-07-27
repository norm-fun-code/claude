import React from 'react';
import { FullScreenSheet } from './FullScreenSheet';
import { ExperimentsCard } from './ExperimentsCard';
import { BeliefsCard } from './BeliefsCard';

interface Props {
  visible: boolean;
  onClose: () => void;
}

/**
 * Health tab redesign (audit rec #4) — Patterns & experiments drill-in:
 * confirmed personal patterns / active+completed experiments / hypotheses
 * (ExperimentsCard, unchanged — already shows evidence tier, sample size,
 * dates, confidence via its verdict/effect-size rendering) plus "What NormOS
 * currently believes" (new BeliefsCard), replacing the old NormOS Profile
 * prose as the primary place this durable knowledge lives.
 */
export function PatternsExperimentsScreen({ visible, onClose }: Props) {
  return (
    <FullScreenSheet visible={visible} title="Patterns & experiments" onClose={onClose}>
      <BeliefsCard />
      <ExperimentsCard />
    </FullScreenSheet>
  );
}
