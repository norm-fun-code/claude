import React, { useEffect } from 'react';
import { View, StyleSheet, DimensionValue } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing } from 'react-native-reanimated';
import { getColors, spacing, radius, shadow } from '../../theme';

// A gently pulsing placeholder block. Rendered while async content loads so the
// layout is reserved up-front — nothing pops in or reflows (which is also what
// made the feed feel "jumpy" on open).
export function Skeleton({ width = '100%', height = 14, r = 7, style }: {
  width?: DimensionValue; height?: number; r?: number; style?: any;
}) {
  const o = useSharedValue(0.45);
  useEffect(() => {
    o.value = withRepeat(withTiming(0.9, { duration: 850, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, []);
  const anim = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <Animated.View
      style={[{ width, height, borderRadius: r, backgroundColor: 'rgba(120,120,135,0.16)' }, anim, style]}
    />
  );
}

// A skeleton shaped like a standard card (title line + a few body rows).
export function SkeletonCard({ rows = 3, isDark = false, tall = false }: { rows?: number; isDark?: boolean; tall?: boolean }) {
  const c = getColors(isDark);
  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <Skeleton width={120} height={11} r={5} style={{ marginBottom: spacing.md }} />
      {tall && <Skeleton width={'70%'} height={22} r={8} style={{ marginBottom: spacing.md }} />}
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton
          key={i}
          width={i === rows - 1 ? '55%' : '100%'}
          height={13}
          style={{ marginBottom: spacing.sm }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
});
