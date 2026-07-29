import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, typography, radius } from '../theme';
import { useThemePref } from '../theme-pref';
import { DEFAULT_CANONICAL_TZ, canonicalHour } from '../lib/canonicalDay';

interface Props {
  date: string;
  // Cross-day lifecycle hardening pass: the SAME canonical (home-base)
  // timezone `date` above was computed in — never the phone's own physical
  // timezone. Defaults to the same DEFAULT_CANONICAL_TZ useCanonicalDay
  // falls back to before any briefing payload has loaded, so the two can
  // never disagree even during that brief startup window.
  tz?: string;
}

function getGreeting(tz: string): string {
  const hour = canonicalHour(new Date(), tz);
  if (hour < 12) return 'Good morning, Norm';
  if (hour < 17) return 'Good afternoon, Norm';
  return 'Good evening, Norm';
}

const THEME_ICON = { system: '🌗', light: '☀️', dark: '🌙' } as const;
const THEME_LABEL = { system: 'Auto', light: 'Light', dark: 'Dark' } as const;

export function Header({ date, tz = DEFAULT_CANONICAL_TZ }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const { pref, cycle } = useThemePref();

  return (
    <View style={styles.container}>
      <View style={styles.textCol}>
        <Text style={[styles.greeting, { color: c.text }]}>{getGreeting(tz)}</Text>
        <Text style={[styles.date, { color: c.subtext }]}>{date}</Text>
      </View>
      <TouchableOpacity
        onPress={() => { Haptics.selectionAsync(); cycle(); }}
        style={[styles.themeBtn, { borderColor: c.border, backgroundColor: c.card }]}
        accessibilityLabel={`Theme: ${THEME_LABEL[pref]}. Tap to change.`}
        hitSlop={8}
      >
        <Text style={styles.themeIcon}>{THEME_ICON[pref]}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  textCol: { flex: 1 },
  greeting: {
    ...typography.title,
    fontSize: 28,
    marginBottom: spacing.xs,
  },
  date: {
    ...typography.body,
    fontSize: 15,
  },
  // Icon-only — a quiet 34px circle instead of a labeled pill, so a settings
  // control stops competing with the greeting for prime top-right real estate.
  themeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  themeIcon: { fontSize: 15 },
});
