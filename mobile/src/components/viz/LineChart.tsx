import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, PanResponder, useColorScheme } from 'react-native';
import { Canvas, Path, Skia, LinearGradient, vec, Circle, Line } from '@shopify/react-native-skia';
import { useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { getColors, radius, shadow } from '../../theme';

export interface LineSeries {
  values: (number | null)[]; // one entry per day-slot, null = no reading that day
  color: string;
  fill?: boolean;            // gradient area under the line (single-series only)
  label?: string;            // shown in the tap tooltip (e.g. "Apple Watch")
}

export interface ContextTag { label: string; emoji: string }

// A Skia line chart for the metric detail sheet: 1–2 series on a shared scale,
// traced in on appear. Nulls are bridged (the line spans available readings), so
// a sparse source (e.g. Apple Watch only on recent days) draws over its own range.
//
// Tap-and-drag scrubs a vertical guide across the chart: it snaps to the nearest
// day, marks each series' value there, and pops a tooltip with the readings plus
// any context tags logged that night (magnesium, alcohol, …) — so a plunge two
// weeks ago can be read together with what was different about that day.
export function LineChart({
  series,
  height = 88,
  dates,
  unit,
  formatValue = (v: number) => `${Math.round(v)}`,
  contextByDay,
}: {
  series: LineSeries[];
  height?: number;
  dates?: string[];               // YYYY-MM-DD aligned to each value index
  unit?: string;
  formatValue?: (v: number) => string;
  contextByDay?: Record<string, ContextTag[]>;
}) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [w, setW] = useState(0);
  const [sel, setSel] = useState<number | null>(null);
  const lastSel = useRef<number | null>(null);
  const end = useSharedValue(0);

  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null && Number.isFinite(v));
  const n = series.reduce((m, s) => Math.max(m, s.values.length), 0);
  const sig = `${w}:${series.map((s) => s.values.join(',')).join('|')}`;
  useEffect(() => {
    end.value = 0;
    end.value = withTiming(1, { duration: 520, easing: Easing.out(Easing.cubic) });
    setSel(null);          // new data / period change clears the scrubber
    lastSel.current = null;
  }, [sig]);

  const PAD = 8;
  const min = all.length ? Math.min(...all) : 0;
  const max = all.length ? Math.max(...all) : 1;
  const span = max - min || 1;
  const x = (i: number) => (i / (n - 1)) * w;
  const y = (v: number) => height - PAD - ((v - min) / span) * (height - PAD * 2);

  // Scrub: map a touch x to the nearest day index, with a haptic tick on change.
  function pick(locX: number) {
    if (w < 2 || n < 2) return;
    const i = Math.max(0, Math.min(n - 1, Math.round((locX / w) * (n - 1))));
    if (i !== lastSel.current) {
      lastSel.current = i;
      Haptics.selectionAsync();
      setSel(i);
    }
  }
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => pick(e.nativeEvent.locationX),
    onPanResponderMove: (e) => pick(e.nativeEvent.locationX),
  }), [w, n]);

  const onLayout = (e: any) => setW(Math.round(e.nativeEvent.layout.width));
  if (all.length < 2 || w < 2 || n < 2) return <View style={{ height, width: '100%' }} onLayout={onLayout} />;

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

  // Selected-day marker data for the tooltip + dots.
  const selX = sel != null ? x(sel) : 0;
  const selPoints = sel != null
    ? series.map((s) => ({ v: s.values[sel], color: s.color, label: s.label }))
    : [];
  const selDay = sel != null && dates ? dates[sel] : undefined;
  const selTags = selDay && contextByDay ? contextByDay[selDay] : undefined;

  const TIP_W = 168;
  const tipLeft = Math.max(0, Math.min(w - TIP_W, selX - TIP_W / 2));

  return (
    <View style={{ width: '100%' }}>
      {/* Tooltip floats above the chart (won't clip — parent has no overflow:hidden). */}
      {sel != null && (
        <View style={[styles.tip, { width: TIP_W, left: tipLeft, backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
          {selDay && <Text style={[styles.tipDate, { color: c.subtext }]}>{fmtDay(selDay)}</Text>}
          {selPoints.map((p, i) => (
            <View key={i} style={styles.tipRow}>
              {series.length > 1 && <View style={[styles.tipDot, { backgroundColor: p.color }]} />}
              {p.label && <Text style={[styles.tipLabel, { color: c.subtext }]} numberOfLines={1}>{p.label}</Text>}
              <Text style={[styles.tipVal, { color: c.text }]}>
                {p.v != null && Number.isFinite(p.v) ? `${formatValue(p.v)}${unit ? ` ${unit}` : ''}` : '—'}
              </Text>
            </View>
          ))}
          <View style={[styles.tipDivider, { backgroundColor: c.border }]} />
          {selTags && selTags.length ? (
            <View style={styles.tipChips}>
              {selTags.map((t) => (
                <View key={t.label} style={[styles.tipChip, { backgroundColor: c.accentSoft }]}>
                  <Text style={styles.tipChipEmoji}>{t.emoji}</Text>
                  <Text style={[styles.tipChipTxt, { color: c.accent }]} numberOfLines={1}>{t.label}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={[styles.tipNoCtx, { color: c.subtext }]}>No context logged</Text>
          )}
        </View>
      )}

      <View style={{ height, width: '100%' }} onLayout={onLayout} {...pan.panHandlers}>
        <Canvas style={{ width: w, height }}>
          {series.map((s, si) => {
            const line = buildLine(s.values);
            if (!line) return null;
            let area = null;
            if (s.fill) {
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

          {/* Scrubber: vertical guide + a marker on each series at the selected day. */}
          {sel != null && (
            <>
              <Line p1={vec(selX, 0)} p2={vec(selX, height)} color={c.border} strokeWidth={1} />
              {selPoints.map((p, i) =>
                p.v != null && Number.isFinite(p.v) ? (
                  <React.Fragment key={i}>
                    <Circle cx={selX} cy={y(p.v)} r={5} color={isDark ? '#000' : '#fff'} />
                    <Circle cx={selX} cy={y(p.v)} r={3.5} color={p.color} />
                  </React.Fragment>
                ) : null
              )}
            </>
          )}
        </Canvas>
      </View>
    </View>
  );
}

function fmtDay(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

const styles = StyleSheet.create({
  tip: {
    position: 'absolute',
    bottom: '100%',
    marginBottom: 6,
    zIndex: 20,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  tipDate: { fontSize: 11, fontWeight: '600', marginBottom: 4 },
  tipRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  tipDot: { width: 7, height: 7, borderRadius: 3.5 },
  tipLabel: { fontSize: 11, flex: 1 },
  tipVal: { fontSize: 13, fontWeight: '700', marginLeft: 'auto' },
  tipDivider: { height: 1, marginVertical: 6, opacity: 0.7 },
  tipChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  tipChip: { flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: radius.pill, paddingVertical: 2, paddingHorizontal: 6 },
  tipChipEmoji: { fontSize: 10 },
  tipChipTxt: { fontSize: 10, fontWeight: '600' },
  tipNoCtx: { fontSize: 10, fontStyle: 'italic' },
});
