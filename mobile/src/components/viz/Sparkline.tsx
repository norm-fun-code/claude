import React, { useEffect } from 'react';
import { Canvas, Path, Skia, LinearGradient, vec } from '@shopify/react-native-skia';
import { useSharedValue, withTiming, Easing } from 'react-native-reanimated';

interface Props { values: number[]; width: number; height: number; color?: string; }

export function Sparkline({ values, width, height, color = '#5A52F0' }: Props) {
  // Draw-on: the line traces in (end 0→1) while the gradient fill fades up, so the
  // chart feels alive on appear instead of snapping in.
  const end = useSharedValue(0);
  const fill = useSharedValue(0);
  useEffect(() => {
    end.value = 0;
    fill.value = 0;
    end.value = withTiming(1, { duration: 480, easing: Easing.out(Easing.cubic) });
    fill.value = withTiming(1, { duration: 560, easing: Easing.out(Easing.cubic) });
  }, [values, width]);

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
      <Path path={area} opacity={fill}>
        <LinearGradient start={vec(0, 0)} end={vec(0, height)} colors={[color + '55', color + '00']} />
      </Path>
      <Path path={line} style="stroke" strokeWidth={2.5} strokeCap="round" strokeJoin="round" color={color} start={0} end={end} />
    </Canvas>
  );
}
