import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, shadow } from '../theme';

export type TabKey = 'today' | 'health' | 'wealth' | 'wisdom';

export const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'today', label: 'Today', icon: '☀' },
  { key: 'health', label: 'Health', icon: '❤' },
  { key: 'wealth', label: 'Wealth', icon: '$' },
  { key: 'wisdom', label: 'Wisdom', icon: '🧠' },
];

interface Props {
  active: TabKey;
  onChange: (key: TabKey) => void;
  bottomInset?: number;
}

function TabItem({
  t, on, onPress, c,
}: {
  t: typeof TABS[number];
  on: boolean;
  onPress: () => void;
  c: ReturnType<typeof getColors>;
}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  useEffect(() => {
    if (on) {
      scale.value = withSpring(1.12, { damping: 8, stiffness: 300 }, () => {
        scale.value = withSpring(1, { damping: 14, stiffness: 300 });
      });
    }
  }, [on]);

  return (
    <TouchableOpacity
      style={styles.tab}
      activeOpacity={0.7}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <Animated.View style={[styles.pill, on && { backgroundColor: c.accentSoft }, animStyle]}>
        <Text style={[styles.icon, { color: on ? c.accent : c.subtext }]}>{t.icon}</Text>
      </Animated.View>
      <Text style={[styles.label, { color: on ? c.accent : c.subtext }, on && styles.labelOn]}>
        {t.label}
      </Text>
    </TouchableOpacity>
  );
}

export function TabBar({ active, onChange, bottomInset = 0 }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const handleChange = (key: TabKey) => {
    if (key !== active) {
      Haptics.selectionAsync();
      onChange(key);
    }
  };

  return (
    <View style={[styles.wrap, { backgroundColor: c.card, paddingBottom: bottomInset || spacing.sm }, shadow(isDark, 'bar')]}>
      {TABS.map((t) => (
        <TabItem
          key={t.key}
          t={t}
          on={t.key === active}
          onPress={() => handleChange(t.key)}
          c={c}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  pill: {
    width: 52,
    height: 30,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 18,
    fontWeight: '600',
  },
  label: {
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
  labelOn: {
    fontWeight: '700',
  },
});
