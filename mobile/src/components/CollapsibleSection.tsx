import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, useColorScheme } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  FadeIn,
  Easing,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useReducedMotion } from '../lib/useReducedMotion';
import { getColors, spacing, radius, shadow } from '../theme';

interface Props {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function CollapsibleSection({ title, defaultOpen = false, children }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(defaultOpen);

  const rotate = useSharedValue(defaultOpen ? 180 : 0);
  const headerScale = useSharedValue(1);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotate.value}deg` }],
  }));

  const headerAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: headerScale.value }],
  }));

  const toggle = () => {
    const next = !open;
    setOpen(next);
    rotate.value = withTiming(next ? 180 : 0, { duration: reducedMotion ? 0 : 220, easing: Easing.out(Easing.cubic) });
    Haptics.selectionAsync();
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        onPressIn={() => { if (!reducedMotion) headerScale.value = withSpring(0.97, { damping: 15, stiffness: 400 }); }}
        onPressOut={() => { if (!reducedMotion) headerScale.value = withSpring(1, { damping: 15, stiffness: 400 }); }}
      >
        <Animated.View style={[styles.header, { backgroundColor: c.card }, shadow(isDark), headerAnimStyle]}>
          <Text style={[styles.title, { color: c.text }]}>{title}</Text>
          <Animated.View style={chevronStyle}>
            <Text style={[styles.chevron, { color: c.subtext }]}>▼</Text>
          </Animated.View>
        </Animated.View>
      </Pressable>
      {open && (
        <Animated.View entering={reducedMotion ? undefined : FadeIn.duration(200)} style={styles.body}>
          {children}
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 16,
    minHeight: 54,
    gap: 12,
  },
  title: { flex: 1, fontSize: 15, fontWeight: '600', letterSpacing: 0.2 },
  chevron: { fontSize: 11 },
  body: { marginTop: spacing.md },
});
