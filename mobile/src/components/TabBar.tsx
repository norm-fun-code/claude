import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, shadow } from '../theme';

export type TabKey = 'today' | 'health' | 'wealth' | 'wisdom' | 'ask';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// Outline when inactive, filled when active — the standard premium tab pattern,
// replacing the emoji set with a cohesive line-icon system.
export const TABS: { key: TabKey; label: string; icon: IoniconName; iconActive: IoniconName }[] = [
  { key: 'today',  label: 'Today',  icon: 'sunny-outline',    iconActive: 'sunny' },
  { key: 'health', label: 'Health', icon: 'heart-outline',    iconActive: 'heart' },
  { key: 'wealth', label: 'Wealth', icon: 'wallet-outline',   iconActive: 'wallet' },
  { key: 'wisdom', label: 'Wisdom', icon: 'book-outline',     iconActive: 'book' },
  { key: 'ask',    label: 'Ask',    icon: 'sparkles-outline', iconActive: 'sparkles' },
];

interface Props {
  active: TabKey;
  onChange: (key: TabKey) => void;
  bottomInset?: number;
  /** Recovery-band color for the ambient dot on the Health tab (null = hidden). */
  healthDot?: string | null;
}

function TabItem({
  t, on, onPress, c, dot,
}: {
  t: typeof TABS[number];
  on: boolean;
  onPress: () => void;
  c: ReturnType<typeof getColors>;
  dot?: string | null;
}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  useEffect(() => {
    if (on) {
      scale.value = withSpring(1.14, { damping: 7, stiffness: 320 }, () => {
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
        <Ionicons name={on ? t.iconActive : t.icon} size={21} color={on ? c.accent : c.subtext} />
        {/* Ambient state dot — today's recovery band, glanceable from any tab. */}
        {dot ? <View style={[styles.dot, { backgroundColor: dot, borderColor: c.card }]} /> : null}
      </Animated.View>
      <Text style={[styles.label, { color: on ? c.accent : c.subtext }, on && styles.labelOn]}>
        {t.label}
      </Text>
    </TouchableOpacity>
  );
}

export function TabBar({ active, onChange, bottomInset = 0, healthDot }: Props) {
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
          dot={t.key === 'health' ? healthDot : null}
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
    height: 32,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    position: 'absolute',
    top: 3,
    right: 9,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    borderWidth: 1.5,
  },
  icon: {
    fontSize: 18,
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
