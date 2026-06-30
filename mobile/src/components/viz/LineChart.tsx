import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Canvas, Path, Skia, LinearGradient, vec } from '@shopify/react-native-skia';
import { useSharedValue, withTiming, Easing } from 'react-native-reanimated';

export interface LineSeries {
  values: (number | null)[]; // one entry per day-slot, null = no reading that day
  color: string;
  fill?: boolean;            // gradient area under the line (single-series only)
}

// A Skia line chart for the metric detail sheet: 1–2 series on a shared scale,
// traced in on appear. Nulls are bridged (the line spans available readings), so
// a sparse source (e.g. Apple Watch only on recent days) draws over its own range.
export function LineChart({ series, height = 88 }: { series: LineSeries[]; height?: number }) {
  const [w, setW] = useState(0);
  const end = useSharedValue(0);

  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null && Number.isFinite(v));
  const n = series.reduce((m, s) => Math.max(m, s.values.length), 0);
  const sig = `${w}:${series.map((s) => s.values.join(',')).join('|')}`;
  useEffect(() => {
    end.value = 0;
    end.value = withTiming(1, { duration: 520, easing: Easing.out(Easing.cubic) });
  }, [sig]);

  const onLayout = (e: any) => setW(Math.round(e.nativeEvent.layout.width));
  if (all.length < 2 || w < 2 || n < 2) return <View style={{ height, width: '100%' }} onLayout={onLayout} />;

  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const PAD = 8;
  const x = (i: number) => (i / (n - 1)) * w;
  const y = (v: number) => height - PAD - ((v - min) / span) * (height - PAD * 2);

  const buildLine = (values: (number | null)[]) => {
    const p = Skia.Path.Make();
    let started = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null || !Number.isFinite(v)) continue;
      const px = x(i), py = y(v);
      if (!started) { p.moveTo(px, py); started = true; } else { p.lineTo(px, py); }
    }
    return started ? p : null;
  };

  return (
    <View style={{ height, width: '100%' }} onLayout={onLayout}>
      <Canvas style={{ width: w, height }}>
        {series.map((s, si) => {
          const line = buildLine(s.values);
          if (!line) return null;
          let area = null;
          if (s.fill) {
            // First/last drawn x for the fill base.
            const idxs = s.values.map((v, i) => (v != null && Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
            area = line.copy();
            area.lineTo(x(idxs[idxs.length - 1]), height);
            area.lineTo(x(idxs[0]), height);
            area.close();
          }
          return (
            <React.Fragment key={si}>
              {area && (
                <Path path={area} opacity={end}>
                  <LinearGradient start={vec(0, 0)} end={vec(0, height)} colors={[s.color + '44', s.color + '00']} />
                </Path>
              )}
              <Path path={line} style="stroke" strokeWidth={2.5} strokeCap="round" strokeJoin="round" color={s.color} start={0} end={end} />
            </React.Fragment>
          );
        })}
      </Canvas>
    </View>
  );
}
