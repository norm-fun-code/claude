import React from 'react';
import { Canvas, Path, Skia, SweepGradient, vec } from '@shopify/react-native-skia';
import { bandGradient } from '../../theme';

interface Props { score: number; band?: string | null; size: number; stroke?: number; }

export function ProgressArc({ score, band, size, stroke = 7 }: Props) {
  const r = (size - stroke) / 2;
  const cx = size / 2, cy = size / 2;
  const sweep = Math.max(0, Math.min(1, score / 100)) * 359.9;
  const colors = bandGradient[band || 'neutral'] || bandGradient.neutral;
  const rect = { x: stroke / 2, y: stroke / 2, width: 2 * r, height: 2 * r };

  const track = Skia.Path.Make();
  track.addArc(rect, -90, 360);
  const arc = Skia.Path.Make();
  arc.addArc(rect, -90, sweep);

  return (
    <Canvas style={{ width: size, height: size }}>
      <Path path={track} style="stroke" strokeWidth={stroke} color="rgba(0,0,0,0.06)" strokeCap="round" />
      <Path path={arc} style="stroke" strokeWidth={stroke} strokeCap="round">
        <SweepGradient c={vec(cx, cy)} colors={colors} />
      </Path>
    </Canvas>
  );
}
