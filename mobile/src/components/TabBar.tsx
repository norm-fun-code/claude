import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { getColors, spacing, radius, shadow } from '../theme';

export type TabKey = 'today' | 'health' | 'wealth' | 'wisdom' | 'insights';

export const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'today', label: 'Today', icon: '◎' },
  { key: 'health', label: 'Health', icon: '❤' },
  { key: 'wealth', label: 'Wealth', icon: '◆' },
  { key: 'wisdom', label: 'Wisdom', icon: '✦' },
  { key: 'insights', label: 'Insights', icon: '↗' },
];

interface Props {
  active: TabKey;
  onChange: (key: TabKey) => void;
}

// Floating bottom tab bar — Stripe blurple accent, Apple-soft elevation, with a
// pill that slides under the active tab.
export function TabBar({ active, onChange }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  return (
    <View style={[styles.wrap, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark, 'bar')]}>
      {TABS.map((t) => {
        const on = t.key === active;
        return (
          <TouchableOpacity
            key={t.key}
            style={styles.tab}
            activeOpacity={0.7}
            onPress={() => onChange(t.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
          >
            <View style={[styles.pill, on && { backgroundColor: c.accentSoft }]}>
              <Text style={[styles.icon, { color: on ? c.accent : c.subtext }]}>{t.icon}</Text>
            </View>
            <Text style={[styles.label, { color: on ? c.accent : c.subtext }, on && styles.labelOn]}>
              {t.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    borderTopWidth: 1,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
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
