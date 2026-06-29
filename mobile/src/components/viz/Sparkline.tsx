import React from 'react';
import { Canvas, Path, Skia, LinearGradient, vec } from '@shopify/react-native-skia';

interface Props { values: number[]; width: number; height: number; color?: string; }

export function Sparkline({ values, width, height, color = '#5A52F0' }: Props) {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const dx = width / (values.length - 1);
  const y = (v: number) => height - 6 - ((v - min) / span) * (height - 12);

  const line = Skia.Path.Make();
  line.moveTo(0, y(values[0]));
  values.forEach((v, i) => line.lineTo(i * dx, y(v)));

  const area = line.copy();
  area.lineTo(width, height);
  area.lineTo(0, height);
  area.close();

  return (
    <Canvas style={{ width, height }}>
      <Path path={area}>
        <LinearGradient start={vec(0, 0)} end={vec(0, height)} colors={[color + '55', color + '00']} />
      </Path>
      <Path path={line} style="stroke" strokeWidth={2.5} strokeCap="round" color={color} />
    </Canvas>
  );
}
