import React from 'react';
import { View } from 'react-native';

interface Props {
  values: number[];
  height?: number;
  /** Bar color. The most recent bar is drawn at full color; the rest are tinted. */
  color?: string;
  /** Per-index color override (e.g. recovery band coloring). Wins over `color`. */
  colorFor?: (i: number, v: number) => string | undefined;
  /** Cap how many trailing points to show (keeps bars readable on long windows). */
  max?: number;
  gap?: number;
  /** Emphasize the final bar as "current". Only truthful when the last point is
   *  reliably today — off by default so a stale/partial last reading isn't
   *  asserted as the current value next to a live number. */
  highlightLast?: boolean;
}

// A compact bar sparkline built from plain RN views (no native chart dep) — the
// same rendering approach as the metric detail sheet, so it's OTA-shippable today.
// Scales to the data's own min→max so the SHAPE of the trend reads clearly.
export function MiniBars({ values, height = 34, color = '#635BFF', colorFor, max = 40, gap = 2, highlightLast = false }: Props) {
  const data = (values || []).filter((v) => Number.isFinite(v)).slice(-max);
  if (data.length < 2) return null;

  const lo = Math.min(...data);
  const hi = Math.max(...data);
  const span = hi - lo || 1;
  const MIN_FRAC = 0.12; // floor so the lowest bar is still visible

  return (
    <View style={{ height, flexDirection: 'row', alignItems: 'flex-end', gap }}>
      {data.map((v, i) => {
        const frac = MIN_FRAC + ((v - lo) / span) * (1 - MIN_FRAC);
        const isLast = i === data.length - 1;
        const c = colorFor?.(i, v) || color;
        return (
          <View
            key={i}
            style={{
              flex: 1,
              height: Math.max(2, frac * height),
              backgroundColor: c,
              opacity: highlightLast ? (isLast ? 1 : 0.32) : 0.8,
              borderRadius: 2,
            }}
          />
        );
      })}
    </View>
  );
}
